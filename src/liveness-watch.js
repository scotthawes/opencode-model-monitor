'use strict';

// v1/models liveness cross-check (v0.12.0, #90; Zen mirror v0.15.0, #96;
// Zen scoping v0.15.1, #98; Zen shrinkage-only v0.15.2, #100).
//
// GETs https://opencode.ai/zen/go/v1/models (Go) and
// https://opencode.ai/zen/v1/models (Zen, opencode provider base) with the same
// Bearer auth as usage.js, on the same 30min cadence as api.json. IDs only —
// no pricing is ever derived from these endpoints. Two jobs:
//
//   1. Withdrawn-but-priced (Go): models present in the pricing snapshot but
//      absent from liveness get a deduped warning "priced but not serving:
//      <id>". The Go endpoint covers the full catalog so catalog-diff is valid
//      there. Scoping (#98): the Go check diffs opencode-go-priced ids against
//      Go serving.
//      Withdrawn-by-shrinkage (Zen, #100): the per-key Zen endpoint serves a
//      subset of the catalog (29 of 102), so priced-minus-serving is catalog
//      divergence, NOT withdrawal. Zen alerts ONLY on shrinkage: ids present
//      in the PRIOR Zen serving snapshot but absent now (was-serving → gone).
//      First run with no prior Zen serving snapshot saves the current serving
//      set silently as the baseline (no alerts, no flood).
//   2. Outage-vs-quota: when liveness (Go and/or Zen) and usage both fail the
//      provider is likely down ("provider outage suspected"); a usage-only
//      failure is a quota/auth issue, not an outage. See classifyOutage().
//
// Best-effort, never throws. ETag + 15s timeout like the other watchers.
//
// v0.18.0 (#107): withdrawn ids ride the model-change table (ONE model_change
// line each: JSONL `withdrawn` event + alerts.log/changelog + Discord table)
// instead of a bare warning, so all five surfaces agree. The per-id hourly
// warning dedup becomes the table's per-model 24h dedup — consistent with
// every other model change.

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

// Pure: build the Zen-priced id set (#98). `zenModels` is the api.json
// opencode-provider BILLABLE set (price-watch `zenModels`: id array or id→entry
// map); `freeModels` is the snapshot free-model list (id array or id→entry
// map). Returns the deduped union: Zen-billable + free ids. Go
// (opencode-go-priced) ids must NEVER be passed in here — Go-vs-Zen catalog
// divergence is expected, not a withdrawal. Reserved snapshot keys
// (freeModels/modelPrivacy/zenModels) are dropped when a whole snapshot map is
// passed as `zenModels`. Never throws.
function buildZenPricedSet(zenModels, freeModels) {
  try {
    const out = [];
    const seen = new Set();
    const pushIds = (src) => {
      let ids;
      if (Array.isArray(src)) {
        ids = src;
      } else if (src && typeof src === 'object') {
        ids = Object.keys(src).filter((k) => k !== 'freeModels' && k !== 'modelPrivacy' && k !== 'zenModels');
      } else {
        return;
      }
      for (const id of ids) {
        if (typeof id === 'string' && id.length && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    };
    pushIds(zenModels);
    pushIds(freeModels);
    return out;
  } catch (_) {
    return [];
  }
}

// Pure: priced-but-absent diff. `pricedIds` and `servingIds` are arrays (or a
// priced map object — keys are used). Returns the withdrawn ids: priced but
// not present in liveness. Used by the Go path only (Go endpoint covers the
// full catalog, so catalog-diff is valid there).
function computeWithdrawn(pricedIds, servingIds) {
  const priced = Array.isArray(pricedIds) ? pricedIds : Object.keys(pricedIds || {});
  const serving = new Set(Array.isArray(servingIds) ? servingIds : []);
  return priced.filter((id) => typeof id === 'string' && id.length && !serving.has(id));
}

// Pure: serving-shrinkage diff (#100). `priorIds` and `currentIds` are both
// serving-snapshot id arrays. Returns ids that were serving before but are
// gone now (was-serving → gone). Used by the Zen path only: the per-key Zen
// endpoint serves a subset of the catalog, so catalog divergence must never
// alert — only genuine shrinkage. Never throws.
function computeShrinkage(priorIds, currentIds) {
  const prior = Array.isArray(priorIds) ? priorIds : [];
  const current = new Set(Array.isArray(currentIds) ? currentIds : []);
  return prior.filter((id) => typeof id === 'string' && id.length && !current.has(id));
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
// Go endpoint so the Go path is untouched. `opts.shrinkageOnly` (Zen, #100)
// switches withdrawn to prior-serving-minus-current (both from endpoint
// snapshots) instead of priced-minus-serving, and seeds the baseline silently
// when no prior serving snapshot exists. Never throws.
async function runLivenessWatchWith(stateDir, authJsonPath, pricedModels, usageStatus, usageError, opts) {
  const url = (opts && opts.url) || LIVENESS_URL;
  const etagName = (opts && opts.etagFile) || ETAG_FILE;
  const snapName = (opts && opts.snapFile) || SNAP_FILE;
  const dedupPrefix = (opts && opts.dedupPrefix) || 'liveness:missing:';
  const shrinkageOnly = !!(opts && opts.shrinkageOnly);
  const etagFile = path.join(stateDir, etagName);
  const snapFile = path.join(stateDir, snapName);
  const pricedIds = Array.isArray(pricedModels) ? pricedModels : Object.keys(pricedModels || {}).filter((k) => k !== 'freeModels' && k !== 'modelPrivacy' && k !== 'zenModels');

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
    if (shrinkageOnly) {
      // Serving set unchanged per ETag — no shrinkage possible.
      return { status: 'unchanged', servingIds, withdrawn: [], changes: [] };
    }
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

  if (shrinkageOnly) {
    // Zen shrinkage-only (#100): withdrawn = prior serving − current serving.
    // No prior serving snapshot → seed the baseline silently (save current,
    // no alerts, no flood). The priced set is intentionally ignored here: the
    // per-key endpoint serves a subset of the catalog, so priced-minus-serving
    // is divergence, not withdrawal.
    let priorIds = null;
    try {
      const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      if (snap && Array.isArray(snap.ids)) priorIds = snap.ids;
    } catch (_) {
      priorIds = null;
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

    if (!priorIds) {
      return {
        status: 'ok',
        servingIds,
        withdrawn: [],
        changes: [],
        outage: classifyOutage('ok', usageStatus || 'unknown', null, usageError)
      };
    }

    const withdrawn = computeShrinkage(priorIds, servingIds);
    const changes = [];
    for (const id of withdrawn) {
      changes.push(`was serving, now gone: ${id}`);
    }
    if (withdrawn.length) {
      try {
        await delivery.deliverModelChangeTable(withdrawn.map((id) => ({ subtype: 'withdrawn', model: id })));
      } catch (_) {
        // best effort
      }
    }
    return {
      status: 'ok',
      servingIds,
      withdrawn,
      changes,
      outage: classifyOutage('ok', usageStatus || 'unknown', null, usageError)
    };
  }

  const withdrawn = computeWithdrawn(pricedIds, servingIds);
  const changes = [];

  for (const id of withdrawn) {
    changes.push(`priced but not serving: ${id}`);
  }
  if (withdrawn.length) {
    try {
      await delivery.deliverModelChangeTable(withdrawn.map((id) => ({ subtype: 'withdrawn', model: id })));
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

// Zen mirror (v0.15.0, #96; scoped v0.15.1, #98; shrinkage-only v0.15.2,
// #100): same Bearer key, own ETag + snapshot files so the two endpoints never
// clobber each other. Withdrawn is serving-shrinkage only (prior Zen serving
// snapshot minus current serving) — catalog divergence never alerts, and the
// first run with no prior snapshot seeds the baseline silently. Callers still
// pass the Zen-priced + free set (see buildZenPricedSet) for signature
// compatibility, but it is ignored for withdrawn computation. Dedup prefix
// bumped to liveness-zen3: so the corrected logic starts clean instead of
// staying suppressed by the old keys.
async function runZenLivenessWatch(stateDir, authJsonPath, pricedModels, usageStatus, usageError) {
  return runLivenessWatchWith(stateDir, authJsonPath, pricedModels, usageStatus, usageError, {
    url: ZEN_LIVENESS_URL,
    etagFile: ZEN_ETAG_FILE,
    snapFile: ZEN_SNAP_FILE,
    dedupPrefix: 'liveness-zen3:missing:',
    shrinkageOnly: true
  });
}

module.exports = {
  runLivenessWatch,
  runZenLivenessWatch,
  buildZenPricedSet,
  extractServingIds,
  computeWithdrawn,
  computeShrinkage,
  classifyOutage,
  LIVENESS_URL,
  ZEN_LIVENESS_URL
};
