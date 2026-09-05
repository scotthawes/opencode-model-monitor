'use strict';

// Effective-price multiplier table.
//
// opencode-go applies a $60 monthly credit to usage. A model whose monthly usage
// is capped at $15 effectively costs 4x its list price to get equivalent coverage;
// a $100-cap model effectively costs 0.6x. The live api.json catalog has NO
// per-model usage-cap field (verified: 'usage' is absent, 'tiers' is null), so we
// maintain this table locally and never block the monitor cycle on an external
// scrape. See src/usage-table.json for the documented schema + maintenance notes.
//
// effective price (per metric) = list price x (MONTHLY_CREDIT / usageCap)
//
// Best-effort and fully non-blocking: a missing/invalid table or an unknown model
// degrades to the default cap (60 -> 1x), logging a one-time warning so the
// maintainer can populate the override.

const fs = require('fs');
const path = require('path');

const TABLE_PATH = path.join(__dirname, 'usage-table.json');

// The monthly credit applied to opencode-go usage (USD). Effective price scales a
// model's list price by (MONTHLY_CREDIT / usageCap).
const MONTHLY_CREDIT = 60;
const DEFAULT_CAP = 60;

// In-memory cache. Loaded lazily from TABLE_PATH on first use; `setTable` (test
// hook) overrides it so unit tests can inject a fixed table without touching disk.
let table = null;
const warned = new Set();

// Pure multiplier for an explicit cap: MONTHLY_CREDIT / cap.
function multiplierForCap(cap) {
  const c = Number(cap);
  if (!isFinite(c) || c <= 0) return null;
  return MONTHLY_CREDIT / c;
}

function loadTable() {
  if (table) return table;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
  } catch (_) {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
    table = parsed.models;
  } else {
    table = {};
  }
  return table;
}

// Best-effort: return the per-model usage cap (USD) or the default 60 when the
// model is absent/invalid. Logs a one-time warning (via `log` if given, else
// console.warn) for unknown models so the maintainer can populate the override.
function getUsageCap(modelId, log) {
  const t = loadTable();
  if (modelId != null && Object.prototype.hasOwnProperty.call(t, modelId)) {
    const v = Number(t[modelId]);
    if (isFinite(v) && v > 0) return v;
  }
  if (modelId != null && !warned.has(modelId)) {
    warned.add(modelId);
    const msg = `usage cap unknown for "${modelId}" — using default $${DEFAULT_CAP} (effective 1x). Add to src/usage-table.json to override.`;
    if (typeof log === 'function') {
      try { log(msg); } catch (_) {}
    } else {
      try { console.warn('[usage-table] ' + msg); } catch (_) {}
    }
  }
  return DEFAULT_CAP;
}

// Effective multiplier (MONTHLY_CREDIT / cap) for a model id. Returns null only
// when the cap is non-positive/non-finite (defensive); normally a finite number.
function effectiveMultiplier(modelId, log) {
  const cap = getUsageCap(modelId, log);
  return multiplierForCap(cap);
}

// Compute effective cost (per metric) = raw cost x multiplier. Returns a new
// object containing only the numeric metrics present in `cost`
// (input/output/cache_read/cache_write); non-numeric values are dropped. Returns
// null when `cost` is missing/non-object.
function effectiveCost(cost, modelId, log) {
  if (!cost || typeof cost !== 'object') return null;
  const mult = effectiveMultiplier(modelId, log);
  if (mult == null) return null;
  const out = {};
  for (const k of Object.keys(cost)) {
    const n = Number(cost[k]);
    if (isFinite(n)) out[k] = n * mult;
  }
  return out;
}

// Test/override hook: replace the loaded table with an explicit map (or null to
// clear the cache and force a reload from disk on next use). Never used in prod.
function setTable(map) {
  table = map && typeof map === 'object' ? map : null;
  warned.clear();
}

// --- Context-tier effective cost (P1-3, #52) --------------------------------
//
// Some opencode-go models price by context tier: a `standard` list price
// (<=200K context) plus a higher `large-context` price for >200K context,
// carried under `cost.context_over_200k` (and redundantly under `cost.tiers[]`
// with a `{ type:'context', size }` descriptor). The live catalog has no
// per-tier usage-cap, so we apply the SAME model-level $60-credit multiplier to
// every tier (the multiplier is per-model, not per-tier). We surface the
// effective cost of each tier so an alert can read e.g.
//   "hy3 tiers: standard i0.14 o1.1 cr0.035 / large-context i0.28 o2.2 cr0.07"
// Single-tier models (no `context_over_200k` and no numeric `tiers[]`) yield []
// so existing single-line alerts are unchanged.

const TIER_METRICS = ['input', 'output', 'cache_read', 'cache_write'];

// True when `c` (cost object or tier entry) carries at least one numeric price
// metric. Best-effort: never throws on non-objects.
function hasNumericMetrics(c) {
  if (!c || typeof c !== 'object') return false;
  return TIER_METRICS.some((k) => isFinite(Number(c[k])));
}

// Pull only the recognized numeric price metrics out of `c` into a fresh object.
function pickMetrics(c) {
  const out = {};
  if (c && typeof c === 'object') {
    for (const k of TIER_METRICS) {
      const n = Number(c[k]);
      if (isFinite(n)) out[k] = n;
    }
  }
  return out;
}

// Extract the per-tier list prices from a model `cost` object. Returns [] for
// missing/non-object cost, [{standard}] for a single-tier model, or
// [{standard},{large-context}] for a tiered model. The alternate is taken from
// `context_over_200k` when present, else the first numeric entry of `tiers[]`.
// The `tiers[]` descriptor's `{ type, size }` drives the label (size > 200K ->
// "large-context"); a non-context tier falls back to its `type` string.
function extractTierCosts(cost) {
  if (!cost || typeof cost !== 'object') return [];
  const out = [];
  if (hasNumericMetrics(cost)) {
    out.push({ label: 'standard', cost: pickMetrics(cost) });
  }
  let alt = null;
  let altMeta = null;
  if (cost.context_over_200k && hasNumericMetrics(cost.context_over_200k)) {
    alt = cost.context_over_200k;
    altMeta = { type: 'context' };
  } else if (Array.isArray(cost.tiers)) {
    for (const t of cost.tiers) {
      if (t && hasNumericMetrics(t)) {
        alt = t;
        altMeta = (t && typeof t === 'object' && t.tier) || null;
        break;
      }
    }
  }
  if (alt) {
    let label = 'large-context';
    if (altMeta && altMeta.type === 'context') {
      if (typeof altMeta.size === 'number') {
        label = altMeta.size > 200000 ? 'large-context' : 'context>' + altMeta.size;
      }
    } else if (altMeta && typeof altMeta.type === 'string') {
      label = altMeta.type;
    }
    out.push({ label, cost: pickMetrics(alt) });
  }
  return out;
}

// Effective cost (list x 60/usage-cap) for each context tier of a model. Returns
// [] for a single-tier (or missing) model so callers render nothing extra. Each
// entry is { label, effective:{input,output,cache_read,cache_write} }. The model
// multiplier is applied uniformly to every tier.
function effectiveTierCosts(cost, modelId, log) {
  const tiers = extractTierCosts(cost);
  if (tiers.length < 2) return []; // single-tier: nothing extra to show
  return tiers.map((t) => ({ label: t.label, effective: effectiveCost(t.cost, modelId, log) }));
}

module.exports = {
  MONTHLY_CREDIT,
  DEFAULT_CAP,
  multiplierForCap,
  getUsageCap,
  effectiveMultiplier,
  effectiveCost,
  loadTable,
  setTable,
  extractTierCosts,
  effectiveTierCosts
};
