'use strict';

// Unit tests for live caps polling (v0.13.0, #92): src/caps-watch.js.
//  - parse/strip-prefix + invalid-usage skipping (buildCapsMap)
//  - fuzzy match files a renamed live id under the existing table key
//  - ETag 304 returns unchanged without touching the table
//  - a live cap change rewrites the table AND surfaces once through the
//    existing price-watch cap detector (no duplicate alert path)
//  - failures (throw / HTTP 500 / parse fail / empty shape) never throw and
//    keep the old table

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const usageTable = require('../src/usage-table');
const {
  runCapsWatch,
  buildCapsMap,
  stripPrefix,
  normalizeId,
  matchLocalId,
  computeTableUpdate
} = require('../src/caps-watch');
const { computeCapChanges } = require('../src/price-watch');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-caps-'));
}

function setup(d) {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.setStateDir(d);
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
  delivery.init(d, { dedupTtlMs: 86400000, changelogRetentionMs: 7 * 24 * 3600 * 1000 });
}

const origFetch = global.fetch;
function restoreFetch() {
  global.fetch = origFetch;
}

function writeTable(d, models, meta) {
  const p = path.join(d, 'usage-table.json');
  fs.writeFileSync(
    p,
    JSON.stringify({ _meta: Object.assign({ source: 'seed', seededAt: '2026-09-05T00:00:00.000Z' }, meta || {}), models }, null, 2)
  );
  return p;
}

function mockLiveFetch(models, opts) {
  opts = opts || {};
  global.fetch = async (url, init) => {
    assert.match(String(url), /latest\.json/, 'expected latest.json URL, got: ' + url);
    if (opts.status304) {
      return { status: 304, ok: false, headers: { get: () => null } };
    }
    if (opts.httpFail) {
      return { status: 500, ok: false, headers: { get: () => null } };
    }
    if (opts.throw) throw new Error('network down');
    if (opts.badJson) {
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new Error('bad json'); } };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: (k) => (k === 'etag' ? (opts.etag || '"caps-etag-1"') : null) },
      json: async () => ({ models })
    };
  };
}

// --- pure parse ------------------------------------------------------------

test('stripPrefix / normalizeId', () => {
  assert.strictEqual(stripPrefix('opencode-go/grok-4.6'), 'grok-4.6');
  assert.strictEqual(stripPrefix('grok-4.6'), 'grok-4.6');
  assert.strictEqual(normalizeId('opencode-go/Grok_4.6'), 'grok-4.6');
  assert.strictEqual(normalizeId('grok 4.6'), 'grok-4.6');
});

test('buildCapsMap maps usage -> cap, strips prefix, skips invalid', () => {
  const { map } = buildCapsMap({
    models: [
      { id: 'opencode-go/grok-4.6', usage: 15 },
      { id: 'opencode-go/grok-4.6', tier: '>200K', usage: 15 },
      { id: 'opencode-go/a', usage: 0 },
      { id: 'opencode-go/b', usage: -5 },
      { id: 'opencode-go/c', usage: 'nope' },
      { id: 'opencode-go/d' },
      { noId: true, usage: 30 }
    ]
  });
  assert.deepStrictEqual(map, { 'grok-4.6': 15 });
});

test('buildCapsMap tolerates missing/non-array models', () => {
  assert.deepStrictEqual(buildCapsMap(null).map, {});
  assert.deepStrictEqual(buildCapsMap({}).map, {});
  assert.deepStrictEqual(buildCapsMap({ models: 'nope' }).map, {});
});

test('matchLocalId is exact-first, then fuzzy', () => {
  const existing = { 'grok-4.6': 15, 'hy3': 60 };
  assert.strictEqual(matchLocalId('grok-4.6', existing), 'grok-4.6');
  assert.strictEqual(matchLocalId('opencode-go/hy3', existing), 'hy3');
  assert.strictEqual(matchLocalId('brand-new', existing), null);
});

test('computeTableUpdate files a renamed live id under the existing key', () => {
  const out = computeTableUpdate({ 'Grok-4.6': 15 }, { 'grok-4.6': 15 }, null);
  assert.deepStrictEqual(Object.keys(out.models), ['Grok-4.6']);
  assert.strictEqual(out.added.length, 0);
  assert.strictEqual(out.updated.length, 0);
});

test('computeTableUpdate keeps stale entries when priced, drops dead ones', () => {
  const out = computeTableUpdate(
    { a: 15, stalePriced: 30, dead: 60 },
    { a: 15 },
    new Set(['a', 'stalePriced'])
  );
  assert.strictEqual(out.models.stalePriced, 30);
  assert.deepStrictEqual(out.keptStale, ['stalePriced']);
  assert.ok(!('dead' in out.models), 'dead entry dropped');
  assert.strictEqual(out.dropped.length, 1);
});

test('computeTableUpdate keeps all stale when priced set unknown (conservative)', () => {
  const out = computeTableUpdate({ a: 15, old: 30 }, { a: 15 }, null);
  assert.strictEqual(out.models.old, 30);
  assert.strictEqual(out.dropped.length, 0);
});

// --- 304 unchanged ----------------------------------------------------------

test('ETag 304 returns unchanged without touching the table', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const tablePath = writeTable(d, { hy3: 60 });
    const before = fs.readFileSync(tablePath, 'utf8');
    fs.writeFileSync(path.join(d, '.etag-caps'), 'W/"caps1"');
    let sawNoneMatch = false;
    global.fetch = async (url, init) => {
      if (init && init.headers && init.headers['If-None-Match'] === 'W/"caps1"') sawNoneMatch = true;
      return { status: 304, ok: false, headers: { get: () => null } };
    };
    const r = await runCapsWatch(d, { tablePath });
    assert.strictEqual(r.status, 'unchanged');
    assert.ok(sawNoneMatch, 'expected If-None-Match to be sent');
    assert.strictEqual(fs.readFileSync(tablePath, 'utf8'), before, 'table untouched on 304');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- change detection fires once --------------------------------------------

test('live cap change rewrites table (source:live + fetchedAt) and detector fires once', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const tablePath = writeTable(d, { hy3: 60, steady: 30 });
    // Priced snapshot: both ids priced, so nothing is treated as dead.
    fs.writeFileSync(
      path.join(d, 'pricing-snapshot.json'),
      JSON.stringify({ hy3: { cost: { input: 1 } }, steady: { cost: { input: 1 } } })
    );
    mockLiveFetch([
      { id: 'opencode-go/hy3', usage: 15 },
      { id: 'opencode-go/steady', usage: 30 }
    ]);
    const r = await runCapsWatch(d, { tablePath });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.moves.updated.length, 1);
    assert.strictEqual(r.moves.updated[0].id, 'hy3');

    const doc = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
    assert.strictEqual(doc.models.hy3, 15);
    assert.strictEqual(doc.models.steady, 30);
    assert.strictEqual(doc._meta.source, 'live');
    assert.ok(doc._meta.fetchedAt, 'fetchedAt provenance present');
    assert.strictEqual(doc._meta.seededAt, '2026-09-05T00:00:00.000Z', 'original seededAt preserved');

    // The existing price-watch cap detector fires exactly once for the move:
    // prev runtime snapshot said 60, the refreshed table says 15.
    usageTable.setTable(doc.models);
    try {
      const changes = computeCapChanges(
        { hy3: 60, steady: 30 },
        { hy3: { cost: {}, meta: null, usage: null }, steady: { cost: {}, meta: null, usage: null } }
      );
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].model, 'hy3');
      assert.strictEqual(changes[0].factor, 4);
    } finally {
      usageTable.setTable(null);
    }

    // A second identical poll is quiet (no rewrite loop, no moves).
    mockLiveFetch([
      { id: 'opencode-go/hy3', usage: 15 },
      { id: 'opencode-go/steady', usage: 30 }
    ]);
    const r2 = await runCapsWatch(d, { tablePath });
    assert.strictEqual(r2.status, 'unchanged');
  } finally {
    restoreFetch();
    usageTable.setTable(null);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- failures never throw + keep old table -----------------------------------

test('failures never throw and keep the old table', async () => {
  const scenarios = [
    { name: 'throw', opts: { throw: true } },
    { name: 'http500', opts: { httpFail: true } },
    { name: 'badJson', opts: { badJson: true } },
    { name: 'emptyShape', models: [], opts: {} },
    { name: 'missingModels', models: null, opts: {}, raw: true }
  ];
  for (const s of scenarios) {
    const d = tmpDir();
    try {
      setup(d);
      const tablePath = writeTable(d, { hy3: 60 });
      const before = fs.readFileSync(tablePath, 'utf8');
      if (s.raw) {
        global.fetch = async () => ({
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => ({ nope: true })
        });
      } else {
        mockLiveFetch(s.models === undefined ? [{ id: 'opencode-go/hy3', usage: 15 }] : s.models, s.opts);
      }
      const r = await runCapsWatch(d, { tablePath });
      assert.strictEqual(r.status, 'unknown', `scenario ${s.name}: expected unknown`);
      assert.strictEqual(fs.readFileSync(tablePath, 'utf8'), before, `scenario ${s.name}: table must be kept`);
    } finally {
      restoreFetch();
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});
