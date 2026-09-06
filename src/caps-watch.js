'use strict';

// Live usage-cap polling (v0.13.0, #92).
//
// src/usage-table.json was seed-only (scripts/seed-usage-table.js, manual
// re-run) so caps drifted stale. This module polls the public structured
// pricing source https://ocgo-pricing.all-the.rest/data/latest.json with ETag
// (state/.etag-caps, gitignored) + 15s timeout, on the same 30min c.pricing
// cadence as api.json (it rides alongside catalog/liveness).
//
// Pipeline per cycle (best-effort, never throws):
//   1. Fetch latest.json with If-None-Match. 304 -> unchanged (keep table).
//      Fetch/HTTP/parse/shape failure -> hourly-deduped warning, keep table.
//   2. Parse models[].{id,usage} into a caps map: strip the opencode-go/
//      prefix, first occurrence wins (tiers share one cap), skip
//      non-positive/non-finite usage. Ids are fuzzy-matched against the
//      existing table keys (case/separator-insensitive) so a rename files
//      under the existing key; truly new ids are logged at debug.
//   3. On caps change vs src/usage-table.json: rewrite the table file with
//      source:live + fetchedAt provenance. Entries absent from live are kept
//      when still priced (last pricing snapshot) so a dropped feed row never
//      false-fires a "moved to default" alert, and dropped otherwise.
//   4. Alerting rides the EXISTING price-watch cap detector: monitor.js runs
//      caps-watch BEFORE price-watch in cycle order, and the in-memory
//      usage-table cache is busted after a rewrite, so refreshed caps flow
//      through computeCapChanges/detectCapChanges exactly once. This module
//      never emits model_change itself (no duplicate alerts).

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');
const usageTable = require('./usage-table');

const CAPS_URL = 'https://ocgo-pricing.all-the.rest/data/latest.json';
const TIMEOUT_MS = 15000;
const ETAG_FILE = '.etag-caps';
const TABLE_FILE = 'usage-table.json';
const WARN_TTL_MS = 3600000; // hourly dedup for fetch/parse warnings

// Strip the opencode-go/ prefix the pricing source uses so keys match the
// api.json catalog ids (e.g. "opencode-go/grok-4.6" -> "grok-4.6").
function stripPrefix(id) {
  const s = String(id == null ? '' : id);
  return s.startsWith('opencode-go/') ? s.slice('opencode-go/'.length) : s;
}

// Fuzzy key: lowercase + separators (underscore/colon/whitespace) folded to
// '-', so "Grok_4.6", "grok 4.6" and "grok-4.6" compare equal. Used only to
// match a live id against an existing table key; the stored key is always the
// existing table key (or the stripped live id for brand-new models).
function normalizeId(id) {
  return stripPrefix(id).toLowerCase().replace(/[_\s:]+/g, '-');
}

// Pure: build { strippedId: cap } from a latest.json payload. First valid
// occurrence wins (tiers of the same model share one cap); non-positive /
// non-finite usage values are skipped. Returns { map, skipped }.
function buildCapsMap(data) {
  const map = {};
  let skipped = 0;
  if (!data || !Array.isArray(data.models)) return { map, skipped };
  for (const m of data.models) {
    if (!m || m.id == null) {
      skipped++;
      continue;
    }
    const cap = Number(m.usage);
    if (!isFinite(cap) || cap <= 0) {
      skipped++;
      continue;
    }
    const key = stripPrefix(m.id);
    if (!(key in map)) map[key] = cap;
  }
  return { map, skipped };
}

// Pure: match a stripped live id against existing table keys. Exact hit wins;
// otherwise the first key whose normalized form equals the normalized live id
// (rename/case drift). Returns the existing key or null.
function matchLocalId(stripped, existingKeys) {
  if (Object.prototype.hasOwnProperty.call(existingKeys || {}, stripped)) return stripped;
  const want = normalizeId(stripped);
  for (const k of Object.keys(existingKeys || {})) {
    if (normalizeId(k) === want) return k;
  }
  return null;
}

// Pure: diff a live caps map against the current table models. `pricedIds` is
// a Set of last-known-priced model ids (from pricing-snapshot.json) or null
// when unknown (conservative: keep all stale entries). Returns
// { models, added, updated, keptStale, dropped, unmatched } where models is
// the merged next table map, added/updated carry { id, oldCap, newCap }.
function computeTableUpdate(existingModels, liveMap, pricedIds) {
  const existing = existingModels && typeof existingModels === 'object' ? existingModels : {};
  const live = liveMap && typeof liveMap === 'object' ? liveMap : {};
  const models = {};
  const added = [];
  const updated = [];
  const unmatched = [];
  const covered = new Set();

  for (const stripped of Object.keys(live)) {
    const key = matchLocalId(stripped, existing) || stripped;
    covered.add(key);
    models[key] = live[stripped];
    if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      added.push({ id: key, oldCap: null, newCap: live[stripped] });
      if (key !== stripped) {
        // Filed under an existing key via fuzzy match — not truly new, but
        // worth a debug line (rename drift).
        unmatched.push(stripped + ' -> ' + key);
      } else {
        unmatched.push(stripped);
      }
    } else if (Number(existing[key]) !== live[stripped]) {
      updated.push({ id: key, oldCap: Number(existing[key]), newCap: live[stripped] });
    }
  }

  // Entries absent from live: keep when still priced (never false-fire a
  // "moved to default" alert on a dropped feed row), drop when neither live
  // nor priced (dead model, gone from both feeds).
  const keptStale = [];
  const dropped = [];
  for (const k of Object.keys(existing)) {
    if (covered.has(k)) continue;
    if (!pricedIds || pricedIds.has(k)) {
      models[k] = existing[k];
      keptStale.push(k);
    } else {
      dropped.push({ id: k, oldCap: Number(existing[k]) });
    }
  }

  return { models, added, updated, keptStale, dropped, unmatched };
}

// Best-effort: read the current table doc { meta, models } from disk. Never
// throws; returns nulls when missing/invalid.
function readTableDoc(tablePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { meta: null, models: {} };
    const models =
      parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)
        ? parsed.models
        : {};
    const meta = parsed._meta && typeof parsed._meta === 'object' ? parsed._meta : null;
    return { meta, models };
  } catch (_) {
    return { meta: null, models: {} };
  }
}

// Best-effort: last-known-priced model ids from pricing-snapshot.json (keys
// whose value is an object carrying `cost`). Returns a Set, or null when the
// snapshot is missing/unreadable (caller treats null as "unknown, keep stale").
function readPricedIds(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'pricing-snapshot.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const ids = new Set();
    for (const k of Object.keys(parsed)) {
      const v = parsed[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'cost' in v) ids.add(k);
    }
    return ids;
  } catch (_) {
    return null;
  }
}

// Poll the live caps feed and refresh src/usage-table.json on change.
// `opts.tablePath` overrides the table location (tests). Never throws;
// always resolves { status: 'ok'|'unchanged'|'unknown', ... }.
async function runCapsWatch(stateDir, opts) {
  opts = opts || {};
  const tablePath = opts.tablePath || path.join(__dirname, TABLE_FILE);
  const etagFile = path.join(stateDir, ETAG_FILE);

  try {
    let etag = null;
    try {
      etag = fs.readFileSync(etagFile, 'utf8').trim() || null;
    } catch (_) {}

    const headers = {};
    if (etag) headers['If-None-Match'] = etag;

    let res;
    try {
      res = await fetch(CAPS_URL, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (e) {
      delivery.alert('warning', 'Caps fetch failed', String((e && e.message) || e), {
        dedupKey: 'caps:fetch',
        dedupTtlMs: WARN_TTL_MS
      });
      return { status: 'unknown', error: String((e && e.message) || e), changes: [] };
    }

    if (res.status === 304) {
      const { models } = readTableDoc(tablePath);
      return { status: 'unchanged', modelCount: Object.keys(models).length, changes: [] };
    }

    if (!res.ok) {
      delivery.alert('warning', `Caps fetch HTTP ${res.status}`, CAPS_URL, {
        dedupKey: 'caps:http',
        dedupTtlMs: WARN_TTL_MS
      });
      return { status: 'unknown', error: `HTTP ${res.status}`, changes: [] };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      delivery.alert('warning', 'Caps JSON parse failed', String((e && e.message) || e), {
        dedupKey: 'caps:parse',
        dedupTtlMs: WARN_TTL_MS
      });
      return { status: 'unknown', error: 'parse', changes: [] };
    }

    const { map: liveMap } = buildCapsMap(data);
    if (Object.keys(liveMap).length === 0) {
      // An empty/invalid models list must never wipe the table.
      delivery.alert('warning', 'Caps shape unexpected', 'latest.json carries no usable models[].usage entries; keeping existing table', {
        dedupKey: 'caps:shape',
        dedupTtlMs: WARN_TTL_MS
      });
      return { status: 'unknown', error: 'empty caps map', changes: [] };
    }

    const { meta, models: existing } = readTableDoc(tablePath);
    const pricedIds = readPricedIds(stateDir);
    const update = computeTableUpdate(existing, liveMap, pricedIds);

    if (update.added.length === 0 && update.updated.length === 0 && update.dropped.length === 0) {
      try {
        delivery.debug(
          `caps unchanged (${Object.keys(update.models).length} models)` +
            (update.keptStale.length ? `; stale kept: ${update.keptStale.join(',')}` : '') +
            (update.unmatched.length ? `; unmatched: ${update.unmatched.join(',')}` : '')
        );
      } catch (_) {}
      return { status: 'unchanged', modelCount: Object.keys(update.models).length, changes: [] };
    }

    const fetchedAt = new Date().toISOString();
    const doc = {
      _meta: Object.assign(
        {
          description:
            'Per-model monthly usage cap (USD) used to compute effective price after the $60 ' +
            'credit multiplier. Refreshed live from the public structured pricing source; the live api.json ' +
            'catalog carries NO per-model usage-cap field, so this table is the maintained source of truth. ' +
            'Effective price = list price x (MONTHLY_CREDIT / cap).',
          defaultCap: usageTable.DEFAULT_CAP,
          monthlyCredit: usageTable.MONTHLY_CREDIT,
          capTiers: usageTable.CAP_TIERS,
          maintained: true,
          note:
            'Add/override an entry in `models` to pin a model to a non-default cap. ' +
            'Unknown models fall back to the default cap (60 -> 1x effective). ' +
            'Refreshed automatically by caps-watch each monitor cycle (best-effort).'
        },
        meta || {},
        {
          source: 'live',
          sourceUrl: CAPS_URL,
          fetchedAt,
          seededAt: (meta && meta.seededAt) || fetchedAt
        }
      ),
      models: update.models
    };

    try {
      fs.writeFileSync(tablePath, JSON.stringify(doc, null, 2) + '\n');
    } catch (e) {
      delivery.alert('warning', 'Caps table save failed', String((e && e.message) || e), {
        dedupKey: 'caps:save',
        dedupTtlMs: WARN_TTL_MS
      });
      return { status: 'unknown', error: 'save failed', changes: [] };
    }

    // Bust the in-memory usage-table cache so price-watch (which runs AFTER
    // caps-watch in cycle order) diffs the refreshed caps through the existing
    // cap detector exactly once.
    try {
      usageTable.setTable(null);
    } catch (_) {}

    const changes = [];
    for (const u of update.updated) changes.push(`Quota source refreshed: ${u.id} $${u.oldCap} -> $${u.newCap}`);
    for (const a of update.added) changes.push(`Quota source added: ${a.id} $${a.newCap}`);
    for (const d of update.dropped) changes.push(`Quota source dropped: ${d.id} (was $${d.oldCap})`);

    try {
      const newEtag = res.headers && res.headers.get ? res.headers.get('etag') : null;
      if (newEtag) fs.writeFileSync(etagFile, newEtag);
    } catch (_) {}

    try {
      delivery.debug(
        `caps refreshed (${Object.keys(update.models).length} models): ` +
          `${update.updated.length} updated, ${update.added.length} added, ${update.dropped.length} dropped` +
          (update.unmatched.length ? `; unmatched: ${update.unmatched.join(',')}` : '') +
          (update.keptStale.length ? `; stale kept (still priced): ${update.keptStale.join(',')}` : '')
      );
    } catch (_) {}

    return {
      status: 'ok',
      modelCount: Object.keys(update.models).length,
      changes,
      moves: {
        updated: update.updated,
        added: update.added,
        dropped: update.dropped,
        keptStale: update.keptStale,
        unmatched: update.unmatched
      }
    };
  } catch (e) {
    // Last-resort guard: caps-watch must never break the monitor cycle.
    try {
      delivery.alert('warning', 'caps-watch failed', String((e && e.message) || e), {
        dedupKey: 'monitor:caps-watch',
        dedupTtlMs: WARN_TTL_MS
      });
    } catch (_) {}
    return { status: 'unknown', error: String((e && e.message) || e), changes: [] };
  }
}

module.exports = {
  runCapsWatch,
  buildCapsMap,
  stripPrefix,
  normalizeId,
  matchLocalId,
  computeTableUpdate,
  readTableDoc,
  readPricedIds,
  CAPS_URL
};
