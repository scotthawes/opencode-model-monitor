'use strict';

// catalog.json cross-check (v0.12.0, #90).
//
// Fetches https://models.opencode.ai/catalog.json (the full model catalog with
// per-model status/deprecated metadata) with ETag + 15s timeout, on the same
// 30min cadence as api.json. Two jobs:
//
//   1. Shape-drift guard: when api.json shape validation fails but catalog.json
//      fetches + validates OK, the api.json failure is likely drift (schema
//      moved) rather than a real outage — report "api.json drift suspected".
//   2. Deprecated cross-check: surface per-model status/deprecated transitions
//      as a deduped `model_change` ("Model deprecated: <id>") and enrich meta
//      minimally ({ name, status, deprecated }).
//
// Best-effort, never throws. No pricing is derived here (api.json owns cost).

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');
const { fetchWithRetry } = require('./fetch-retry'); // v0.20.0 (#112)
const { atomicWriteFileSync, atomicWriteJsonSync, readJsonKeepBak, redactUrl } = require('./atomic-write');

const CATALOG_URL = 'https://models.opencode.ai/catalog.json';
const TIMEOUT_MS = 15000;
const ETAG_FILE = '.etag-catalog';
const SNAP_FILE = 'catalog-snapshot.json';

// Pure: normalize a catalog entry's status/deprecated signal.
// Deprecated when `deprecated === true` or `status === 'deprecated'`.
function extractCatalogStatus(m) {
  m = m || {};
  const status = typeof m.status === 'string' ? m.status : null;
  const deprecated = m.deprecated === true || status === 'deprecated';
  return { status, deprecated };
}

// Pure: minimal meta enrichment carried for deprecated alerts + report views.
function extractCatalogMeta(id, m) {
  m = m || {};
  const { status, deprecated } = extractCatalogStatus(m);
  return {
    name: typeof m.name === 'string' ? m.name : null,
    status,
    deprecated,
    id: String(id)
  };
}

// Pure: validate the catalog.json shape. Must be a non-array object with a
// non-empty `models` object whose entries are objects. Returns { ok, reason }.
function validateCatalogShape(data) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: `top-level payload is not an object (got ${typeof data})` };
  }
  const models = data.models;
  if (models == null || typeof models !== 'object' || Array.isArray(models)) {
    return { ok: false, reason: "'models' is missing or not an object" };
  }
  const ids = Object.keys(models);
  if (ids.length === 0) {
    return { ok: false, reason: "'models' is empty" };
  }
  for (const id of ids) {
    const m = models[id];
    if (m == null || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, reason: `model '${id}' is not an object` };
    }
  }
  return { ok: true };
}

// Pure: compute deprecated transitions between a prior status map and the
// current one. Both maps are { id: { deprecated } }. Returns descriptors
// [{ subtype:'deprecated', model, meta }].
function computeDeprecatedChanges(prevMap, currMap) {
  const changes = [];
  for (const id of Object.keys(currMap || {})) {
    const was = prevMap && prevMap[id] ? !!prevMap[id].deprecated : false;
    const is = currMap && currMap[id] ? !!currMap[id].deprecated : false;
    if (!was && is) {
      changes.push({
        subtype: 'deprecated',
        model: id,
        meta: (currMap[id] && currMap[id].meta) || null
      });
    }
  }
  return changes;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Fetch + cross-check the catalog. `opts.apiShapeFailed` (bool) signals that
// api.json shape validation failed this cycle — when the catalog itself is OK
// we report "api.json drift suspected". Never throws.
async function runCatalogWatch(stateDir, opts) {
  opts = opts || {};
  const apiShapeFailed = !!opts.apiShapeFailed;
  const etagFile = path.join(stateDir, ETAG_FILE);
  const snapFile = path.join(stateDir, SNAP_FILE);

  let etag = null;
  try {
    etag = fs.readFileSync(etagFile, 'utf8').trim() || null;
  } catch (_) {}

  const headers = {};
  if (etag) headers['If-None-Match'] = etag;

  let res;
  try {
    res = await fetchWithRetry(CATALOG_URL, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    delivery.alert('warning', 'Catalog fetch failed', String((e && e.message) || e), {
      dedupKey: 'catalog:fetch',
      dedupTtlMs: 3600000
    });
    return { status: 'unknown', error: String((e && e.message) || e), models: {}, changes: [] };
  }

  if (res.status === 304) {
    const snap = readJsonFile(snapFile) || {};
    const ids = Object.keys(snap);
    return { status: 'unchanged', models: snap, changes: [], modelCount: ids.length };
  }

  if (!res.ok) {
    delivery.alert('warning', `Catalog HTTP ${res.status}`, redactUrl(CATALOG_URL), {
      dedupKey: 'catalog:http',
      dedupTtlMs: 3600000
    });
    return { status: 'unknown', error: `HTTP ${res.status}`, models: {}, changes: [] };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    delivery.alert('warning', 'Catalog JSON parse failed', String((e && e.message) || e), {
      dedupKey: 'catalog:parse',
      dedupTtlMs: 3600000
    });
    return { status: 'unknown', error: 'parse', models: {}, changes: [] };
  }

  const shape = validateCatalogShape(data);
  if (!shape.ok) {
    delivery.alert('warning', 'Catalog shape unexpected', shape.reason, {
      dedupKey: 'catalog:shape',
      dedupTtlMs: 3600000
    });
    return { status: 'unknown', error: shape.reason, models: {}, changes: [] };
  }

  const raw = data.models || {};
  const modelsMap = {};
  for (const id of Object.keys(raw)) {
    const m = raw[id] || {};
    const { status, deprecated } = extractCatalogStatus(m);
    modelsMap[id] = { status, deprecated, meta: extractCatalogMeta(id, m) };
  }

  const changes = [];
  const modelChanges = [];

  // Shape-drift guard: api.json failed validation but the independent catalog
  // is healthy → the api.json schema likely drifted (not a provider outage).
  if (apiShapeFailed) {
    const msg = 'api.json drift suspected (api.json shape invalid, catalog.json OK)';
    changes.push(msg);
    try {
      delivery.alert('warning', 'api.json drift suspected', msg, {
        dedupKey: 'catalog:drift',
        dedupTtlMs: 3600000
      });
    } catch (_) {
      // best effort
    }
  }

  // Deprecated cross-check against the previously persisted snapshot.
  // v0.20.0 (#112): corrupt snapshot preserved as .bak instead of reset.
  let prev = readJsonKeepBak(snapFile, null).data;
  const prevValid = prev && typeof prev === 'object' && !Array.isArray(prev);
  const prevMap = prevValid ? prev : {};
  const depChanges = prevValid ? computeDeprecatedChanges(prevMap, modelsMap) : [];
  for (const dc of depChanges) {
    changes.push(`Model deprecated: ${dc.model}`);
    modelChanges.push(dc);
  }

  try {
    // v0.20.0 (#112): atomic snapshot + ETag writes.
    atomicWriteJsonSync(snapFile, modelsMap);
    const newEtag = res.headers && res.headers.get ? res.headers.get('etag') : null;
    if (newEtag) atomicWriteFileSync(etagFile, newEtag);
  } catch (e) {
    delivery.alert('warning', 'Catalog snapshot save failed', String((e && e.message) || e));
  }

  if (modelChanges.length) {
    try {
      delivery.setKnownModelIds(new Set(Object.keys(modelsMap)));
      await delivery.deliverModelChangeTable(modelChanges);
    } catch (_) {
      // best effort — never block the cycle
    }
  }

  return {
    status: 'ok',
    models: modelsMap,
    changes,
    modelChanges,
    modelCount: Object.keys(modelsMap).length
  };
}

module.exports = {
  runCatalogWatch,
  validateCatalogShape,
  extractCatalogStatus,
  extractCatalogMeta,
  computeDeprecatedChanges,
  CATALOG_URL
};
