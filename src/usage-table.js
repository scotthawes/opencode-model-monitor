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

module.exports = {
  MONTHLY_CREDIT,
  DEFAULT_CAP,
  multiplierForCap,
  getUsageCap,
  effectiveMultiplier,
  effectiveCost,
  loadTable,
  setTable
};
