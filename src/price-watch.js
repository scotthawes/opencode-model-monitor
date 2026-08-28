'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

const API_URL = 'https://models.opencode.ai/api.json';

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
  const modelsMap = {};
  for (const id of Object.keys(modelsRaw)) {
    const m = modelsRaw[id] || {};
    modelsMap[id] = { cost: m.cost || null, tiers: m.tiers || null };
  }

  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(snapFile, 'utf8')) || {};
  } catch (_) {}

  const prevIds = new Set(Object.keys(prev));
  const newIds = new Set(Object.keys(modelsMap));
  const changes = [];

  for (const id of newIds) {
    if (!prevIds.has(id)) {
      changes.push(`Added model: ${id}`);
    } else {
      const a = prev[id] || {};
      const b = modelsMap[id] || {};
      if (JSON.stringify(a.cost) !== JSON.stringify(b.cost)) {
        changes.push(`Cost changed for ${id}: ${JSON.stringify(a.cost)} -> ${JSON.stringify(b.cost)}`);
      }
      if (JSON.stringify(a.tiers) !== JSON.stringify(b.tiers)) {
        changes.push(`Tiers changed for ${id}`);
      }
    }
  }
  for (const id of prevIds) {
    if (!newIds.has(id)) changes.push(`Removed model: ${id}`);
  }

  try {
    fs.writeFileSync(snapFile, JSON.stringify(modelsMap, null, 2));
    if (newEtag) fs.writeFileSync(etagFile, newEtag);
  } catch (e) {
    delivery.alert('warning', 'Pricing snapshot save failed', String(e && e.message ? e.message : e));
  }

  if (changes.length) {
    for (const c of changes) delivery.alert('model_change', 'Model changed', c);
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

module.exports = { runPriceWatch };
