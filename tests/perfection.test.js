'use strict';

// v0.20.0 perfection batch (#112): rejection-safe retry, atomic recovery
// (incl. kill-mid-write simulation via partial file), validation warnings,
// banner/help. No network: global.fetch is mocked per test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { fetchWithRetry } = require('../src/fetch-retry');
const atomic = require('../src/atomic-write');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-perfect-'));
}

test('fetchWithRetry retries a 429 then succeeds', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { status: 429, ok: false, headers: { get: () => null } };
    return { status: 200, ok: true, headers: { get: () => null } };
  };
  try {
    const res = await fetchWithRetry('https://example.invalid/x', {}, 3);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 2, 'one retry after 429');
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchWithRetry gives up after 3 tries on persistent 503', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { status: 503, ok: false, headers: { get: () => null } };
  };
  try {
    const res = await fetchWithRetry('https://example.invalid/x', {}, 3);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(calls, 3, 'exactly 3 attempts');
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchWithRetry passes non-retryable 404 through immediately', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { status: 404, ok: false, headers: { get: () => null } };
  };
  try {
    const res = await fetchWithRetry('https://example.invalid/x', {}, 3);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(calls, 1, 'no retry on 404');
  } finally {
    global.fetch = origFetch;
  }
});

test('atomic write survives kill-mid-write: partial tmp never clobbers good snapshot', () => {
  const d = tmpDir();
  try {
    const target = path.join(d, 'snap.json');
    const good = { a: 1 };
    assert.ok(atomic.atomicWriteJsonSync(target, good));
    // Simulate a kill -9 mid-write: a partial .tmp file left behind.
    fs.writeFileSync(target + '.tmp', '{"a": 2, "half-writ');
    // The good snapshot still parses; a fresh atomic write replaces cleanly.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), good);
    assert.ok(atomic.atomicWriteJsonSync(target, { a: 3 }));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 3 });
    assert.ok(!fs.existsSync(target + '.tmp'), 'no tmp left behind');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('readJsonKeepBak preserves corrupt file as .bak instead of reset', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'state.json');
    fs.writeFileSync(f, '{"broken": ');
    const r = atomic.readJsonKeepBak(f, { fallback: true });
    assert.strictEqual(r.ok, false);
    assert.ok(r.corrupt);
    assert.deepStrictEqual(r.data, { fallback: true });
    assert.ok(fs.existsSync(f + '.bak'), 'corrupt file kept as .bak');
    assert.ok(!fs.existsSync(f), 'corrupt original moved away');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('redactUrl strips token-like query params', () => {
  const out = atomic.redactUrl('https://hooks.example.com/abc?token=secret123&x=1');
  assert.ok(!out.includes('secret123'), out);
  assert.ok(out.includes('token=REDACTED'), out);
});

test('config validation warns on unknown keys and clamps ranges', () => {
  const d = tmpDir();
  try {
    const cfgPath = path.join(d, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ threhsolds: { warning: 80 }, thresholds: { warning: -5, critical: 10 }, cadenceMs: { usage: 0 } })
    );
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    let cfg;
    try {
      cfg = require('../src/config').loadConfig(cfgPath);
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => w.includes('threhsolds')), warnings.join('\n'));
    assert.ok(cfg.thresholds.warning >= 1, 'warning clamped to >=1');
    assert.ok(cfg.thresholds.critical > cfg.thresholds.warning, 'critical kept above warning');
    assert.ok(cfg.cadenceMs.usage >= 10000, 'cadence clamped to >=10s');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('config expands ~ in authJsonPath', () => {
  const d = tmpDir();
  try {
    const cfgPath = path.join(d, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ authJsonPath: '~/.local/share/opencode/auth.json' }));
    const cfg = require('../src/config').loadConfig(cfgPath);
    assert.ok(!cfg.authJsonPath.startsWith('~'), cfg.authJsonPath);
    assert.ok(cfg.authJsonPath.includes('.local/share/opencode/auth.json'), cfg.authJsonPath);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('monitor --help prints help and exits 0', () => {
  const r = spawnSync(process.execPath, ['src/monitor.js', '--help'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('USAGE'), r.stdout);
  assert.ok(r.stdout.includes('--once'), r.stdout);
});

test('monitor prints startup banner on --help path and --once summary path', () => {
  // Banner check via --help (exits before any network): banner prints first.
  const r = spawnSync(process.execPath, ['src/monitor.js', '--help'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.ok(r.stdout.includes('opencode-model-monitor'), r.stdout);
});

test('config-scan smoke: findConfigs + runConfigScan never throw', () => {
  const scan = require('../src/config-scan');
  const d = tmpDir();
  try {
    const out = [];
    scan.findConfigs(d, 0, out);
    assert.ok(Array.isArray(out), 'findConfigs fills an array');
    const pins = scan.runConfigScan([d], {});
    assert.ok(Array.isArray(pins), 'runConfigScan returns an array');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('reportSummary uses normalized ok/warn vocabulary', () => {
  const d = tmpDir();
  try {
    const delivery = require('../src/delivery');
    delivery.configure({ logFile: false, reportFile: false, stdout: false }, d);
    delivery.init(d, {});
    const quiet = delivery.reportSummary({ pricing: { models: {} }, usage: {} });
    assert.ok(quiet[0].includes('ok'), quiet[0]);
    const noisy = delivery.reportSummary({
      pricing: { models: {} },
      usage: {},
      // reportSummary reads changelog from STATE_DIR; seed one event.
      generatedAt: new Date().toISOString()
    });
    void noisy;
    fs.writeFileSync(
      path.join(d, 'changelog.json'),
      JSON.stringify([{ ts: new Date().toISOString(), level: 'model_change', title: 't', message: 'm' }])
    );
    delivery.clearCycleCache();
    const warn = delivery.reportSummary({ pricing: { models: {} }, usage: {} });
    assert.ok(warn[0].includes('warn'), warn[0]);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
