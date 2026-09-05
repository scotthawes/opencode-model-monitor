'use strict';

// Local read-only calculator CLI (P1-1, Closes #50).
//
// Answers: "given a representative request mix, what does this model effectively
// cost per request, and how many requests/month fit under the $60 opencode-go
// credit?" It is READ-ONLY — it fetches the public catalog (GET) and never writes
// state, never delivers alerts, never touches subscribers.
//
// --- Token pattern (ESTIMATE) -------------------------------------------------
// A representative agent request is modeled as a fixed token mix. The default
// basis { input: 390, cachedRead: 32500, output: 120 } is an ESTIMATE derived
// from prior analysis of a typical opencode-go agent turn (a small fresh prompt,
// a large cache read of the accumulated context, and a modest completion). Tune
// it per workload with `--pattern in,cachedRead,out`.
//
// --- Cost-per-request formula (ASSUMPTION, documented) -----------------------
// opencode-go prices prompt tokens as a split of fresh input and cache-write:
// we assume 5% of the input tokens are billed at the list `input` rate and 95%
// are billed at the `cache_write` rate, mirroring observed competitor billing
// where a repeated prompt is mostly a cache write. Cache reads use `cache_read`;
// output uses `output`. If a model has no `cache_write` price, the whole prompt
// degrades to the list `input` rate (no cache premium). All rates are USD / 1M
// tokens from the live api.json `cost` object.
//
//   costPerRequest = input/1M*(inTok*0.05) + cache_write/1M*(inTok*0.95)
//                  + cache_read/1M*cachedReadTok + output/1M*outTok
//
// --- Effective price & requests/month ----------------------------------------
// Effective price = list price x (MONTHLY_CREDIT / usageCap) per src/usage-table.
// The effective cost/request scales by the same multiplier, so:
//
//   effectiveCostPerRequest = costPerRequest x (60 / usageCap)
//   requestsPerMonth        = MONTHLY_CREDIT / effectiveCostPerRequest
//
// (usageCap defaults to 60 -> 1x for models absent from usage-table.json.)

const usageTable = require('./usage-table');

const API_URL = 'https://models.opencode.ai/api.json';

// Default request token mix — documented estimate, override via --pattern.
const DEFAULT_PATTERN = { input: 390, cachedRead: 32500, output: 120 };

// Share of prompt tokens billed as cache-write (the rest at list `input`).
const CACHE_WRITE_SPLIT = 0.95;

// Silent logger — calc is read-only and ranks the whole catalog, so we suppress
// usage-table's per-model "cap unknown" console warnings (those are meant for the
// long-running monitor, not a one-shot calculator).
const SILENT_LOG = () => {};

// --- Pure helpers (unit-testable, no I/O) ------------------------------------

// Normalize an api.json `cost` object into numeric USD-per-1M metrics. Missing /
// non-numeric metrics become null so callers can degrade gracefully.
function normalizeCost(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const out = {};
  for (const k of ['input', 'output', 'cache_read', 'cache_write']) {
    const n = Number(cost[k]);
    out[k] = isFinite(n) ? n : null;
  }
  return out;
}

// Cost per request (USD) for a cost object + token pattern. Returns a finite
// number, or null when the cost object is unusable.
function costPerRequest(cost, pattern) {
  const c = normalizeCost(cost);
  if (!c) return null;
  const p = pattern || DEFAULT_PATTERN;
  const inTok = Number(p.input) || 0;
  const cachedTok = Number(p.cachedRead) || 0;
  const outTok = Number(p.output) || 0;

  let total = 0;

  if (c.cache_write != null) {
    // 5% fresh input at list rate + 95% cache-write at cache_write rate.
    total += (c.input || 0) * (inTok * (1 - CACHE_WRITE_SPLIT)) / 1e6;
    total += c.cache_write * (inTok * CACHE_WRITE_SPLIT) / 1e6;
  } else {
    // No cache-write price: whole prompt at list input rate.
    total += (c.input || 0) * inTok / 1e6;
  }
  total += (c.cache_read || 0) * cachedTok / 1e6;
  total += (c.output || 0) * outTok / 1e6;

  return total;
}

// Effective cost per request (USD) = raw cost/request x (60 / usageCap).
function effectiveCostPerRequest(cost, modelId, pattern) {
  const raw = costPerRequest(cost, pattern);
  if (raw == null) return null;
  const mult = usageTable.effectiveMultiplier(modelId, SILENT_LOG);
  if (mult == null) return null;
  return raw * mult;
}

// Requests/month that fit under the $60 credit at the effective cost/request.
function requestsPerMonth(effectiveCost) {
  if (effectiveCost == null || effectiveCost <= 0) return Infinity;
  return usageTable.MONTHLY_CREDIT / effectiveCost;
}

// Fuzzy-match a model id within the catalog. Resolution order:
//   1. exact match, 2. case-insensitive, 3. substring overlap, 4. token overlap.
// Returns the canonical id or null when nothing plausible matches.
function findModel(models, query) {
  if (!query) return null;
  const ids = Object.keys(models || {});
  if (ids.length === 0) return null;
  const q = String(query).trim();
  if (!q) return null;

  if (ids.includes(q)) return q;
  const ql = q.toLowerCase();

  for (const id of ids) if (id.toLowerCase() === ql) return id;

  const sub = [];
  for (const id of ids) {
    const il = id.toLowerCase();
    if (il.includes(ql)) sub.push({ id, score: ql.length / il.length });
    else if (ql.includes(il)) sub.push({ id, score: (il.length / ql.length) * 0.9 });
  }
  if (sub.length) {
    sub.sort((a, b) => b.score - a.score);
    return sub[0].id;
  }

  const qToks = ql.split(/[-_.]+/).filter(Boolean);
  if (qToks.length) {
    let best = null;
    let bestScore = 0;
    for (const id of ids) {
      const toks = id.toLowerCase().split(/[-_.]+/).filter(Boolean);
      const overlap = qToks.filter((t) =>
        toks.some((tt) => tt.includes(t) || t.includes(tt))
      ).length;
      const score = overlap / qToks.length;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (best && bestScore >= 0.5) return best;
  }

  return null;
}

// Rank every model by effective cost/request (ascending) for a token pattern.
// Returns an array of { id, raw, multiplier, effective, requestsPerMo } for
// models with a computable cost; sorted cheapest-effective first.
function rankByEffective(models, pattern, limit) {
  const rows = [];
  for (const id of Object.keys(models || {})) {
    const cost = (models[id] || {}).cost;
    const raw = costPerRequest(cost, pattern);
    if (raw == null || !isFinite(raw) || raw <= 0) continue;
    const mult = usageTable.effectiveMultiplier(id, SILENT_LOG);
    if (mult == null) continue;
    const effective = raw * mult;
    rows.push({
      id,
      raw,
      multiplier: mult,
      effective,
      requestsPerMo: requestsPerMonth(effective)
    });
  }
  rows.sort((a, b) => a.effective - b.effective);
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}

// --- Catalog fetch (read-only GET) ------------------------------------------

// Fetch the public opencode-go catalog and return a models map keyed by id:
//   { [id]: { cost, tiers, meta } }
// Returns {} on any failure (caller decides how to surface). Never throws.
async function fetchModelsMap() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) return {};
    const data = await res.json();
    const modelsRaw = (data && data['opencode-go'] && data['opencode-go'].models) || {};
    const map = {};
    for (const id of Object.keys(modelsRaw)) {
      const m = modelsRaw[id] || {};
      map[id] = { cost: m.cost || null, tiers: m.tiers || null, meta: m.meta || null };
    }
    return map;
  } catch (_) {
    return {};
  }
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { model: null, pattern: null, rawArgs: argv };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pattern' || a === '-p') {
      const v = argv[i + 1];
      if (v == null) throw new Error('--pattern requires 3 comma-separated numbers');
      const parts = v.split(',').map((s) => Number(s.trim()));
      if (parts.length !== 3 || parts.some((n) => !isFinite(n))) {
        throw new Error('--pattern expects in,cachedRead,out (3 numbers)');
      }
      args.pattern = { input: parts[0], cachedRead: parts[1], output: parts[2] };
      i++;
    } else if (a.startsWith('--pattern=')) {
      const v = a.slice('--pattern='.length);
      const parts = v.split(',').map((s) => Number(s.trim()));
      if (parts.length !== 3 || parts.some((n) => !isFinite(n))) {
        throw new Error('--pattern expects in,cachedRead,out (3 numbers)');
      }
      args.pattern = { input: parts[0], cachedRead: parts[1], output: parts[2] };
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
  args.model = positional[0] || null;
  return args;
}

function fmtUsd(n) {
  if (n == null) return 'n/a';
  if (!isFinite(n)) return '∞';
  if (n !== 0 && n < 0.0001) return '$' + n.toExponential(2);
  return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + (n >= 0.01 ? '' : '');
}

function fmtInt(n) {
  if (!isFinite(n)) return '∞';
  return Math.floor(n).toLocaleString('en-US');
}

function render(modelId, models, pattern) {
  const model = models[modelId];
  if (!model) throw new Error('model not found: ' + modelId);
  const cost = model.cost;
  const raw = costPerRequest(cost, pattern);
  const mult = usageTable.effectiveMultiplier(modelId, SILENT_LOG);
  const effective = raw == null ? null : raw * mult;
  const reqMo = effective == null ? null : requestsPerMonth(effective);
  const cap = usageTable.getUsageCap(modelId, SILENT_LOG);
  const provider = model.meta && model.meta.provider ? model.meta.provider : null;

  const lines = [];
  lines.push('');
  lines.push(`Model: ${modelId}${provider ? '  (provider: ' + provider + ')' : ''}`);
  lines.push('Token pattern (estimate): ' +
    `input=${pattern.input}, cachedRead=${pattern.cachedRead}, output=${pattern.output}`);
  lines.push('─'.repeat(60));
  lines.push(`List cost / request      : ${fmtUsd(raw)}`);
  lines.push(`Usage cap / multiplier    : $${cap} cap  ->  ${mult}x effective`);
  lines.push(`Effective cost / request  : ${fmtUsd(effective)}`);
  lines.push(`Requests / month (≈$60)   : ${fmtInt(reqMo)}`);
  lines.push('─'.repeat(60));
  lines.push('Assumptions: 5%/95% input-vs-cache-write split; effective = 60/usageCap;');
  lines.push('pattern is an estimate — tune with --pattern in,cached,out. Read-only.');
  lines.push('');

  // Top-5 cheapest-effective across the whole catalog.
  const ranked = rankByEffective(models, pattern, 5);
  lines.push('Top 5 cheapest (effective) models:');
  lines.push('  #  model'.padEnd(42) + 'eff $/req'.padStart(12) + 'req/mo'.padStart(12));
  ranked.forEach((r, i) => {
    const name = (i + 1) + '. ' + r.id;
    lines.push('  ' + name.padEnd(40) + fmtUsd(r.effective).padStart(12) + fmtInt(r.requestsPerMo).padStart(12));
  });
  lines.push('');
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(2);
  }

  if (args.help || !args.model) {
    console.log(
      'Usage: node src/calc.js <model> [--pattern in,cached,out]\n' +
        '  <model>   fuzzy-matched model id (e.g. qwen3.7-max)\n' +
        '  --pattern comma list of input,cachedRead,output token counts\n' +
        'Example: node src/calc.js qwen3.7-max --pattern 100,5000,50\n' +
        'Read-only calculator — fetches the public catalog, writes nothing.'
    );
    process.exit(args.help ? 0 : 2);
  }

  const pattern = args.pattern || DEFAULT_PATTERN;
  const models = await fetchModelsMap();
  if (!models || Object.keys(models).length === 0) {
    console.error('Error: failed to fetch model catalog from ' + API_URL);
    process.exit(1);
  }

  const match = findModel(models, args.model);
  if (!match) {
    const ids = Object.keys(models).slice(0, 12).join(', ');
    console.error(`Error: no model matched "${args.model}".`);
    console.error(`Available (sample): ${ids} ...`);
    process.exit(1);
  }

  console.log(render(match, models, pattern));
}

module.exports = {
  DEFAULT_PATTERN,
  CACHE_WRITE_SPLIT,
  normalizeCost,
  costPerRequest,
  effectiveCostPerRequest,
  requestsPerMonth,
  findModel,
  rankByEffective,
  fetchModelsMap,
  parseArgs,
  render
};

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
