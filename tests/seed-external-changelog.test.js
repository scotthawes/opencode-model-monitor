'use strict';

// Unit + integration tests for v0.11.0: scripts/seed-external-changelog.js.
//  - the hardcoded external dataset parses to 20+ well-formed events
//  - the seed is idempotent (rerun appends nothing new)
//  - usage caps in src/usage-table.json are pinned with source/date provenance
//  - history.json gains a dated cost point per `added` event (spanning Aug 20+)
//  - page-safety: no secret / personal-substring leaks into any emitted event
//
// No network. Uses temp state dirs + a temp usage-table copy.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const seed = require('../scripts/seed-external-changelog');
const events = require('../src/events');
const backfill = require('../scripts/backfill-history');
const TABLE_PATH = path.join(__dirname, '..', 'src', 'usage-table.json');

const KNOWN_TYPES = new Set([
  'added', 'removed', 'free-available', 'free-removed', 'usage-moved', 'privacy-changed', 'info'
]);

// Forbidden substrings must NEVER appear in emitted events (public docs/ allowlist).
const FORBIDDEN = /auth\.json|config\.json|subscribers\.json|webhook|secret|password|token|gho_|ghp_|api_?key|bearer |bearer-|[\/\\](Users|home|root)[\/\\]/i;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-seed-'));
}

test('buildExternalEvents parses 20+ well-formed events', () => {
  const evs = seed.buildExternalEvents();
  assert.ok(evs.length >= 20, 'expected 20+ events, got ' + evs.length);
  for (const e of evs) {
    assert.ok(KNOWN_TYPES.has(e.type), 'unknown type: ' + e.type);
    assert.ok(typeof e.ts === 'string' && !isNaN(Date.parse(e.ts)), 'bad ts: ' + e.ts);
    // info events may have a null model; everything else needs a string model id.
    if (e.type === 'info') assert.ok(e.model === null || typeof e.model === 'string');
    else assert.ok(typeof e.model === 'string' && e.model.length > 0, 'missing model for ' + e.type);
    // cost-bearing adds carry a numeric cost object.
    if (e.type === 'added') assert.ok(e.new && typeof e.new === 'object', 'added without cost: ' + e.model);
  }
});

test('dataset covers every required event class', () => {
  const types = new Set(seed.buildExternalEvents().map((e) => e.type));
  for (const t of ['added', 'removed', 'free-available', 'free-removed', 'usage-moved', 'privacy-changed', 'info']) {
    assert.ok(types.has(t), 'missing event class: ' + t);
  }
  // free-removed events carry an available-duration string where the tracker gave one.
  const removed = seed.buildExternalEvents().filter((e) => e.type === 'free-removed');
  assert.ok(removed.some((e) => typeof e.duration === 'string' && /day/.test(e.duration)), 'expected a free-removed with a duration');
});

test('page-safe: no secret / personal substrings in any emitted event', () => {
  for (const e of seed.buildExternalEvents()) {
    assert.ok(!FORBIDDEN.test(JSON.stringify(e)), 'forbidden substring in event: ' + JSON.stringify(e));
    for (const k of Object.keys(e)) {
      assert.ok(!['secret', 'webhook', 'token', 'apiKey', 'password'].includes(k), 'forbidden key: ' + k);
    }
  }
});

test('applyCaps pins the caps + provenance without wiping other models', () => {
  const table = {
    _meta: { defaultCap: 60 },
    models: { 'already-there': 15, 'grok-4.6': 15 }
  };
  const res = seed.applyCaps(table);
  assert.strictEqual(res.changed, true, 'should report a change (provenance added)');
  assert.strictEqual(res.table.models['omen-alpha'], 100, 'omen-alpha cap pinned');
  assert.strictEqual(res.table.models['grok-4.6'], 15, 'existing cap preserved');
  assert.strictEqual(res.table.models['already-there'], 15, 'unrelated model preserved');
  const prov = res.table._meta.capsProvenance;
  assert.strictEqual(prov['omen-alpha'].cap, 100);
  assert.strictEqual(prov['omen-alpha'].source, 'ocgo-price-tracker');
  assert.strictEqual(prov['omen-alpha'].date, '2026-09-04');
  // Idempotent: re-applying to the result reports no change.
  const res2 = seed.applyCaps(res.table);
  assert.strictEqual(res2.changed, false, 're-apply should be a no-op');
});

test('seed is idempotent: rerun appends nothing new', async () => {
  const d = tmpDir();
  try {
    const r1 = await seed.run({ stateDir: d, usageTablePath: path.join(d, 'usage-table.json'), dryRun: false });
    assert.ok(r1.writtenCount >= 20, 'first run wrote 20+, got ' + r1.writtenCount);
    assert.ok(r1.totalEvents >= 20, 'timeline has 20+, got ' + r1.totalEvents);
    const afterFirst = events.readEvents(d).length;

    const r2 = await seed.run({ stateDir: d, usageTablePath: path.join(d, 'usage-table.json'), dryRun: false });
    assert.strictEqual(r2.writtenCount, 0, 'second run writes nothing');
    assert.strictEqual(r2.totalEvents, afterFirst, 'event count stable after rerun');
    assert.strictEqual(events.readEvents(d).length, afterFirst, 'no duplicate lines on rerun');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('seed backfills history.json cost points for adds (spanning Aug 20+)', async () => {
  const d = tmpDir();
  try {
    await seed.run({ stateDir: d, usageTablePath: path.join(d, 'usage-table.json'), dryRun: false });
    const hist = backfill.readHistory(d);
    // 11 `added` events carry a cost -> 11 backfilled points (no network, empty dir).
    assert.ok(hist.length >= 11, 'history gained add points, got ' + hist.length);

    // Omen Alpha added point exists at its exact ts with the right cost.
    const omen = hist.filter((s) => s.models['omen-alpha']);
    assert.ok(omen.length >= 1, 'omen-alpha point present');
    const omenPoint = omen.find((s) => s.ts === '2026-09-04T06:06:00.000Z') || omen[0];
    assert.deepStrictEqual(omenPoint.models['omen-alpha'].cost, { input: 0.2, output: 0.66, cache_read: 0.04 });

    // Timeline spans from 2026-08-20 onward.
    const ts = hist.map((s) => Date.parse(s.ts)).sort((a, b) => a - b);
    assert.ok(ts[0] <= Date.parse('2026-08-20T23:59:59.000Z'), 'history starts at/before Aug 20');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('seed updates the committed usage-table file with caps + provenance', async () => {
  const d = tmpDir();
  const tmpTable = path.join(d, 'usage-table.json');
  // Start from a minimal table (no provenance yet) to prove it gets added.
  fs.writeFileSync(tmpTable, JSON.stringify({ _meta: { defaultCap: 60 }, models: { 'omen-alpha': 100 } }, null, 2));
  try {
    const r = await seed.run({ stateDir: d, usageTablePath: tmpTable, dryRun: false });
    assert.strictEqual(r.tableChanged, true, 'table should be written');
    const after = JSON.parse(fs.readFileSync(tmpTable, 'utf8'));
    assert.strictEqual(after.models['qwen3.7-max'], 30, 'qwen3.7-max cap set');
    assert.strictEqual(after.models['hy3'], 60, 'hy3 cap set');
    assert.ok(after._meta.capsProvenance && after._meta.capsProvenance['hy3'].source === 'ocgo-price-tracker');

    // A dry-run does not rewrite the table.
    const before = fs.readFileSync(tmpTable, 'utf8');
    const r2 = await seed.run({ stateDir: d, usageTablePath: tmpTable, dryRun: true });
    assert.strictEqual(r2.tableChanged, false, 'dry-run reports no table change');
    assert.strictEqual(fs.readFileSync(tmpTable, 'utf8'), before, 'dry-run left the table untouched');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
