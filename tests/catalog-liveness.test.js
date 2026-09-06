'use strict';

// Unit tests for the v0.12.0 (#90) new sources: catalog.json cross-check +
// v1/models liveness. No network: global.fetch is mocked per test, delivery
// side-effects are pointed at a temp state dir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const {
  runCatalogWatch,
  validateCatalogShape,
  computeDeprecatedChanges,
  extractCatalogStatus
} = require('../src/catalog-watch');
const {
  runLivenessWatch,
  extractServingIds,
  computeWithdrawn,
  classifyOutage
} = require('../src/liveness-watch');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-newsrc-'));
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

function mockCatalogFetch(catalogModels, opts) {
  opts = opts || {};
  global.fetch = async (url, init) => {
    assert.match(String(url), /catalog\.json/, 'expected catalog.json URL, got: ' + url);
    if (opts.status304) {
      return { status: 304, ok: false, headers: { get: () => null } };
    }
    if (opts.httpFail) {
      return { status: 500, ok: false, headers: { get: () => null } };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: (k) => (k === 'etag' ? (opts.etag || null) : null) },
      json: async () => ({ models: catalogModels })
    };
  };
}

function writeCatalogSnapshot(d, obj) {
  fs.writeFileSync(path.join(d, 'catalog-snapshot.json'), JSON.stringify(obj, null, 2));
}

function writeAuthKey(d, key) {
  const p = path.join(d, 'auth.json');
  fs.writeFileSync(p, JSON.stringify({ 'opencode-go': { key } }));
  return p;
}

function mockLivenessFetch(idsOrOpts, opts) {
  // mockLivenessFetch(['a','b']) or mockLivenessFetch({ fail:'throw' }) etc.
  if (idsOrOpts && typeof idsOrOpts === 'object' && !Array.isArray(idsOrOpts)) {
    opts = idsOrOpts;
    idsOrOpts = null;
  }
  opts = opts || {};
  global.fetch = async (url, init) => {
    assert.match(String(url), /v1\/models/, 'expected v1/models URL, got: ' + url);
    if (opts.throw) throw new Error('boom');
    if (opts.status304) {
      return { status: 304, ok: false, headers: { get: () => null } };
    }
    if (opts.httpFail) {
      return { status: 500, ok: false, headers: { get: () => null } };
    }
    // Bearer auth required (same as usage.js).
    const auth = init && init.headers ? init.headers.Authorization : null;
    assert.ok(auth && auth.startsWith('Bearer '), 'expected Bearer auth, got: ' + auth);
    const data = (idsOrOpts || []).map((id) => ({ id, object: 'model' }));
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ object: 'list', data })
    };
  };
}

// --- catalog: deprecated detection ------------------------------------------

test('catalog deprecated detection (newly deprecated -> Model deprecated)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeCatalogSnapshot(d, {
      a: { status: null, deprecated: false, meta: { name: 'A', status: null, deprecated: false, id: 'a' } },
      b: { status: null, deprecated: false, meta: { name: 'B', status: null, deprecated: false, id: 'b' } }
    });
    mockCatalogFetch({
      a: { name: 'A' },
      b: { name: 'B', status: 'deprecated' }
    });
    const r = await runCatalogWatch(d, { apiShapeFailed: false });
    assert.strictEqual(r.status, 'ok');
    assert.ok(
      r.changes.some((c) => c.includes('Model deprecated: b')),
      'expected "Model deprecated: b", got: ' + JSON.stringify(r.changes)
    );
    // Already-deprecated stays quiet on the next cycle (deduped via snapshot).
    mockCatalogFetch({
      a: { name: 'A' },
      b: { name: 'B', status: 'deprecated' }
    });
    const r2 = await runCatalogWatch(d, { apiShapeFailed: false });
    assert.ok(
      !r2.changes.some((c) => c.includes('Model deprecated: b')),
      'second cycle must not re-alert, got: ' + JSON.stringify(r2.changes)
    );
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('extractCatalogStatus maps status/deprecated signals', () => {
  assert.deepStrictEqual(extractCatalogStatus({ status: 'deprecated' }), { status: 'deprecated', deprecated: true });
  assert.deepStrictEqual(extractCatalogStatus({ deprecated: true }), { status: null, deprecated: true });
  assert.deepStrictEqual(extractCatalogStatus({ name: 'x' }), { status: null, deprecated: false });
});

test('computeDeprecatedChanges is pure (only new deprecations)', () => {
  const prev = { a: { deprecated: false }, b: { deprecated: true } };
  const curr = {
    a: { deprecated: true, meta: null },
    b: { deprecated: true, meta: null },
    c: { deprecated: false, meta: null }
  };
  const out = computeDeprecatedChanges(prev, curr);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].model, 'a');
  assert.strictEqual(out[0].subtype, 'deprecated');
});

// --- catalog: shape-drift guard ----------------------------------------------

test('shape-drift guard (api.json failed + catalog OK -> drift suspected)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeCatalogSnapshot(d, {
      a: { status: null, deprecated: false, meta: null }
    });
    mockCatalogFetch({ a: { name: 'A' } });
    const r = await runCatalogWatch(d, { apiShapeFailed: true });
    assert.strictEqual(r.status, 'ok');
    assert.ok(
      r.changes.some((c) => c.includes('api.json drift suspected')),
      'expected drift line, got: ' + JSON.stringify(r.changes)
    );
    // Without the api failure there is no drift line.
    mockCatalogFetch({ a: { name: 'A' } });
    const r2 = await runCatalogWatch(d, { apiShapeFailed: false });
    assert.ok(
      !r2.changes.some((c) => c.includes('drift')),
      'no drift expected without api failure, got: ' + JSON.stringify(r2.changes)
    );
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('validateCatalogShape rejects bad shapes', () => {
  assert.strictEqual(validateCatalogShape({ models: { a: {} } }).ok, true);
  assert.strictEqual(validateCatalogShape({ models: {} }).ok, false);
  assert.strictEqual(validateCatalogShape({ nope: 1 }).ok, false);
  assert.strictEqual(validateCatalogShape('<html>').ok, false);
});

// --- liveness: withdrawn detection -------------------------------------------

test('liveness withdrawn detection (priced but absent -> warning line)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    mockLivenessFetch(['a']);
    const r = await runLivenessWatch(d, auth, { a: {}, b: {} }, 'ok', null);
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.servingIds, ['a']);
    assert.deepStrictEqual(r.withdrawn, ['b']);
    assert.ok(
      r.changes.some((c) => c.includes('priced but not serving: b')),
      'expected withdrawn line, got: ' + JSON.stringify(r.changes)
    );
    // IDs only: no cost/pricing carried from the endpoint.
    assert.ok(!('cost' in r) && !('pricing' in r), 'liveness must not carry pricing');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('extractServingIds handles list / array / map shapes', () => {
  assert.deepStrictEqual(extractServingIds({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepStrictEqual(extractServingIds([{ id: 'x' }]), ['x']);
  assert.deepStrictEqual(extractServingIds({ models: { m1: {}, m2: {} } }).sort(), ['m1', 'm2']);
  assert.deepStrictEqual(extractServingIds({ unexpected: 1 }), []);
});

test('computeWithdrawn is pure set difference', () => {
  assert.deepStrictEqual(computeWithdrawn(['a', 'b'], ['a']), ['b']);
  assert.deepStrictEqual(computeWithdrawn({ a: {}, b: {} }, ['a', 'b']), []);
});

// --- outage-vs-quota ----------------------------------------------------------

test('outage-vs-quota classification', () => {
  assert.strictEqual(classifyOutage('unknown', 'unknown', 'boom', 'boom'), 'outage');
  assert.strictEqual(classifyOutage('ok', 'unknown', null, 'HTTP 401'), 'quota');
  assert.strictEqual(classifyOutage('ok', 'ok', null, null), 'ok');
  assert.strictEqual(classifyOutage('unknown', 'ok', 'boom', null), 'ok');
  // Missing local key is quota/config, never an outage.
  assert.strictEqual(classifyOutage('unknown', 'unknown', 'no key', 'no key'), 'quota');
});

// --- ETag 304 -----------------------------------------------------------------

test('catalog ETag 304 returns unchanged without refetch', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeCatalogSnapshot(d, { a: { status: null, deprecated: false, meta: null } });
    fs.writeFileSync(path.join(d, '.etag-catalog'), 'W/"abc"');
    let sawNoneMatch = false;
    global.fetch = async (url, init) => {
      if (init && init.headers && init.headers['If-None-Match'] === 'W/"abc"') sawNoneMatch = true;
      return { status: 304, ok: false, headers: { get: () => null } };
    };
    const r = await runCatalogWatch(d, {});
    assert.strictEqual(r.status, 'unchanged');
    assert.ok(sawNoneMatch, 'expected If-None-Match to be sent');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('liveness ETag 304 returns unchanged', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    fs.writeFileSync(path.join(d, '.etag-liveness'), 'W/"live"');
    fs.writeFileSync(path.join(d, 'liveness-snapshot.json'), JSON.stringify({ ts: new Date().toISOString(), ids: ['a'] }));
    mockLivenessFetch({ status304: true });
    const r = await runLivenessWatch(d, auth, { a: {}, b: {} }, 'ok', null);
    assert.strictEqual(r.status, 'unchanged');
    assert.deepStrictEqual(r.servingIds, ['a']);
    assert.deepStrictEqual(r.withdrawn, ['b']);
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- failures never throw -----------------------------------------------------

test('failures never throw (catalog + liveness)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    // Catalog: fetch throws.
    global.fetch = async () => {
      throw new Error('network down');
    };
    const c1 = await runCatalogWatch(d, {});
    assert.strictEqual(c1.status, 'unknown');
    // Catalog: HTTP 500.
    mockCatalogFetch({}, { httpFail: true });
    const c2 = await runCatalogWatch(d, {});
    assert.strictEqual(c2.status, 'unknown');
    // Liveness: fetch throws + usage also failing -> outage signal, still no throw.
    const auth = writeAuthKey(d, 'sk-test');
    mockLivenessFetch({ throw: true });
    const l1 = await runLivenessWatch(d, auth, { a: {} }, 'unknown', 'boom');
    assert.strictEqual(l1.status, 'unknown');
    assert.strictEqual(l1.outage, 'outage');
    // Liveness: no key -> unknown, never throws.
    const l2 = await runLivenessWatch(d, path.join(d, 'missing-auth.json'), { a: {} }, 'unknown', 'no key');
    assert.strictEqual(l2.status, 'unknown');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
