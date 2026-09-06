'use strict';

// v1/models liveness cross-check (v0.12.0, #90; Zen mirror v0.15.0, #96).
//
// GETs https://opencode.ai/zen/go/v1/models (Go) and
// https://opencode.ai/zen/v1/models (Zen, opencode provider base) with the same
// Bearer auth as usage.js, on the same 30min cadence as api.json. IDs only —
// no pricing is ever derived from these endpoints. Two jobs:
//
//   1. Withdrawn-but-priced: models present in the pricing snapshot but absent
//      from liveness get a deduped warning "priced but not serving: <id>".
//   2. Outage-vs-quota: when liveness (Go and/or Zen) and usage both fail the
//      provider is likely down ("provider outage suspected"); a usage-only
//      failure is a quota/auth issue, not an outage. See classifyOutage().
//
// Best-effort, never throws. ETag + 15s timeout like the other watchers.

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

const LIVENESS_URL = 'https://opencode.ai/zen/go/v1/models';
const ZEN_LIVENESS_URL = 'https://opencode.ai/zen/v1/models';
const TIMEOUT_MS = 15000;
const ETAG_FILE = '.etag-liveness';
const SNAP_FILE = 'liveness-snapshot.json';
const ZEN_ETAG_FILE = '.etag-liveness-zen';
const ZEN_SNAP_FILE = 'liveness-zen-snapshot.json';

// Pure: extract the serving ID set from a v1/models payload. Accepts the
// OpenAI list shape ({ data: [{ id }] }), a bare array, or a { models }
// object map (keys are ids). Returns an array of string ids (possibly empty).
function extractServingIds(data) {
  try {
    if (Array.isArray(data)) {
      return data
        .map((e) => (e && typeof e === 'object' ? e.id : e))
        .filter((id) => typeof id === 'string' && id.length);
    }
    if (data && typeof data === 'object') {
      if (Array.isArray(data.data)) {
        return data.data
          .map((e) => (e && typeof e === 'object' ? e.id : null))
          .filter((id) => typeof id === 'string' && id.length);
      }
      if (data.models && typeof data.models === 'object' && !Array.isArray(data.models)) {
        return Object.keys(data.models);
      }
    }
  } catch (_) {
    // fall through to []
  }
  return [];
}

// Pure: priced-but-absent diff. `pricedIds` and `servingIds` are arrays (or a
// priced map object — keys are used). Returns the withdrawn ids: priced but
// not present in liveness.
function computeWithdrawn(pricedIds, servingIds) {
  const priced = Array.isArray(pricedIds) ? pricedIds : Object.keys(pricedIds || {});
  const serving = new Set(Array.isArray(servingIds) ? servingIds : []);
  return priced.filter((id) => typeof id === 'string' && id.length && !serving.has(id));
}

// Pure: outage-vs-quota classification from the two watcher statuses.
// Both non-ok (with a real error, not just a missing key) → 'outage'.
// Usage-only failure → 'quota'. Otherwise → 'ok'.
function classifyOutage(livenessStatus, usageStatus, livenessError, usageError) {
  const liveBad = livenessStatus !== 'ok';
  const useBad = usageStatus !== 'ok';
  if (liveBad && useBad) {
    // A missing local key is a config issue, not a provider outage.
    const noKey = (e) => typeof e === 'string' && /no key/i.test(e);
    if (noKey(livenessError) || noKey(usageError)) return 'quota';
    return 'outage';
  }
  if (useBad) return 'quota';
  return 'ok';
}

// Best-effort read of the opencode-go Bearer key (same lookup as usage.js).
function readGoKey(authJsonPath) {
  try {
    const raw = fs.readFileSync(authJsonPath, 'utf8');
    const d = JSON.parse(raw);
    let entry = d && d['opencode-go'];
    if (!entry || !entry.key) {
      for (const k of Object.keys(d || {})) {
        if (/^opencode-go/.test(k) && d[k] && d[k].key) {
          entry = d[k];
          break;
        }
      }
    }
    return entry && entry.key ? entry.key : null;
  } catch (_) {
    return null;
  }
}

// Run the liveness check. `pricedModels` is the pricing snapshot map (or an
// id array, e.g. the free-model list); `usageStatus`/`usageError` feed the
// outage-vs-quota signal but this function never emits the outage alert itself
// — monitor.js does that so the combined signal is reported exactly once.
// `overrides` optionally swaps the endpoint + state files ({ url, etagFile,
// snapFile, dedupPrefix }) — the Zen mirror passes its own; the default is the
// Go endpoint so the Go path is untouched. Never throws.
async function runLivenessWatchWith(stateDir, authJsonPath, pricedModels, usageStatus, usageError, opts) {
  const url = (opts && opts.url) || LIVENESS_URL;
  const etagName = (opts && opts.etagFile) || ETAG_FILE;
  const snapName = (opts && opts.snapFile) || SNAP_FILE;
  const dedupPrefix = (opts && opts.dedupPrefix) || 'liveness:missing:';
  const etagFile = path.join(stateDir, etagName);
  const snapFile = path.join(stateDir, snapName);
  const pricedIds = Array.isArray(pricedModels) ? pricedModels : Object.keys(pricedModels || {}).filter((k) => k !== 'freeModels' && k !== 'modelPrivacy');

  const key = authJsonPath ? readGoKey(authJsonPath) : null;
  if (!key) {
    return { status: 'unknown', error: 'no key', servingIds: [], withdrawn: [], changes: [] };
  }

  let etag = null;
  try {
    etag = fs.readFileSync(etagFile, 'utf8').trim() || null;
  } catch (_) {}

  const headers = { Authorization: 'Bearer ' + key };
  if (etag) headers['If-None-Match'] = etag;

  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    return {
      status: 'unknown',
      error: String((e && e.message) || e),
      servingIds: [],
      withdrawn: [],
      changes: [],
      outage: classifyOutage('unknown', usageStatus || 'unknown', String((e && e.message) || e), usageError)
    };
  }

  if (res.status === 304) {
    let snap = null;
    try {
      snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    } catch (_) {
      snap = null;
    }
    const servingIds = (snap && Array.isArray(snap.ids)) ? snap.ids : [];
    const withdrawn = computeWithdrawn(pricedIds, servingIds);
    const changes = withdrawn.map((id) => `priced but not serving: ${id}`);
    return { status: 'unchanged', servingIds, withdrawn, changes };
  }

  if (!res.ok) {
    return {
      status: 'unknown',
      error: `HTTP ${res.status}`,
      servingIds: [],
      withdrawn: [],
      changes: [],
      outage: classifyOutage('unknown', usageStatus || 'unknown', `HTTP ${res.status}`, usageError)
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return {
      status: 'unknown',
      error: 'parse',
      servingIds: [],
      withdrawn: [],
      changes: [],
      outage: classifyOutage('unknown', usageStatus || 'unknown', 'parse', usageError)
    };
  }

  const servingIds = extractServingIds(data);
  const withdrawn = computeWithdrawn(pricedIds, servingIds);
  const changes = [];

  for (const id of withdrawn) {
    const msg = `priced but not serving: ${id}`;
    changes.push(msg);
    try {
      delivery.alert('warning', 'Model not serving', msg, {
        dedupKey: `${dedupPrefix}${id}`,
        dedupTtlMs: 3600000
      });
    } catch (_) {
      // best effort
    }
  }

  try {
    fs.writeFileSync(snapFile, JSON.stringify({ ts: new Date().toISOString(), ids: servingIds }, null, 2));
    const newEtag = res.headers && res.headers.get ? res.headers.get('etag') : null;
    if (newEtag) fs.writeFileSync(etagFile, newEtag);
  } catch (e) {
    try {
      delivery.alert('warning', 'Liveness snapshot save failed', String((e && e.message) || e));
    } catch (_) {}
  }

  return {
    status: 'ok',
    servingIds,
    withdrawn,
    changes,
    outage: classifyOutage('ok', usageStatus || 'unknown', null, usageError)
  };
}

// Go endpoint with default state files. `overrides` is optional and only used
// by tests/callers that need a custom endpoint; the default path is identical
// to the pre-Zen implementation.
async function runLivenessWatch(stateDir, authJsonPath, pricedModels, usageStatus, usageError, overrides) {
  return runLivenessWatchWith(stateDir, authJsonPath, pricedModels, usageStatus, usageError, overrides);
}

// Zen mirror (v0.15.0, #96): same Bearer key, same withdrawn/dedup logic, own
// ETag + snapshot files so the two endpoints never clobber each other.
async function runZenLivenessWatch(stateDir, authJsonPath, pricedModels, usageStatus, usageError) {
  return runLivenessWatchWith(stateDir, authJsonPath, pricedModels, usageStatus, usageError, {
    url: ZEN_LIVENESS_URL,
    etagFile: ZEN_ETAG_FILE,
    snapFile: ZEN_SNAP_FILE,
    dedupPrefix: 'liveness-zen:missing:'
  });
}

module.exports = {
  runLivenessWatch,
  runZenLivenessWatch,
  extractServingIds,
  computeWithdrawn,
  classifyOutage,
  LIVENESS_URL,
  ZEN_LIVENESS_URL
};
