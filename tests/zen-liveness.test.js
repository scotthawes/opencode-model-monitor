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
  extractServingIds,
  computeWithdrawn,
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

test('zen withdrawn detection (priced but absent -> warning line, own snapshot)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    mockZenFetch(['a']);
    const r = await runZenLivenessWatch(d, auth, { a: {}, b: {} }, 'ok', null);
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.servingIds, ['a']);
    assert.deepStrictEqual(r.withdrawn, ['b']);
    assert.ok(
      r.changes.some((c) => c.includes('priced but not serving: b')),
      'expected withdrawn line, got: ' + JSON.stringify(r.changes)
    );
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

test('zen withdrawn supports free-list array input', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const auth = writeAuthKey(d, 'sk-test');
    mockZenFetch(['a']);
    const r = await runZenLivenessWatch(d, auth, ['a', 'b'], 'ok', null);
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.withdrawn, ['b']);
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
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
    assert.deepStrictEqual(r.withdrawn, ['b']);
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
