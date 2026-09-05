'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

const API_URL = 'https://models.opencode.ai/api.json';

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

// Fetches the authoritative pricing catalog for the opencode-go provider,
// diffs it against the previous snapshot, and alerts on any model change.
// Returns { status, models, changes, modelCount, error }.
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
    return { status: 'unchanged', models: readSnapshot(snapFile), changes: [] };
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

  const og = (data && data['opencode-go']) || null;
  const modelsRaw = (og && og.models) || {};
  if (!modelsRaw || typeof modelsRaw !== 'object' || Object.keys(modelsRaw).length === 0) {
    // Live data shape is wrong (opencode-go missing, or models empty) despite a
    // 200-OK. Treat as a fetch failure: alert + no diff. Critically, do NOT
    // overwrite the prior good snapshot, so we never report every model as
    // removed on a transient upstream glitch.
    delivery.alert(
      'warning',
      'Pricing data empty',
      'opencode-go models missing/empty on 200-OK; treating as fetch-failed (no diff kept)'
    );
    return { status: 'unknown', error: 'empty live data', models: readSnapshot(snapFile), changes: [] };
  }
  const modelsMap = {};
  for (const id of Object.keys(modelsRaw)) {
    const m = modelsRaw[id] || {};
    modelsMap[id] = { cost: m.cost || null, tiers: m.tiers || null };
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

  const prevIds = prevValid ? new Set(Object.keys(prev)) : new Set();
  const newIds = new Set(Object.keys(modelsMap));
  const changes = [];
  // Structured descriptors for the aggregated Discord model-change table.
  const modelChanges = [];

  if (prevValid) {
    for (const id of newIds) {
      if (!prevIds.has(id)) {
        changes.push(`Added model: ${id}`);
        modelChanges.push({ subtype: 'added', model: id, cost: (modelsMap[id] || {}).cost || null });
      } else {
        const a = prev[id] || {};
        const b = modelsMap[id] || {};
        if (JSON.stringify(a.cost) !== JSON.stringify(b.cost)) {
          changes.push(`Cost changed for ${id}: ${JSON.stringify(a.cost)} -> ${JSON.stringify(b.cost)}`);
          modelChanges.push({ subtype: 'cost', model: id, oldCost: a.cost || null, newCost: b.cost || null });
        }
        if (JSON.stringify(a.tiers) !== JSON.stringify(b.tiers)) {
          changes.push(`Tiers changed for ${id}`);
          modelChanges.push({ subtype: 'tiers', model: id });
        }
      }
    }
    for (const id of prevIds) {
      if (!newIds.has(id)) {
        changes.push(`Removed model: ${id}`);
        modelChanges.push({ subtype: 'removed', model: id });
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

  try {
    fs.writeFileSync(snapFile, JSON.stringify(modelsMap, null, 2));
    if (newEtag) fs.writeFileSync(etagFile, newEtag);
  } catch (e) {
    delivery.alert('warning', 'Pricing snapshot save failed', String(e && e.message ? e.message : e));
  }

  // Persist the time-series sample (additive change; never blocks the alert
  // path). Only reached on a successful, non-empty price fetch.
  appendPriceHistory(stateDir, modelsMap);

  // alerts.log still gets the human-readable single lines, while Discord gets a
  // single aggregated table post (old->new per metric) instead of N one-liners.
  if (modelChanges.length) {
    delivery.deliverModelChangeTable(modelChanges);
  }

  return {
    status: 'ok',
    models: modelsMap,
    changes,
    modelCount: newIds.size
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

module.exports = { runPriceWatch, appendPriceHistory };
