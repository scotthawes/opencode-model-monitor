'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

const API_URL = 'https://models.opencode.ai/api.json';

// --- P2-2 (#55): zod-style validation of api.json shape drift -----------------
//
// Hand-rolled schema check (no new deps) that fails closed on a malformed
// catalog so a transient upstream glitch never reports every model as removed
// or overwrites the prior good snapshot. Returns { ok, reason }. `reason` is a
// human-readable, actionable string suitable for a WARNING alert.
//
// Schema (the opencode-go provider is the source of truth for billable pricing):
//   - top level must be a non-array object
//   - must contain `opencode-go` (object) with `models` (non-empty object)
//   - each model must carry a cost-like numeric field: a `cost` object with at
//     least one numeric value, or a flat `input`/`output` number.
function validateApiShape(data) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: `top-level payload is not an object (got ${typeof data})` };
  }
  const og = data['opencode-go'];
  if (og == null || typeof og !== 'object' || Array.isArray(og)) {
    return { ok: false, reason: "missing or non-object 'opencode-go' key" };
  }
  const models = og.models;
  if (models == null || typeof models !== 'object' || Array.isArray(models)) {
    return { ok: false, reason: "'opencode-go.models' is missing or not an object" };
  }
  const ids = Object.keys(models);
  if (ids.length === 0) {
    return { ok: false, reason: "'opencode-go.models' is empty" };
  }
  for (const id of ids) {
    const m = models[id];
    if (m == null || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, reason: `model '${id}' is not an object` };
    }
    let hasNumericCost = false;
    if (typeof m.input === 'number' || typeof m.output === 'number') hasNumericCost = true;
    if (m.cost != null && typeof m.cost === 'object' && !Array.isArray(m.cost)) {
      // A cost object with at least one numeric field counts as cost-like.
      if (Object.keys(m.cost).some((k) => typeof m.cost[k] === 'number')) hasNumericCost = true;
    }
    if (!hasNumericCost) {
      return {
        ok: false,
        reason: `model '${id}' has no cost-like numeric field (expected a 'cost' object with numeric values or flat 'input'/'output' numbers)`
      };
    }
  }
  return { ok: true };
}

// --- Price history time-series ---------------------------------------------
//
// Persist a dated pricing sample on every successful price-watch so price drops
// and catalog changes can be trended/audited over time (unlocks P1-4/P2-1). The
// history is a JSON array of samples (oldest→newest):
//   [ { ts: <ISO>, models: { <id>: { cost, tiers } } }, ... ]
// See README "Price history" for the documented schema.
//
// Best-effort and fully non-blocking: any failure is swallowed so the alert path
// and snapshot write are never affected. Written atomically (tmp file + rename)
// so a crash mid-write can never leave a half-written array. A corrupt/missing
// history file is simply replaced by a fresh valid array on the next append.
const HISTORY_FILE = 'history.json';
const HISTORY_MAX_ENTRIES = 500;
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // prune samples older than 90d

// Append a dated sample of the current model catalog to state/history.json.
// `modelsMap` is the same { id: { cost, tiers } } shape price-watch diffs.
// Never throws; never blocks the caller.
function appendPriceHistory(stateDir, modelsMap) {
  try {
    const historyPath = path.join(stateDir, HISTORY_FILE);
    let arr = [];
    try {
      const raw = fs.readFileSync(historyPath, 'utf8');
      const parsed = JSON.parse(raw);
      // A present-but-corrupt history is replaced (recovered) by the atomic write
      // below; a non-array shape is also reset to a fresh array.
      arr = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      arr = []; // missing file → first sample
    }

    arr.push({ ts: new Date().toISOString(), models: modelsMap });

    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    arr = arr.filter((s) => (s.ts ? Date.parse(s.ts) : 0) >= cutoff);
    if (arr.length > HISTORY_MAX_ENTRIES) {
      arr = arr.slice(arr.length - HISTORY_MAX_ENTRIES);
    }

    const tmp = historyPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, historyPath);
  } catch (_) {
    // best effort — never throw, never block alerts
  }
}

// Writes a placeholder pricing snapshot on the very first run when pricing
// could not be fetched (e.g. offline). This guarantees state/pricing-snapshot.json
// exists so downstream readers never treat a missing file as a fresh, full diff.
// Only writes if the file does not already exist, so an existing good snapshot is
// never clobbered by a transient offline blip on a later run.
function ensureSnapshotExists(snapFile, message) {
  try {
    if (!fs.existsSync(snapFile)) {
      fs.writeFileSync(
        snapFile,
        JSON.stringify({ status: 'unknown', error: String(message && message.message ? message.message : message) }, null, 2)
      );
    }
  } catch (_) {
    // best effort
  }
}

// Extract display metadata for a model from a live api.json entry. This is
// ADDITIVE relative to the existing cost/tiers diff: it never affects the
// cost/tiers comparison and degrades gracefully (nulls) when a field is absent.
// The source of truth is api.json; it already carries capabilities, context
// window (`limit`), provider (npm for some), open_weights, and knowledge. The
// structured privacy/training fields are NOT present in api.json today — enriching
// from models.dev is a documented follow-up (P0-2, see GAPS.md) and is intentionally
// NOT attempted here so the monitor cycle never blocks or fails on an external scrape.
function extractModelMeta(m) {
  m = m || {};
  const modalities = m.modalities && typeof m.modalities === 'object' ? m.modalities : null;
  const limit = m.limit && typeof m.limit === 'object' ? m.limit : null;
  const provider =
    m.provider && typeof m.provider === 'object' ? m.provider.npm || m.provider.id || null : null;
  let capabilities = null;
  if (
    ('tool_call' in m) || ('reasoning' in m) || ('attachment' in m) ||
    ('structured_output' in m) || ('temperature' in m) || ('interleaved' in m) || modalities
  ) {
    capabilities = {
      tool_call: !!m.tool_call,
      reasoning: !!m.reasoning,
      attachment: !!m.attachment,
      structured_output: !!m.structured_output,
      temperature: !!m.temperature,
      interleaved: !!m.interleaved,
      modalities
    };
  }
  return {
    name: typeof m.name === 'string' ? m.name : null,
    family: typeof m.family === 'string' ? m.family : null,
    provider,
    contextWindow: limit && typeof limit.context === 'number' ? limit.context : null,
    outputLimit: limit && typeof limit.output === 'number' ? limit.output : null,
    capabilities,
    open_weights: typeof m.open_weights === 'boolean' ? m.open_weights : null,
    knowledge: m.knowledge != null ? m.knowledge : null,
    release_date: typeof m.release_date === 'string' ? m.release_date : null,
    last_updated: typeof m.last_updated === 'string' ? m.last_updated : null
  };
}

// A model is "free" when its id ends in `-free`/`:free` (the opencode Zen
// naming convention) or its cost is explicitly zero. Used by the additive
// Zen free-model track (P1-2, #51) so free models are announced but never
// counted as billable in the opencode-go cost/tiers diff.
function isFreeModel(id, m) {
  m = m || {};
  const norm = String(id == null ? '' : id).toLowerCase();
  if (norm.endsWith('-free') || norm.endsWith(':free')) return true;
  const c = m.cost;
  if (c != null) {
    if (typeof c === 'number') return c === 0;
    if (typeof c === 'object') {
      const vals = Object.values(c).filter((x) => typeof x === 'number');
      if (vals.length && vals.every((x) => x === 0)) return true;
    }
  }
  return false;
}

// Fetches the authoritative pricing catalog for the opencode-go provider,
// diffs it against the previous snapshot, and alerts on any model change.
// Returns { status, models, changes, modelCount, error, freeModels }.
async function runPriceWatch(stateDir) {
  const etagFile = path.join(stateDir, '.etag-pricing');
  const snapFile = path.join(stateDir, 'pricing-snapshot.json');

  let etag = null;
  try {
    etag = fs.readFileSync(etagFile, 'utf8').trim() || null;
  } catch (_) {}

  const headers = {};
  if (etag) headers['If-None-Match'] = etag;

  let res;
  try {
    res = await fetch(API_URL, { headers });
  } catch (e) {
    delivery.alert('warning', 'Pricing fetch failed', String(e && e.message ? e.message : e));
    ensureSnapshotExists(snapFile, e && e.message ? e.message : e);
    return { status: 'unknown', error: String(e && e.message ? e.message : e), models: readSnapshot(snapFile) };
  }

  if (res.status === 304) {
    // Catalog unchanged: surface the previously persisted free-model list (it is
    // already in the snapshot) so the report/Discord views stay accurate every
    // cycle without re-scanning the unchanged catalog.
    const snap = readSnapshot(snapFile);
    return {
      status: 'unchanged',
      models: snap,
      changes: [],
      freeModels: Array.isArray(snap.freeModels) ? Object.keys(snap.freeModels) : []
    };
  }

  if (!res.ok) {
    delivery.alert('warning', `Pricing fetch HTTP ${res.status}`, API_URL);
    ensureSnapshotExists(snapFile, `HTTP ${res.status}`);
    return { status: 'unknown', error: `HTTP ${res.status}`, models: readSnapshot(snapFile) };
  }

  const newEtag = res.headers && res.headers.get ? res.headers.get('etag') : null;
  let data;
  try {
    data = await res.json();
  } catch (e) {
    delivery.alert('warning', 'Pricing JSON parse failed', String(e && e.message ? e.message : e));
    ensureSnapshotExists(snapFile, 'parse');
    return { status: 'unknown', error: 'parse', models: readSnapshot(snapFile) };
  }

  // P2-2 (#55): zod-style validation of api.json shape drift. A malformed
  // catalog on a 200-OK is treated exactly like a fetch failure — a WARNING
  // alert plus no diff — so a transient upstream glitch never reports every
  // model as removed or clobbers the prior good snapshot.
  const shape = validateApiShape(data);
  if (!shape.ok) {
    delivery.alert('warning', 'Pricing shape unexpected', shape.reason);
    ensureSnapshotExists(snapFile, shape.reason);
    return { status: 'unknown', error: shape.reason, models: readSnapshot(snapFile), changes: [] };
  }

  const og = (data && data['opencode-go']) || null;
  const modelsRaw = (og && og.models) || {};
  const modelsMap = {};
  for (const id of Object.keys(modelsRaw)) {
    const m = modelsRaw[id] || {};
    // `meta` is additive: it rides along in the snapshot + report/Discord views
    // but is NEVER part of the cost/tiers diff below, so existing alerts stay intact.
    modelsMap[id] = { cost: m.cost || null, tiers: m.tiers || null, meta: extractModelMeta(m) };
  }

  // --- Zen (opencode) free-model detection (P1-2, #51) -----------------------
  //
  // ADDITIVE and fully independent of the opencode-go cost/tiers diff above: the
  // opencode `opencode` (Zen) key carries its own model catalog, and some entries
  // are free (`*-free` / `:free` id, or an explicitly zero cost). We track those
  // separately in the snapshot (a top-level `freeModels` map) so the billable
  // diff is never affected and free models are never overstated as cost. Free
  // models are flagged here (not in the opencode-go loop) so a model cannot be
  // double-counted as both billable and free.
  const zen = (data && data['opencode']) || null;
  const zenModelsRaw = (zen && zen.models) || {};
  const freeModels = {};
  for (const id of Object.keys(zenModelsRaw)) {
    const m = zenModelsRaw[id] || {};
    if (isFreeModel(id, m)) {
      freeModels[id] = { cost: m.cost || null, tiers: m.tiers || null, meta: extractModelMeta(m) };
    }
  }

  let prev = {};
  let prevValid = true;
  let snapExisted = false;
  try {
    const raw = fs.readFileSync(snapFile, 'utf8');
    snapExisted = true;
    const parsed = JSON.parse(raw);
    if (isValidSnapshot(parsed)) prev = parsed;
    else prevValid = false; // file exists but shape is unrecognized
  } catch (_) {
    // Missing file → first run (empty baseline, normal). A present but corrupt
    // JSON file → shape unrecognized, so we must NOT blindly trust it.
    prevValid = !snapExisted;
    prev = {};
  }

  // The previous free-model list lives under a top-level `freeModels` snapshot
  // key. Strip it before the cost/tiers diff below so it is never mistaken for a
  // billable opencode-go model entry (which would spuriously report every free
  // model as added/removed). Only trust a prior free list when the snapshot was
  // valid; a corrupt/placeholder snapshot is treated as no-diff (no free flood).
  const prevFree =
    prevValid && prev && typeof prev === 'object' && prev.freeModels && typeof prev.freeModels === 'object'
      ? prev.freeModels
      : {};
  if (prev && typeof prev === 'object' && prev.freeModels != null) delete prev.freeModels;

  const prevIds = prevValid ? new Set(Object.keys(prev)) : new Set();
  const newIds = new Set(Object.keys(modelsMap));
  const changes = [];
  // Structured descriptors for the aggregated Discord model-change table.
  const modelChanges = [];

  if (prevValid) {
    for (const id of newIds) {
      if (!prevIds.has(id)) {
        changes.push(`Added model: ${id}`);
        modelChanges.push({ subtype: 'added', model: id, cost: (modelsMap[id] || {}).cost || null, meta: (modelsMap[id] || {}).meta || null });
      } else {
        const a = prev[id] || {};
        const b = modelsMap[id] || {};
        if (JSON.stringify(a.cost) !== JSON.stringify(b.cost)) {
          changes.push(`Cost changed for ${id}: ${JSON.stringify(a.cost)} -> ${JSON.stringify(b.cost)}`);
          modelChanges.push({ subtype: 'cost', model: id, oldCost: a.cost || null, newCost: b.cost || null, meta: (modelsMap[id] || {}).meta || null });
        }
        if (JSON.stringify(a.tiers) !== JSON.stringify(b.tiers)) {
          changes.push(`Tiers changed for ${id}`);
          modelChanges.push({ subtype: 'tiers', model: id, meta: (modelsMap[id] || {}).meta || null });
        }
      }
    }
    for (const id of prevIds) {
      if (!newIds.has(id)) {
        changes.push(`Removed model: ${id}`);
        modelChanges.push({ subtype: 'removed', model: id, meta: (prev[id] || {}).meta || null });
      }
    }
  } else {
    // Corrupt/placeholder snapshot: treat as no-diff so we never report a flood
    // of added/removed models. The freshly fetched snapshot is still written
    // below as the new baseline for subsequent runs.
    delivery.alert(
      'warning',
      'Pricing snapshot invalid',
      'previous snapshot shape unrecognized; treating as no-diff (no removals reported)'
    );
  }

  // --- Free-model diff (additive, independent of the cost/tiers diff) --------
  // Emits a non-fatal `model_change` notice for free Zen models: "Free model
  // available: <id>" on add, "Free model changed: <id>" when a tracked free
  // model's cost definition changes, and "Free model removed: <id>" on removal.
  // These ride along in the same aggregated Discord table as billable changes
  // (rendered with the 🆓 marker) and are deduped per-model via the existing
  // `model:` prefix store. Suppressed entirely when the prior snapshot was
  // invalid (same no-diff discipline as the billable path).
  const freeChanges = [];
  if (prevValid) {
    const prevFreeIds = new Set(Object.keys(prevFree));
    const newFreeIds = new Set(Object.keys(freeModels));
    for (const id of newFreeIds) {
      if (!prevFreeIds.has(id)) {
        freeChanges.push({ subtype: 'free', reason: 'available', model: id, meta: (freeModels[id] || {}).meta || null });
      } else {
        const a = prevFree[id] || {};
        const b = freeModels[id] || {};
        if (JSON.stringify(a.cost) !== JSON.stringify(b.cost)) {
          freeChanges.push({ subtype: 'free', reason: 'changed', model: id, meta: (freeModels[id] || {}).meta || null });
        }
      }
    }
    for (const id of prevFreeIds) {
      if (!newFreeIds.has(id)) {
        freeChanges.push({ subtype: 'free', reason: 'removed', model: id, meta: (prevFree[id] || {}).meta || null });
      }
    }
  }
  for (const fc of freeChanges) {
    if (fc.reason === 'removed') changes.push(`Free model removed: ${fc.model}`);
    else if (fc.reason === 'changed') changes.push(`Free model changed: ${fc.model}`);
    else changes.push(`Free model available: ${fc.model}`);
    modelChanges.push(fc);
  }

  try {
    // Persist opencode-go models plus the independent free-model list. The
    // top-level `freeModels` key is stripped before the cost/tiers diff on the
    // next run (see prevFree handling above), so the billable comparison is
    // never perturbed by its presence here.
    const snapshot = Object.assign({}, modelsMap);
    snapshot.freeModels = freeModels;
    fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));
    if (newEtag) fs.writeFileSync(etagFile, newEtag);
  } catch (e) {
    delivery.alert('warning', 'Pricing snapshot save failed', String(e && e.message ? e.message : e));
  }

  // Persist the time-series sample (additive change; never blocks the alert
  // path). Only reached on a successful, non-empty price fetch. The history
  // schema stays { id: { cost, tiers } } (no meta) to preserve the documented
  // P1-4 format; metadata lives in the snapshot + report/Discord views.
  const historyModels = {};
  for (const id of Object.keys(modelsMap)) {
    const e = modelsMap[id] || {};
    historyModels[id] = { cost: e.cost || null, tiers: e.tiers || null };
  }
  appendPriceHistory(stateDir, historyModels);

  // alerts.log still gets the human-readable single lines, while Discord gets a
  // single aggregated table post (old->new per metric) instead of N one-liners.
  if (modelChanges.length) {
    // Ensure free-model ids are recognized for per-model dedup (the existing
    // `model:` prefix store) so a free-model re-alert within the TTL window is
    // suppressed exactly like a billable change — not just on the opencode-go ids.
    delivery.setKnownModelIds(new Set([...Object.keys(modelsMap), ...Object.keys(freeModels)]));
    delivery.deliverModelChangeTable(modelChanges);
  }

  return {
    status: 'ok',
    models: modelsMap,
    changes,
    modelChanges,
    modelCount: newIds.size,
    freeModels: Object.keys(freeModels)
  };
}

function readSnapshot(snapFile) {
  try {
    return JSON.parse(fs.readFileSync(snapFile, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

// A pricing snapshot is "valid" only if it is a non-array object containing at
// least one model-like entry (an object carrying `cost`/`tiers`). This lets us
// recognize a corrupt or placeholder snapshot (e.g. the `{ status: 'unknown',
// error: '...' }` written when a fetch fails) and treat it as no-diff instead of
// reporting every model as added/removed.
function isValidSnapshot(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length < 1) return false;
  return keys.some((k) => {
    const v = obj[k];
    return v && typeof v === 'object' && !Array.isArray(v) && (('cost' in v) || ('tiers' in v));
  });
}

module.exports = { runPriceWatch, appendPriceHistory, extractModelMeta, isFreeModel, validateApiShape };
