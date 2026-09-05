'use strict';

// History backfill (Closes #81).
//
// The public page's price graph + model table read `state/history.json` (a
// dated array of per-model cost samples). That sample store was only being
// persisted from 2026-09-05 onward, so every pre-Sep-5 cost change — most
// notably the **hy3 8× jump on 2026-08-30** — exists only in the event log
// (`events-*.jsonl` / `changelog.json`) and is invisible on the timeline.
//
// This one-time, idempotent script reconstructs dated price points from every
// `cost-changed` event (each event yields TWO points: the OLD price at ts-1s and
// the NEW price at ts), merges them with the existing `history.json` samples,
// and applies the SAME 90-day / 500-entry cap as `appendPriceHistory` in
// `src/price-watch.js`.
//
// Idempotency: every emitted sample is deduplicated by an exact
// `(ts + models-json)` key, so re-running never doubles points.
//
// Optional `--seed`: best-effort fetch of a competitor public price history,
// fuzzy-mapped to OUR model ids, merged as `source:"seed"` samples. Never
// fails / never blocks if the fetch or mapping yields nothing.
//
// Writes ONLY into `state/` (gitignored). Never commits. A `.history-backfilled`
// marker records the last successful run.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const STATE_DIR = path.join(repoRoot, 'state');
const HISTORY_FILE = 'history.json';
const HISTORY_MAX_ENTRIES = 500;
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // prune samples older than 90d
const MARKER = '.history-backfilled';

// Public competitor history endpoints (best-effort, optional `--seed`).
const SEED_URLS = [
  'https://ocgo-pricing.all-the.rest/data/history.json',
  'https://raw.githubusercontent.com/all-the-rest/ocgo-price-tracker/main/data/history.json'
];

const COST_FIELDS = ['input', 'output', 'cache_read', 'cache_write'];

// --- Pure helpers (exported for tests) -------------------------------------

function normalizeCost(cost) {
  const out = {};
  if (cost && typeof cost === 'object') {
    for (const k of COST_FIELDS) {
      const v = cost[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

function costPoint(model, cost, tsISO) {
  return { ts: tsISO, models: { [model]: { cost: normalizeCost(cost), tiers: null } } };
}

// Reconstruct two dated points per `cost-changed` event: old @ (ts-1s), new @ ts.
function reconstructFromEvents(events) {
  const points = [];
  for (const e of events || []) {
    if (!e || e.type !== 'cost-changed') continue;
    const model = e.model;
    if (!model || !e.old || !e.new) continue;
    const baseTs = Date.parse(e.ts);
    if (isNaN(baseTs)) continue;
    const oldTs = new Date(baseTs - 1000).toISOString();
    points.push(costPoint(model, e.old, oldTs));
    points.push(costPoint(model, e.new, e.ts));
  }
  return points;
}

// Parse a `changelog.json` `model_change` message:
//   "Cost changed for <id>: <old-json> -> <new-json>"
function parseChangelogCost(message) {
  if (typeof message !== 'string') return null;
  const m = /^Cost changed for (\S+):\s*/.exec(message);
  if (!m) return null;
  const id = m[1];
  const rest = message.slice(m[0].length);
  const idx = rest.indexOf(' -> ');
  if (idx < 0) return null;
  const oldStr = rest.slice(0, idx).trim();
  const newStr = rest.slice(idx + 4).trim();
  let oldJ;
  let newJ;
  try {
    oldJ = JSON.parse(oldStr);
    newJ = JSON.parse(newStr);
  } catch (_) {
    return null;
  }
  if (!oldJ || !newJ || typeof oldJ !== 'object' || typeof newJ !== 'object') return null;
  return { model: id, old: oldJ, new: newJ };
}

// Reconstruct cost-changed points from `changelog.json` `model_change` entries.
function reconstructFromChangelog(changelog) {
  const points = [];
  if (!Array.isArray(changelog)) return points;
  for (const e of changelog) {
    if (!e || e.level !== 'model_change' || !e.message) continue;
    const parsed = parseChangelogCost(e.message);
    if (!parsed || !e.ts) continue;
    const baseTs = Date.parse(e.ts);
    if (isNaN(baseTs)) continue;
    const oldTs = new Date(baseTs - 1000).toISOString();
    points.push(costPoint(parsed.model, parsed.old, oldTs));
    points.push(costPoint(parsed.model, parsed.new, e.ts));
  }
  return points;
}

function sampleKey(s) {
  return String(s.ts) + '|' + JSON.stringify(s.models);
}

// Exact-sample dedupe (idempotency + no duplicate merge).
function dedupSamples(samples) {
  const seen = new Set();
  const out = [];
  for (const s of samples || []) {
    const k = sampleKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// Apply the 90d age prune + 500-entry cap (mirrors appendPriceHistory).
// Sorts ascending first so the cap always retains the NEWEST samples regardless
// of the input order.
function applyCap(arr, now) {
  const t = now != null ? now : Date.now();
  let out = (arr || []).slice();
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const cutoff = t - HISTORY_MAX_AGE_MS;
  out = out.filter((s) => (s && s.ts ? Date.parse(s.ts) : 0) >= cutoff);
  if (out.length > HISTORY_MAX_ENTRIES) {
    out = out.slice(out.length - HISTORY_MAX_ENTRIES);
  }
  return out;
}

// Merge existing history with backfilled/seed points: dedup, sort, cap.
function mergeHistory(existing, additions, opts) {
  opts = opts || {};
  const merged = dedupSamples([...(existing || []), ...(additions || [])]);
  merged.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return applyCap(merged, opts.now);
}

// --- Seed (optional, best-effort) ------------------------------------------

function normId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Fuzzy-map an external model id to one of our known ids; null if no match.
function fuzzyMatchId(extId, knownIds) {
  const e = normId(extId);
  if (!e) return null;
  for (const k of knownIds) if (normId(k) === e) return k;
  for (const k of knownIds) {
    const n = normId(k);
    if (n && (n.includes(e) || e.includes(n))) return k;
  }
  return null;
}

// Map an external competitor history payload into OUR sample shape.
// Best-effort: unknown shapes / unmatched ids are skipped (logged, never throw).
function mapSeedData(data, knownIds) {
  const out = [];
  const arr = Array.isArray(data)
    ? data
    : data && Array.isArray(data.history)
      ? data.history
      : null;
  if (!arr) return out;
  for (const s of arr) {
    const ts = s && (s.ts || s.date || s.timestamp);
    if (!ts) continue;
    const modelsSrc = (s && (s.models || s.prices || s.data)) || null;
    if (!modelsSrc || typeof modelsSrc !== 'object') continue;
    for (const id of Object.keys(modelsSrc)) {
      if (id === 'ts' || id === 'date' || id === 'timestamp') continue;
      const mapped = fuzzyMatchId(id, knownIds);
      if (!mapped) {
        console.warn(`[seed] unmatched model id: ${id}`);
        continue;
      }
      const cost = normalizeCost(modelsSrc[id]);
      if (!Object.keys(cost).length) continue;
      out.push({ ts: new Date(ts).toISOString(), models: { [mapped]: { cost, tiers: null } }, source: 'seed' });
    }
  }
  return out;
}

async function fetchSeedHistory(urls, knownIds) {
  const seed = [];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[seed] ${url} -> HTTP ${res.status}; skipping`);
        continue;
      }
      const data = await res.json();
      const mapped = mapSeedData(data, knownIds);
      console.warn(`[seed] ${url} -> ${mapped.length} mapped sample(s)`);
      seed.push(...mapped);
    } catch (err) {
      console.warn(`[seed] fetch failed for ${url}: ${err && err.message ? err.message : err}`);
    }
  }
  return seed;
}

// --- Filesystem IO ----------------------------------------------------------

function readJsonSafe(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch (_) {
    return undefined;
  }
}

function readHistory(dir) {
  const h = readJsonSafe(dir, HISTORY_FILE);
  return Array.isArray(h) ? h : [];
}

function writeHistoryAtomic(dir, arr) {
  const target = path.join(dir, HISTORY_FILE);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, target);
}

function collectCostChangedEvents(dir) {
  const events = [];
  // Primary source: structured events-*.jsonl (clean old/new).
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^events-.*\.jsonl$/.test(f));
  } catch (_) {
    files = [];
  }
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch (_) {
        /* skip malformed line */
      }
    }
  }
  // Secondary source: changelog.json `model_change` entries (defensive coverage
  // for any cost change not present in the structured events jsonl). Converted
  // directly to proper {old,new} events so the unified pipeline stays correct.
  const cl = readJsonSafe(dir, 'changelog.json');
  if (Array.isArray(cl)) {
    for (const e of cl) {
      if (!e || e.level !== 'model_change' || !e.message || !e.ts) continue;
      const parsed = parseChangelogCost(e.message);
      if (!parsed) continue;
      events.push({
        type: 'cost-changed',
        model: parsed.model,
        old: parsed.old,
        new: parsed.new,
        ts: e.ts,
        _from: 'changelog'
      });
    }
  }
  return events;
}

function collectKnownIds(dir, history) {
  const ids = new Set();
  for (const s of history || []) {
    if (s && s.models) for (const id of Object.keys(s.models)) ids.add(id);
  }
  const snap = readJsonSafe(dir, 'pricing-snapshot.json');
  if (snap && typeof snap === 'object') for (const id of Object.keys(snap)) ids.add(id);
  return [...ids];
}

// --- Main -------------------------------------------------------------------

async function run(opts) {
  opts = opts || {};
  const dir = opts.stateDir || STATE_DIR;
  const now = opts.now != null ? opts.now : Date.now();

  const existing = readHistory(dir);
  const events = collectCostChangedEvents(dir);
  const backfilled = dedupSamples(reconstructFromEvents(events));

  let merged = mergeHistory(existing, backfilled, { now });

  if (opts.seed) {
    const knownIds = collectKnownIds(dir, existing);
    const seed = await fetchSeedHistory(SEED_URLS, knownIds);
    const seedPoints = dedupSamples(seed);
    merged = mergeHistory(merged, seedPoints, { now });
  }

  if (!opts.dryRun) {
    writeHistoryAtomic(dir, merged);
    fs.writeFileSync(path.join(dir, MARKER), new Date().toISOString());
  }

  const tsAll = merged.map((s) => Date.parse(s.ts)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  const span = tsAll.length
    ? `${new Date(tsAll[0]).toISOString()} .. ${new Date(tsAll[tsAll.length - 1]).toISOString()}`
    : 'empty';

  return {
    existingCount: existing.length,
    backfilledCount: backfilled.length,
    total: merged.length,
    span,
    merged
  };
}

async function main() {
  const args = process.argv.slice(2);
  const stateDir = args.includes('--state') ? args[args.indexOf('--state') + 1] : STATE_DIR;
  const seed = args.includes('--seed');
  const dryRun = args.includes('--dry-run');
  const res = await run({ stateDir, seed, dryRun });
  console.log(
    `history backfill: existing=${res.existingCount} backfilled=${res.backfilledCount} ` +
      `total=${res.total}\n  span: ${res.span}` +
      (seed ? '\n  (seed: enabled)' : '') +
      (dryRun ? '\n  (dry-run: no files written)' : '')
  );
}

module.exports = {
  COST_FIELDS,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_AGE_MS,
  normalizeCost,
  costPoint,
  reconstructFromEvents,
  parseChangelogCost,
  reconstructFromChangelog,
  sampleKey,
  dedupSamples,
  applyCap,
  mergeHistory,
  fuzzyMatchId,
  mapSeedData,
  fetchSeedHistory,
  readHistory,
  writeHistoryAtomic,
  collectCostChangedEvents,
  SEED_URLS,
  run
};

if (require.main === module) {
  main().catch((err) => {
    console.error('backfill failed:', err);
    process.exit(1);
  });
}
