'use strict';

// Unit tests for the Zen liveness mirror (v0.15.0, #96). No network:
// global.fetch is mocked per test, delivery side-effects point at a temp dir.
// Go path untouched: existing catalog-liveness.test.js still covers Go; here we
// assert the Zen mirror uses its own URL + state files and never clobbers Go.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const {
  runLivenessWatch,
  runZenLivenessWatch,
  buildZenPricedSet,
  extractServingIds,
  computeWithdrawn,
  computeShrinkage,
  classifyOutage,
  LIVENESS_URL,
  ZEN_LIVENESS_URL
} = require('../src/liveness-watch');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-zen-'));
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

function writeAuthKey(d, key) {
  const p = path.join(d, 'auth.json');
  fs.writeFileSync(p, JSON.stringify({ 'opencode-go': { key } }));
  return p;
}

function mockZenFetch(ids, opts) {
  opts = opts || {};
  global.fetch = async (url, init) => {
    assert.match(String(url), /zen\/v1\/models/, 'expected zen/v1/models URL, got: ' + url);
    assert.doesNotMatch(String(url), /zen\/go\/v1\/models/, 'must NOT hit Go endpoint, got: ' + url);
    if (opts.throw) throw new Error('boom');
    if (opts.status304) {
      return { status: 304, ok: false, headers: { get: () => null } };
    }
    if (opts.httpFail) {
      return { status: 500, ok: false, headers: { get: () => null } };
    }
    const auth = init && init.headers ? init.headers.Authorization : null;
    assert.ok(auth && auth.startsWith('Bearer '), 'expected Bearer auth, got: ' + auth);
    const data = (ids || []).map((id) => ({ id, object: 'model' }));
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ object: 'list', data })
    };
  };
}

test('zen urls are distinct (go vs zen provider base)', () => {
  assert.strictEqual(LIVENESS_URL, 'https://opencode.ai/zen/go/v1/models');
  assert.strictEqual(ZEN_LIVENESS_URL, 'https://opencode.ai/zen/v1/models');
  assert.notStrictEqual(LIVENESS_URL, ZEN_LIVENESS_URL);
});

test('zen first run seeds baseline silently (no flood, own snapshot)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    mockZenFetch(['a']);
    const r = await runZenLivenessWatch(d, auth, { a: {}, b: {} }, 'ok', null);
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.servingIds, ['a']);
    assert.deepStrictEqual(r.withdrawn, []);
    assert.deepStrictEqual(r.changes, []);
    assert.ok(!('cost' in r) && !('pricing' in r), 'liveness must not carry pricing');
    // Own snapshot file, Go files untouched.
    const zenSnap = JSON.parse(fs.readFileSync(path.join(d, 'liveness-zen-snapshot.json'), 'utf8'));
    assert.deepStrictEqual(zenSnap.ids, ['a']);
    assert.ok(!fs.existsSync(path.join(d, 'liveness-snapshot.json')), 'Go snapshot must not be written by Zen run');
    assert.ok(!fs.existsSync(path.join(d, '.etag-liveness')), 'Go etag must not be written by Zen run');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('zen shrinkage: was-serving now gone alerts on second run', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    mockZenFetch(['a', 'b']);
    const r1 = await runZenLivenessWatch(d, auth, ['a', 'b'], 'ok', null);
    assert.deepStrictEqual(r1.withdrawn, [], 'baseline run must not alert');
    mockZenFetch(['a']);
    const r2 = await runZenLivenessWatch(d, auth, ['a', 'b'], 'ok', null);
    assert.strictEqual(r2.status, 'ok');
    assert.deepStrictEqual(r2.withdrawn, ['b']);
    assert.ok(
      r2.changes.some((c) => c.includes('b')),
      'expected shrinkage line, got: ' + JSON.stringify(r2.changes)
    );
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('computeShrinkage is pure prior-minus-current', () => {
  assert.deepStrictEqual(computeShrinkage(['a', 'b'], ['a']), ['b']);
  assert.deepStrictEqual(computeShrinkage(['a'], ['a', 'b']), []);
  assert.deepStrictEqual(computeShrinkage(null, ['a']), []);
  assert.deepStrictEqual(computeShrinkage(['a'], null), ['a']);
});

test('zen ETag 304 returns unchanged from zen snapshot', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    fs.writeFileSync(path.join(d, '.etag-liveness-zen'), 'W/"zen"');
    fs.writeFileSync(path.join(d, 'liveness-zen-snapshot.json'), JSON.stringify({ ts: new Date().toISOString(), ids: ['a'] }));
    let sawNoneMatch = false;
    global.fetch = async (url, init) => {
      assert.match(String(url), /zen\/v1\/models/, 'expected zen URL, got: ' + url);
      if (init && init.headers && init.headers['If-None-Match'] === 'W/"zen"') sawNoneMatch = true;
      return { status: 304, ok: false, headers: { get: () => null } };
    };
    const r = await runZenLivenessWatch(d, auth, { a: {}, b: {} }, 'ok', null);
    assert.strictEqual(r.status, 'unchanged');
    assert.ok(sawNoneMatch, 'expected If-None-Match to be sent');
    assert.deepStrictEqual(r.servingIds, ['a']);
    // Shrinkage-only (#100): 304 means serving unchanged → no shrinkage.
    assert.deepStrictEqual(r.withdrawn, []);
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('zen failures never throw, outage includes zen failure', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    // Fetch throws + usage failing -> outage signal, still no throw.
    mockZenFetch(null, { throw: true });
    const l1 = await runZenLivenessWatch(d, auth, { a: {} }, 'unknown', 'boom');
    assert.strictEqual(l1.status, 'unknown');
    assert.strictEqual(l1.outage, 'outage');
    // HTTP 500 -> unknown, outage when usage also failing.
    mockZenFetch(null, { httpFail: true });
    const l2 = await runZenLivenessWatch(d, auth, { a: {} }, 'unknown', 'boom');
    assert.strictEqual(l2.status, 'unknown');
    assert.strictEqual(l2.outage, 'outage');
    // Usage healthy -> ok verdict, never outage.
    mockZenFetch(null, { throw: true });
    const l3 = await runZenLivenessWatch(d, auth, { a: {} }, 'ok', null);
    assert.strictEqual(l3.status, 'unknown');
    assert.strictEqual(classifyOutage(l3.status, 'ok', l3.error, null), 'ok');
    // No key -> unknown, never throws.
    const l4 = await runZenLivenessWatch(d, path.join(d, 'missing-auth.json'), { a: {} }, 'unknown', 'no key');
    assert.strictEqual(l4.status, 'unknown');
    // Shared pure helpers still behave (Go path untouched).
    assert.deepStrictEqual(extractServingIds({ object: 'list', data: [{ id: 'x' }] }), ['x']);
    assert.deepStrictEqual(computeWithdrawn(['a', 'b'], ['a']), ['b']);
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('go path untouched (own files, zen files absent)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    global.fetch = async (url, init) => {
      assert.match(String(url), /zen\/go\/v1\/models/, 'expected Go URL, got: ' + url);
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({ object: 'list', data: [{ id: 'a', object: 'model' }] })
      };
    };
    const r = await runLivenessWatch(d, auth, { a: {}, b: {} }, 'ok', null);
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.withdrawn, ['b']);
    assert.ok(fs.existsSync(path.join(d, 'liveness-snapshot.json')), 'Go snapshot must exist');
    assert.ok(!fs.existsSync(path.join(d, 'liveness-zen-snapshot.json')), 'Zen snapshot must not be written by Go run');
    assert.ok(!fs.existsSync(path.join(d, '.etag-liveness-zen')), 'Zen etag must not be written by Go run');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- Zen scoping (#98) ------------------------------------------------------
// The Zen check must diff ZEN-priced + free ids against Zen serving — never
// GO-priced ids. Go-vs-Zen catalog divergence (Go-only models absent from Zen
// serving) is expected, not a withdrawal.

test('buildZenPricedSet unions billable + free, drops reserved keys', () => {
  // Map + array inputs, deduped.
  assert.deepStrictEqual(
    buildZenPricedSet({ 'za': { cost: {} }, 'zb': { cost: {} } }, ['zb', 'zfree-free']),
    ['za', 'zb', 'zfree-free']
  );
  // Whole-snapshot map as first arg: reserved keys are dropped.
  assert.deepStrictEqual(
    buildZenPricedSet(
      { 'za': {}, freeModels: { 'zfree-free': {} }, modelPrivacy: {}, zenModels: { 'za': {} } },
      { 'zfree-free': {} }
    ),
    ['za', 'zfree-free']
  );
  // Nullish / junk never throws, yields [].
  assert.deepStrictEqual(buildZenPricedSet(null, undefined), []);
  assert.deepStrictEqual(buildZenPricedSet('nope', 42), []);
});

test('zen dedup uses bumped liveness-zen3 prefix (no stale suppression)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    // Baseline run seeds ['zen-a', 'zen-gone'] silently...
    mockZenFetch(['zen-a', 'zen-gone']);
    const r0 = await runZenLivenessWatch(d, auth, ['zen-a', 'zen-gone'], 'ok', null);
    assert.deepStrictEqual(r0.withdrawn, []);
    // ...then shrinkage of zen-gone alerts under the zen3 prefix.
    mockZenFetch(['zen-a']);
    const r = await runZenLivenessWatch(d, auth, ['zen-a', 'zen-gone'], 'ok', null);
    assert.deepStrictEqual(r.withdrawn, ['zen-gone']);
    const dedup = JSON.parse(fs.readFileSync(path.join(d, 'dedup.json'), 'utf8'));
    assert.ok(
      Object.keys(dedup).includes('reserved:liveness-zen3:missing:zen-gone'),
      'expected bumped dedup key, got: ' + JSON.stringify(Object.keys(dedup))
    );
    assert.ok(
      !Object.keys(dedup).some((k) => k === 'reserved:liveness-zen2:missing:zen-gone'),
      'old prefix must not be written'
    );
    assert.ok(
      !Object.keys(dedup).some((k) => k === 'reserved:liveness-zen:missing:zen-gone'),
      'oldest prefix must not be written'
    );
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('catalog divergence (102 priced, 29 serving) alerts nothing on baseline, then 1 removal alerts once', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    // 102 catalog ids vs 29 serving: pure divergence, not withdrawal.
    const priced = Array.from({ length: 102 }, (_, i) => `model-${i}`);
    const serving = Array.from({ length: 29 }, (_, i) => `model-${i}`);
    mockZenFetch(serving);
    const r1 = await runZenLivenessWatch(d, auth, priced, 'ok', null);
    assert.strictEqual(r1.status, 'ok');
    assert.deepStrictEqual(r1.withdrawn, [], 'divergence must not alert on baseline, got: ' + JSON.stringify(r1.withdrawn));
    assert.deepStrictEqual(r1.changes, []);
    // Second run with identical serving: still silent.
    mockZenFetch(serving);
    const r2 = await runZenLivenessWatch(d, auth, priced, 'ok', null);
    assert.deepStrictEqual(r2.withdrawn, []);
    // Removing 1 serving id → exactly 1 shrinkage alert.
    const shrunk = serving.slice(1);
    mockZenFetch(shrunk);
    const r3 = await runZenLivenessWatch(d, auth, priced, 'ok', null);
    assert.deepStrictEqual(r3.withdrawn, [serving[0]]);
    assert.strictEqual(r3.changes.length, 1);
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
