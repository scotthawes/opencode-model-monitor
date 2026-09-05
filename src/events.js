'use strict';

// Event-sourced model-change history (v0.8.0, #73).
//
// The JSONL event log is the SOURCE OF TRUTH for "what happened to a model".
// Each line is one immutable fact:
//
//   { "ts": "<ISO>", "type": "added|removed|cost-changed|tiers-changed
//                      |free-available|free-changed|free-removed",
//     "model": "<id>", "old": <prev cost/tiers|null>, "new": <next cost/tiers|null> }
//
// Files rotate monthly: state/events-YYYY-MM.jsonl (UTC month of the event's
// ts). A model's full life = every event whose `model` matches, across all
// month files, sorted by ts.
//
// Design notes (see GAPS.md "Event-sourced history"):
//  - append-only: add/drop/change are all just appends — no read-modify-write
//    of a big array, no rewrite cost when a catalog churns.
//  - best-effort: a failed append NEVER throws or blocks alerts / snapshots.
//  - an in-process signature Set dedupes same-run double writes (e.g. the
//    price-watch detection path AND the delivery funnel both call appendChanges),
//    so the log carries exactly one record per change.

const fs = require('fs');
const path = require('path');

// Matches monthly rotation files: events-2026-09.jsonl
const EVENT_RE = /^events-(\d{4})-(\d{2})\.jsonl$/;

// In-process dedup for the current monitor run (prevents dual-write duplicates
// without any file I/O on the hot path).
const recentSigs = new Set();

function eventsFileFor(ts) {
  const d = ts ? new Date(ts) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `events-${y}-${m}.jsonl`;
}

function sigOf(rec) {
  // Exact record identity — ts|type|model|old|new. Used only for dedup.
  return JSON.stringify([rec.ts, rec.type, rec.model, rec.old, rec.new]);
}

// Append a single event to the correct month's JSONL file.
// ev: { ts?, type, model?, old?, new? }. Best-effort — never throws.
function appendEvent(stateDir, ev) {
  if (!stateDir || !ev || !ev.type) return;
  const rec = {
    ts: ev.ts || new Date().toISOString(),
    type: ev.type,
    model: ev.model != null ? String(ev.model) : null,
    old: ev.old !== undefined ? ev.old : null,
    new: ev.new !== undefined ? ev.new : null
  };
  const sig = sigOf(rec);
  if (recentSigs.has(sig)) return; // same-run dual-write → skip
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, eventsFileFor(rec.ts));
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    recentSigs.add(sig);
  } catch (_) {
    // best effort — never throw, never block the caller
  }
}

// List monthly event files in chronological order (oldest month first).
function listEventFiles(stateDir) {
  let files = [];
  try {
    files = fs.readdirSync(stateDir).filter((f) => EVENT_RE.test(f));
  } catch (_) {
    return [];
  }
  files.sort();
  return files;
}

// Read events, optionally filtered by { model, type }. Returns a ts-sorted array.
function readEvents(stateDir, filter) {
  filter = filter || {};
  const out = [];
  for (const f of listEventFiles(stateDir)) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(stateDir, f), 'utf8').split('\n');
    } catch (_) {
      continue;
    }
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const ev = JSON.parse(ln);
        if (filter.model != null && ev.model !== filter.model) continue;
        if (filter.type != null && ev.type !== filter.type) continue;
        out.push(ev);
      } catch (_) {
        // skip corrupt line
      }
    }
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

// A model's full life: every event for `model`, ts-sorted (oldest → newest).
function getModelLife(stateDir, model) {
  return readEvents(stateDir, { model });
}

// Map a model-change descriptor (from price-watch / delivery) to a JSONL event
// record. Returns null for descriptors we don't model (e.g. feed updates).
function eventForChange(ch) {
  if (!ch || !ch.subtype) return null;
  const base = { model: ch.model };
  switch (ch.subtype) {
    case 'added':
      return Object.assign({}, base, { type: 'added', old: null, new: ch.cost != null ? ch.cost : null });
    case 'removed':
      return Object.assign({}, base, { type: 'removed', old: ch.cost != null ? ch.cost : null, new: null });
    case 'cost':
      return Object.assign({}, base, {
        type: 'cost-changed',
        old: ch.oldCost != null ? ch.oldCost : null,
        new: ch.newCost != null ? ch.newCost : null
      });
    case 'tiers':
      return Object.assign({}, base, {
        type: 'tiers-changed',
        old: ch.oldTiers != null ? ch.oldTiers : null,
        new: ch.newTiers != null ? ch.newTiers : null
      });
    case 'free':
      if (ch.reason === 'removed')
        return Object.assign({}, base, { type: 'free-removed', old: ch.cost != null ? ch.cost : null, new: null });
      if (ch.reason === 'changed')
        return Object.assign({}, base, {
          type: 'free-changed',
          old: ch.cost != null ? ch.cost : null,
          new: ch.cost != null ? ch.cost : null
        });
      return Object.assign({}, base, { type: 'free-available', old: null, new: ch.cost != null ? ch.cost : null });
    default:
      return null;
  }
}

// Append events for an array of model-change descriptors (best-effort each).
function appendChanges(stateDir, changes) {
  if (!Array.isArray(changes)) return;
  for (const ch of changes) {
    const ev = eventForChange(ch);
    if (ev) appendEvent(stateDir, ev);
  }
}

// --- One-time migration from the legacy changelog -------------------------
//
// Import `model_change` pricing events from state/changelog.json into the JSONL
// log. Guarded by a .events-migrated marker so re-running is a no-op. Feed-update
// entries (title "Feed update: ...") are not pricing events and are skipped.
// Deduped by ts|model|type (each changelog entry already has a unique ts).
const MIGRATION_RE = {
  cost: /^Cost changed for (\S+): ([\s\S]*) -> ([\s\S]*)$/,
  added: /^Added model: (\S+)$/,
  removed: /^Removed model: (\S+)$/,
  tiers: /^Tiers changed for (\S+)$/,
  freeAvail: /^Free model available: (\S+)$/,
  freeChanged: /^Free model changed: (\S+)$/,
  freeRemoved: /^Free model removed: (\S+)$/
};

function parseChangelogMessage(msg) {
  let m;
  if ((m = MIGRATION_RE.cost.exec(msg || ''))) {
    let oldC = null;
    let newC = null;
    try {
      oldC = JSON.parse(m[2]);
    } catch (_) {}
    try {
      newC = JSON.parse(m[3]);
    } catch (_) {}
    return { type: 'cost-changed', model: m[1], old: oldC, new: newC };
  }
  if ((m = MIGRATION_RE.added.exec(msg || ''))) return { type: 'added', model: m[1], new: null };
  if ((m = MIGRATION_RE.removed.exec(msg || ''))) return { type: 'removed', model: m[1], old: null };
  if ((m = MIGRATION_RE.tiers.exec(msg || ''))) return { type: 'tiers-changed', model: m[1] };
  if ((m = MIGRATION_RE.freeAvail.exec(msg || ''))) return { type: 'free-available', model: m[1] };
  if ((m = MIGRATION_RE.freeChanged.exec(msg || ''))) return { type: 'free-changed', model: m[1] };
  if ((m = MIGRATION_RE.freeRemoved.exec(msg || ''))) return { type: 'free-removed', model: m[1] };
  return null; // Feed update or other non-pricing event
}

function migrateFromChangelog(stateDir) {
  const marker = path.join(stateDir, '.events-migrated');
  try {
    if (fs.existsSync(marker)) return { skipped: true, reason: 'marker-exists' };
  } catch (_) {}

  let changelog = [];
  try {
    changelog = JSON.parse(fs.readFileSync(path.join(stateDir, 'changelog.json'), 'utf8'));
    if (!Array.isArray(changelog)) changelog = [];
  } catch (_) {
    changelog = [];
  }

  let imported = 0;
  for (const e of changelog) {
    if (!e || e.level !== 'model_change') continue;
    const parsed = parseChangelogMessage(e.message);
    if (!parsed) continue; // skip feed updates / non-pricing
    appendEvent(stateDir, {
      ts: e.ts || new Date().toISOString(),
      model: parsed.model,
      type: parsed.type,
      old: parsed.old,
      new: parsed.new
    });
    imported++;
  }

  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (_) {}
  return { skipped: false, imported };
}

// Reset in-process dedup state (used by tests to isolate runs).
function _resetDedup() {
  recentSigs.clear();
}

module.exports = {
  appendEvent,
  readEvents,
  getModelLife,
  eventForChange,
  appendChanges,
  migrateFromChangelog,
  eventsFileFor,
  listEventFiles,
  _resetDedup
};
