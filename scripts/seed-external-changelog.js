'use strict';

// v0.11.0: ingest the external ocgo-price-tracker changelog into the event-sourced
// history (state/events-*.jsonl) + price-history (state/history.json), and pin the
// per-model usage caps in src/usage-table.json with source/date provenance.
//
// WHY: the live monitor only captures billable cost/tiers diffs as the catalog
// changes; it never learned the rich external history — free-model add/remove
// cycles, usage-cap moves ($480->$60 etc.), privacy/ZDR training-status changes,
// and info milestones. The external tracker recorded 20+ such events between
// 2026-08-20 and 2026-09-05 that were simply absent from our timeline. This
// script reconstructs that truth deterministically.
//
// Idempotency: guarded by a `.external-seed-v1` marker (set of written event
// signatures) so re-running never re-appends. It ALSO de-dupes against events
// the live monitor may have already written for the same (type, model) — so we
// never end up with two "added" lines for e.g. omen-alpha. History points are
// merged via the same exact-sample dedup used by scripts/backfill-history.js.
//
// Scope: writes ONLY into state/ (gitignored) at run time, plus src/usage-table.json
// (the caps are a committed source of truth — see the v0.10.0 seed). The script
// itself is committed; the marker + events + history are live-only.
//
// Privacy: all data hardcoded below is public pricing/tracker metadata. No
// secrets, webhooks, tokens, or personal paths are ever emitted (verified by the
// page-safe test). The public docs/ allowlist is respected — only model ids,
// costs, caps, and policy-status text leave this script.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const STATE_DIR = path.join(repoRoot, 'state');
const TABLE_PATH = path.join(repoRoot, 'src', 'usage-table.json');
const MARKER = '.external-seed-v1';

// Reuse the battle-tested history merge/dedup from the backfill script so the
// price graph gains the same exact-sample idempotency.
const backfill = require('./backfill-history');
const events = require('../src/events');

// Source of the external tracker (public pricing/tracker feed).
const SOURCE = 'ocgo-price-tracker';

// --- Hardcoded external changelog (CEST dates converted to UTC = CEST - 2h) ----
//
// Costs are encoded as {input, output, cache_read[, cache_write]} and the trailing
// "@ $N" is the monthly usage cap. Free-model entries carry availableFrom (when it
// first appeared) and/or duration (how long it lasted, from the tracker note).
// Redundant tracker re-logs (e.g. Ox Alpha Free listed twice on 08-26) are folded
// into a single representative event so the timeline stays clean.
const EVENTS = [
  // 2026-08-20 — Muse Spark 1.2 Contributor (billable + free) debut.
  { ts: '2026-08-20T05:08:00.000Z', type: 'free-available', model: 'muse-spark-1.2-contributor-free', new: null, availableFrom: '2026-08-20T05:08:00.000Z' },
  { ts: '2026-08-20T05:08:00.000Z', type: 'added', model: 'muse-spark-1.2-contributor', new: { input: 0.1, output: 0.2, cache_read: 0.002 }, usageCap: 60 },

  // 2026-08-20 — Ox Alpha Free appears (tracker logs it again 08-21 as "$0 ×4 @ ∞").
  { ts: '2026-08-20T18:01:00.000Z', type: 'free-available', model: 'ox-alpha-free', new: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, availableFrom: '2026-08-20T18:01:00.000Z', note: '$0 ×4 @ ∞' },

  // 2026-08-21 — DeepSeek V4 Flash Free removed (16d); Vision Exp + Vision Exp Peak debut.
  { ts: '2026-08-21T13:39:00.000Z', type: 'free-removed', model: 'deepseek-v4-flash-free', old: null, duration: '16 days', availableFrom: null },
  { ts: '2026-08-21T13:39:00.000Z', type: 'added', model: 'deepseek-v4-flash-vision-exp', new: { input: 0.44, output: 1.32, cache_read: 0.014 }, usageCap: 15 },
  { ts: '2026-08-21T13:39:00.000Z', type: 'added', model: 'deepseek-v4-flash-vision', new: { input: 0.22, output: 0.66, cache_read: 0.007 }, usageCap: 15 },

  // 2026-08-22 — info: DeepSeek peak/off-peak pricing rules effective Aug 23.
  { ts: '2026-08-22T00:00:00.000Z', type: 'info', model: 'deepseek-v4-flash', new: null, note: 'DeepSeek peak rules effective Aug 23 (peak 01-04+06-10 UTC, 2× off-peak, weekends off-peak)' },

  // 2026-08-24 — LongCat-2.0 debut; info: $5-first-month promo ended, $10/mo baseline.
  { ts: '2026-08-24T12:02:00.000Z', type: 'added', model: 'longcat-2.0', new: { input: 0.3, output: 1.2, cache_read: 0.006 }, usageCap: 60 },
  { ts: '2026-08-24T16:50:00.000Z', type: 'info', model: null, new: null, note: '$5-first-month ended, Go $10/mo across board' },

  // 2026-08-25 — Grok 4.5 retired (20d available); Grok 4.6 arrives in two context tiers.
  { ts: '2026-08-25T18:03:00.000Z', type: 'removed', model: 'grok-4.5', old: { input: 2, output: 6, cache_read: 0.3 }, duration: '20 days' },
  { ts: '2026-08-25T18:03:00.000Z', type: 'added', model: 'grok-4.6', new: { input: 2, output: 6, cache_read: 0.5 }, usageCap: 15 },
  { ts: '2026-08-25T18:03:00.000Z', type: 'added', model: 'grok-4.6-large', new: { input: 4, output: 12, cache_read: 1 }, usageCap: 15 },

  // 2026-08-26 — Ox Alpha Free removed (5d available); GLM-5.3-Flash debut.
  { ts: '2026-08-26T14:05:00.000Z', type: 'free-removed', model: 'ox-alpha-free', old: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, duration: '5 days', availableFrom: '2026-08-20T18:01:00.000Z' },
  { ts: '2026-08-26T14:05:00.000Z', type: 'added', model: 'glm-5.3-flash', new: { input: 0.15, output: 0.5, cache_read: 0.03 }, usageCap: 30 },

  // 2026-08-28 — Laguna S 2.1 Free removed (23d); Qwen3.8 Flash debut; Ling 3.0 Flash Fin Free + Hy4 preview debut.
  { ts: '2026-08-28T00:00:00.000Z', type: 'free-removed', model: 'laguna-s-2.1-free', old: null, duration: '23 days', availableFrom: '2026-08-05' },
  { ts: '2026-08-28T06:02:00.000Z', type: 'added', model: 'qwen3.8-flash', new: { input: 0.15, output: 0.47, cache_read: 0.016, cache_write: 0.2 }, usageCap: 30 },
  { ts: '2026-08-28T15:41:00.000Z', type: 'free-available', model: 'ling-3.0-flash-fin-free', new: null, availableFrom: '2026-08-28T15:41:00.000Z' },
  { ts: '2026-08-28T15:41:00.000Z', type: 'added', model: 'hy4-preview', new: { input: 0.834, output: 2.5, cache_read: 0.042 }, usageCap: 30 },

  // 2026-08-30 — Hy3 usage cap moved $480 -> $60; Hy3 Free removed (19d).
  { ts: '2026-08-30T04:09:00.000Z', type: 'usage-moved', model: 'hy3', old: 480, new: 60 },
  { ts: '2026-08-30T12:08:00.000Z', type: 'free-removed', model: 'hy3-free', old: null, duration: '19 days', availableFrom: '2026-08-11' },

  // 2026-09-01 — DeepSeek V4 Flash privacy: ZDR-valid-until-Aug31 -> Training·ZDR-not-renewed; Qwen3.7 Max usage $60 -> $30.
  { ts: '2026-09-01T08:05:00.000Z', type: 'privacy-changed', model: 'deepseek-v4-flash', old: { zdrValidUntil: '2026-08-31' }, new: { training: 'ZDR-not-renewed' } },
  { ts: '2026-09-01T08:05:00.000Z', type: 'usage-moved', model: 'qwen3.7-max', old: 60, new: 30 },

  // 2026-09-02 — Muse Spark 1.3 Free + Contributor debut.
  { ts: '2026-09-02T17:24:00.000Z', type: 'free-available', model: 'muse-spark-1.3-free', new: null, availableFrom: '2026-09-02T17:24:00.000Z' },
  { ts: '2026-09-02T17:24:00.000Z', type: 'added', model: 'muse-spark-1.3-contributor', new: { input: 0.1, output: 0.2, cache_read: 0.002 }, usageCap: 60 },

  // 2026-09-04 — Omen Alpha debut; DeepSeek V4 Flash privacy: Training·ZDR-not-renewed -> ZDR valid-until Sep 30 2026.
  { ts: '2026-09-04T06:06:00.000Z', type: 'added', model: 'omen-alpha', new: { input: 0.2, output: 0.66, cache_read: 0.04 }, usageCap: 100 },
  { ts: '2026-09-04T14:07:00.000Z', type: 'privacy-changed', model: 'deepseek-v4-flash', old: { training: 'ZDR-not-renewed' }, new: { zdrValidUntil: '2026-09-30' } },

  // 2026-09-05 — Muse Spark 1.2 Free removed (16d since 08-20).
  { ts: '2026-09-05T04:05:00.000Z', type: 'free-removed', model: 'muse-spark-1.2-free', old: null, duration: '16 days', availableFrom: '2026-08-20' }
];

// Per-model usage caps established by the external tracker, with the date the
// tracker recorded the cap. These are merged into src/usage-table.json with
// provenance so the effective-price math + leaderboard reflect the real caps.
const CAPS = {
  'omen-alpha': { cap: 100, date: '2026-09-04' },
  'qwen3.7-max': { cap: 30, date: '2026-09-01' },
  'hy3': { cap: 60, date: '2026-08-30' },
  'hy4-preview': { cap: 30, date: '2026-08-28' },
  'qwen3.8-flash': { cap: 30, date: '2026-08-28' },
  'glm-5.3-flash': { cap: 30, date: '2026-08-26' },
  'grok-4.6': { cap: 15, date: '2026-08-25' },
  'grok-4.6-large': { cap: 15, date: '2026-08-25' },
  'longcat-2.0': { cap: 60, date: '2026-08-24' },
  'deepseek-v4-flash-vision-exp': { cap: 15, date: '2026-08-21' },
  'deepseek-v4-flash-vision': { cap: 15, date: '2026-08-21' },
  'muse-spark-1.3-contributor': { cap: 60, date: '2026-09-02' },
  'muse-spark-1.2-contributor': { cap: 60, date: '2026-08-20' }
};

// Event types that should be de-duped against the live monitor's existing events
// by (type, model): at most one add / remove / free-available / free-removed /
// usage-moved per model. Privacy + info legitimately recur, so they use a
// finer (type, model, ts-hour) signature instead.
const LIVE_DEDUP_TYPES = new Set(['added', 'removed', 'free-available', 'free-removed', 'usage-moved']);

function sigOf(ev) {
  // Exact signature; includes ts so recurring privacy/info events stay distinct.
  return [ev.type, ev.model == null ? '' : String(ev.model), ev.ts].join('|');
}

function typeModelKey(ev) {
  return (ev.type || '') + '|' + (ev.model == null ? '' : String(ev.model));
}

// --- Pure helpers (exported for tests) ------------------------------------

function buildExternalEvents() {
  // Return a deep copy so callers can't mutate the canonical dataset.
  return EVENTS.map((e) => Object.assign({}, e));
}

function buildCaps() {
  const out = {};
  for (const id of Object.keys(CAPS)) out[id] = Object.assign({ source: SOURCE }, CAPS[id]);
  return out;
}

// Merge the external caps + provenance into a usage-table document (does not
// touch disk). Returns { table, changed } where changed is true when anything
// was added/updated (so the caller can decide whether to rewrite the file).
function applyCaps(table) {
  table = table && typeof table === 'object' ? table : {};
  table._meta = table._meta && typeof table._meta === 'object' ? table._meta : {};
  table.models = table.models && typeof table.models === 'object' ? table.models : {};
  const provenance = table._meta.capsProvenance && typeof table._meta.capsProvenance === 'object'
    ? table._meta.capsProvenance
    : {};
  let changed = false;
  for (const id of Object.keys(CAPS)) {
    const { cap, date } = CAPS[id];
    if (table.models[id] !== cap) {
      table.models[id] = cap;
      changed = true;
    }
    const prev = provenance[id] || {};
    if (prev.cap !== cap || prev.date !== date || prev.source !== SOURCE) {
      provenance[id] = { cap, date, source: SOURCE };
      changed = true;
    }
  }
  table._meta.capsProvenance = provenance;
  return { table, changed };
}

// --- Marker (rerun idempotency) --------------------------------------------

function loadMarker(stateDir) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, MARKER), 'utf8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) {
    return new Set();
  }
}

function saveMarker(stateDir, set) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, MARKER), JSON.stringify([...set]));
  } catch (_) {
    // best effort
  }
}

// History points for every `added` event carrying a cost (cost at the event ts).
function historyPointsForAdds(eventsArr) {
  const pts = [];
  for (const e of eventsArr) {
    if (e.type === 'added' && e.new && typeof e.new === 'object') {
      pts.push(backfill.costPoint(e.model, e.new, e.ts));
    }
  }
  return pts;
}

// --- Main -------------------------------------------------------------------

async function run(opts) {
  opts = opts || {};
  const stateDir = opts.stateDir || STATE_DIR;
  const tablePath = opts.usageTablePath || TABLE_PATH;
  const dryRun = !!opts.dryRun;
  const now = opts.now != null ? opts.now : Date.now();

  const external = buildExternalEvents();
  const existing = events.readEvents(stateDir);
  const seen = new Set(existing.map(typeModelKey));
  const marker = loadMarker(stateDir);

  const written = [];
  for (const ev of external) {
    const sig = sigOf(ev);
    if (marker.has(sig)) continue; // rerun idempotent
    if (LIVE_DEDUP_TYPES.has(ev.type) && seen.has(typeModelKey(ev))) continue; // already tracked live
    if (!dryRun) events.appendEvent(stateDir, ev);
    written.push(ev);
    marker.add(sig);
    if (LIVE_DEDUP_TYPES.has(ev.type)) seen.add(typeModelKey(ev));
  }

  if (!dryRun) saveMarker(stateDir, marker);

  // Backfill price-history points for every add (cost at the event ts).
  const existingHist = backfill.readHistory(stateDir);
  const points = historyPointsForAdds(external);
  const mergedHist = backfill.mergeHistory(existingHist, points, { now });
  if (!dryRun) backfill.writeHistoryAtomic(stateDir, mergedHist);

  // Pin the usage caps (with provenance) in the committed table.
  let tableChanged = false;
  let table;
  try {
    table = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
  } catch (_) {
    table = null;
  }
  const res = applyCaps(table);
  if (res.changed && !dryRun) {
    fs.writeFileSync(tablePath, JSON.stringify(res.table, null, 2) + '\n');
    tableChanged = true;
  }

  // Validate there are no secret-like keys anywhere in the emitted events
  // (page-safety guard, fails closed by logging a warning, never throws).
  const forbidden = /auth\.json|config\.json|subscribers\.json|webhook|secret|password|token|gho_|ghp_|api_?key|bearer |bearer-|[\/\\](Users|home|root)[\/\\]/i;
  for (const ev of written) {
    if (forbidden.test(JSON.stringify(ev))) {
      console.warn('[seed] page-safety: forbidden substring in event ' + ev.type + ':' + ev.model);
    }
  }

  const all = events.readEvents(stateDir);
  const tsAll = all.map((e) => Date.parse(e.ts)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  const span = tsAll.length
    ? `${new Date(tsAll[0]).toISOString()} .. ${new Date(tsAll[tsAll.length - 1]).toISOString()}`
    : 'empty';

  return {
    externalCount: external.length,
    writtenCount: written.length,
    skippedLiveDup: external.length - written.length,
    totalEvents: all.length,
    historyPointsAdded: points.length,
    tableChanged,
    span,
    written
  };
}

async function main() {
  const args = process.argv.slice(2);
  const stateDir = args.includes('--state') ? args[args.indexOf('--state') + 1] : STATE_DIR;
  const tablePath = args.includes('--table') ? args[args.indexOf('--table') + 1] : TABLE_PATH;
  const dryRun = args.includes('--dry-run');
  const res = await run({ stateDir, usageTablePath: tablePath, dryRun });
  console.log(
    `external seed: external=${res.externalCount} written=${res.writtenCount} ` +
      `skippedLiveDup=${res.skippedLiveDup} totalEvents=${res.totalEvents} ` +
      `historyPoints=${res.historyPointsAdded} tableChanged=${res.tableChanged}\n` +
      `  span: ${res.span}` +
      (dryRun ? '\n  (dry-run: no files written)' : '')
  );
}

module.exports = {
  EVENTS,
  CAPS,
  SOURCE,
  LIVE_DEDUP_TYPES,
  buildExternalEvents,
  buildCaps,
  applyCaps,
  sigOf,
  typeModelKey,
  historyPointsForAdds,
  MARKER,
  run
};

if (require.main === module) {
  main().catch((e) => {
    console.error('external seed failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
