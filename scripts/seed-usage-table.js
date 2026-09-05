'use strict';

// v0.10.0: one-time seed of real per-model usage caps into src/usage-table.json.
//
// The public, structured pricing source (ocgo-pricing.all-the.rest) carries a
// per-model `usage` field = the monthly USD cap the $60 opencode-go credit is
// effectively spent against. A model at $15 cap costs 4x its list price to get
// equivalent coverage; one at $100 cap costs 0.6x. The live api.json catalog
// has NO per-model usage-cap field, so this table is the maintained source of
// truth (see src/usage-table.json / GAPS.md).
//
// This is a BUILD/DEV-TIME script only — it is NOT run every monitor cycle, so
// the live monitor never blocks or fails on an external scrape. It is best-effort:
// if the fetch fails (offline, upstream down), it leaves src/usage-table.json
// untouched (defaults stand) and exits 0. If the fetch succeeds, it rewrites the
// `models` map with the real caps and records the source URL + fetch date in
// `_meta`. It also best-effort primes state/usage-caps.json so the NEXT monitor
// cycle does not treat every freshly-seeded cap as a sudden downgrade (avoids a
// one-time alert flood on the seeding run).
//
// Re-run whenever you suspect the caps have drifted:
//   node scripts/seed-usage-table.js

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const usageTable = require('../src/usage-table');

const SOURCE_URL = 'https://ocgo-pricing.all-the.rest/data/latest.json';
const TABLE_PATH = path.join(repoRoot, 'src', 'usage-table.json');
const STATE_CAPS_PATH = path.join(repoRoot, 'state', 'usage-caps.json');

// Strip the opencode-go/ prefix the pricing source uses so the keys match the
// api.json catalog ids (e.g. "opencode-go/grok-4.6" -> "grok-4.6").
function stripPrefix(id) {
  return String(id == null ? '' : id).startsWith('opencode-go/')
    ? String(id).slice('opencode-go/'.length)
    : String(id);
}

// Pure: build { apiId: cap } from a latest.json payload. Tiers of the same model
// share one cap, so the first valid occurrence wins; non-positive / non-finite
// usage values are skipped (the model keeps the default cap). Exported for tests.
function buildModelsMap(data) {
  const out = {};
  if (!data || !Array.isArray(data.models)) return out;
  for (const m of data.models) {
    if (!m || m.id == null) continue;
    const cap = Number(m.usage);
    if (!isFinite(cap) || cap <= 0) continue;
    const key = stripPrefix(m.id);
    if (!(key in out)) out[key] = cap; // first occurrence wins (tiers share cap)
  }
  return out;
}

// Pure: assemble the full usage-table document from a payload. Exported for tests.
function buildTable(data, fetchedAt) {
  const models = buildModelsMap(data);
  return {
    _meta: {
      description:
        'Per-model monthly usage cap (USD) used to compute effective price after the $60 ' +
        'credit multiplier. Seeded from the public structured pricing source; the live api.json ' +
        'catalog carries NO per-model usage-cap field, so this table is the maintained source of truth. ' +
        'Effective price = list price x (MONTHLY_CREDIT / cap).',
      defaultCap: usageTable.DEFAULT_CAP,
      monthlyCredit: usageTable.MONTHLY_CREDIT,
      capTiers: usageTable.CAP_TIERS,
      maintained: true,
      source: SOURCE_URL,
      seededAt: fetchedAt || new Date().toISOString(),
      note:
        'Add/override an entry in `models` to pin a model to a non-default cap. ' +
        'Unknown models fall back to the default cap (60 -> 1x effective). ' +
        'Re-run scripts/seed-usage-table.js to refresh from the public source (best-effort).'
    },
    models
  };
}

// Best-effort: rewrite src/usage-table.json with the seeded caps + provenance.
function writeTable(table, outPath) {
  fs.writeFileSync(outPath || TABLE_PATH, JSON.stringify(table, null, 2) + '\n');
}

// Best-effort: prime the runtime cap snapshot so a freshly-seeded cap is NOT
// reported as a sudden downgrade on the next monitor cycle.
function primeRuntimeCaps(models) {
  try {
    fs.mkdirSync(path.dirname(STATE_CAPS_PATH), { recursive: true });
    // Merge with any existing entries so a re-seed only changes what it knows.
    let prev = {};
    try {
      const raw = fs.readFileSync(STATE_CAPS_PATH, 'utf8');
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') prev = p;
    } catch (_) {}
    const next = Object.assign({}, prev);
    for (const k of Object.keys(models)) next[k] = models[k];
    fs.writeFileSync(STATE_CAPS_PATH, JSON.stringify(next));
  } catch (_) {
    // best effort — never block the seed
  }
}

async function fetchLatest(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function main() {
  const outPath = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : TABLE_PATH;
  try {
    const data = await fetchLatest(SOURCE_URL);
    const table = buildTable(data);
    writeTable(table, outPath);
    if (outPath === TABLE_PATH) primeRuntimeCaps(table.models);
    const n = Object.keys(table.models).length;
    console.log(`Seeded ${n} usage cap(s) from ${SOURCE_URL}`);
    console.log(`Wrote ${path.relative(repoRoot, outPath)} — ${n} model(s) mapped.`);
  } catch (e) {
    // Best-effort: keep defaults, exit 0 so a CI/build step never breaks.
    console.error('Seed skipped (fetch failed, keeping defaults): ' + (e && e.message ? e.message : e));
    process.exit(0);
  }
}

module.exports = { buildModelsMap, buildTable, stripPrefix, writeTable, primeRuntimeCaps, SOURCE_URL };

if (require.main === module) {
  main().catch((e) => {
    console.error('Seed failed:', e && e.message ? e.message : e);
    process.exit(0);
  });
}
