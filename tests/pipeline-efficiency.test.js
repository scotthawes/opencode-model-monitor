'use strict';

// v0.16.0 (#103) pipeline-efficiency tests: fetch timeouts never throw,
// per-cycle changelog batching performs a single rewrite, and parse-once /
// unified-helper outputs are identical to the legacy behavior.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const delivery = require('../src/delivery');
const changeMetric = require('../src/change-metric');
const discordDigest = require('../src/discord-digest');
const calc = require('../src/calc');

const DAY = 864e5;
const NOW = Date.parse('2026-09-05T00:00:00.000Z');

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-eff-'));
}

function quietDelivery(stateDir) {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    stateDir
  );
  delivery.init(stateDir, {});
  // Drain any leftover batch from a previous test's cycle.
  try { delivery.endChangelogBatch(); } catch (_) {}
  delivery.clearCycleCache();
}

// --- (a) timeouts -----------------------------------------------------------

test('calc.fetchModelsMap sends an AbortSignal and never throws on abort', async () => {
  const origFetch = global.fetch;
  let seenOpts = null;
  global.fetch = async (_url, opts) => {
    seenOpts = opts || null;
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  try {
    const out = await calc.fetchModelsMap();
    assert.deepStrictEqual(out, {}, 'abort must degrade to {} (never throw)');
    assert.ok(seenOpts && seenOpts.signal instanceof AbortSignal, 'fetch must carry an AbortSignal');
  } finally {
    global.fetch = origFetch;
  }
});

test('AbortSignal.timeout produces an aborting signal (15s budget sanity)', () => {
  const sig = AbortSignal.timeout(15000);
  assert.ok(sig instanceof AbortSignal, 'expected an AbortSignal');
  assert.strictEqual(sig.aborted, false, 'fresh 15s signal must not be pre-aborted');
});

// --- (b) batched changelog: single rewrite ----------------------------------

test('5-alert cycle performs a single changelog.json rewrite', async () => {
  const dir = makeStateDir();
  quietDelivery(dir);
  const origWrite = fs.writeFileSync;
  let changelogWrites = 0;
  fs.writeFileSync = function (p, ...rest) {
    if (String(p).endsWith('changelog.json')) changelogWrites += 1;
    return origWrite.call(this, p, ...rest);
  };
  try {
    delivery.beginChangelogBatch();
    for (let i = 0; i < 5; i += 1) {
      await delivery.alert('info', 'batch probe ' + i, 'message ' + i);
    }
    assert.strictEqual(changelogWrites, 0, 'batched alerts must not rewrite mid-cycle');
    const flushed = delivery.endChangelogBatch();
    assert.strictEqual(flushed, 5, 'flush must persist all 5 entries');
    assert.strictEqual(changelogWrites, 1, '5-change cycle must perform exactly 1 rewrite');
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'changelog.json'), 'utf8'));
    assert.strictEqual(persisted.length, 5, 'all 5 entries must be persisted in order');
    assert.strictEqual(persisted[0].title, 'batch probe 0');
    assert.strictEqual(persisted[4].title, 'batch probe 4');
  } finally {
    fs.writeFileSync = origWrite;
  }
});

test('empty batch performs zero rewrites', () => {
  const dir = makeStateDir();
  quietDelivery(dir);
  const origWrite = fs.writeFileSync;
  let changelogWrites = 0;
  fs.writeFileSync = function (p, ...rest) {
    if (String(p).endsWith('changelog.json')) changelogWrites += 1;
    return origWrite.call(this, p, ...rest);
  };
  try {
    delivery.beginChangelogBatch();
    const flushed = delivery.endChangelogBatch();
    assert.strictEqual(flushed, 0);
    assert.strictEqual(changelogWrites, 0, 'unchanged cycle must perform zero rewrites');
  } finally {
    fs.writeFileSync = origWrite;
  }
});

// --- (c) parse-once: output identity ----------------------------------------

test('renderMarkdown is identical with and without the parse cache', () => {
  const dir = makeStateDir();
  quietDelivery(dir);
  const history = [
    { ts: NOW - 7 * DAY, rolling: 40, weekly: 40, monthly: 40 },
    { ts: NOW, rolling: 50, weekly: 50, monthly: 50 }
  ];
  fs.writeFileSync(path.join(dir, 'usage-history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ ts: NOW, models: {} }]));
  fs.writeFileSync(path.join(dir, 'changelog.json'), JSON.stringify([]));
  const report = {
    generatedAt: '2026-09-05T00:00:00.000Z',
    pricing: { status: 'unchanged' },
    usage: { usage: { monthly: { percent: 50, resetsAt: '2026-10-01T00:00:00.000Z', status: 'ok' } } },
    pins: [],
    feedUpdates: []
  };
  const origNow = Date.now;
  Date.now = () => NOW;
  try {
    delivery.clearCycleCache();
    const before = delivery.renderMarkdown(report);
    delivery.beginCycleCache();
    const after1 = delivery.renderMarkdown(report);
    const after2 = delivery.renderMarkdown(report);
    assert.strictEqual(after1, before, 'cached render must be byte-identical to parse-through render');
    assert.strictEqual(after2, before, 'repeat cached render must be stable');
  } finally {
    Date.now = origNow;
    delivery.clearCycleCache();
  }
});

// --- (d) unified helpers: single window + shared projection ------------------

test('single 7-day window constant is shared', () => {
  assert.strictEqual(changeMetric.QUOTA_WINDOW_MS, 7 * 24 * 3600 * 1000);
});

test('digest warn/crit dates agree with the shared projection core', () => {
  const hist = [
    { ts: NOW - 7 * DAY, monthly: 40 },
    { ts: NOW, monthly: 50 }
  ];
  const wi = delivery.windowInfo(hist, 'monthly', NOW);
  const proj = changeMetric.projectThresholds(wi, NOW);
  assert.ok(proj && proj.daysToWarn > 0, 'rising window must project a warn date');
  // 40 -> 50 over 7d => rate 10/7 %/d => (80-50)/(10/7) = 21 days.
  assert.ok(Math.abs(proj.daysToWarn - 21) < 1e-9, 'daysToWarn must be 21, got ' + proj.daysToWarn);
  const expectedWarn = changeMetric.humanDate(changeMetric.thresholdDateIso(NOW, proj.daysToWarn));
  const expectedCrit = changeMetric.humanDate(changeMetric.thresholdDateIso(NOW, proj.daysToCrit));
  assert.strictEqual(discordDigest.warnDateFor(hist, 'monthly', NOW), expectedWarn);
  assert.strictEqual(discordDigest.critDateFor(hist, 'monthly', NOW), expectedCrit);
});

test('unified projection matches the report ISO dates', () => {
  const dir = makeStateDir();
  quietDelivery(dir);
  const history = [
    { ts: NOW - 7 * DAY, rolling: 40, weekly: 40, monthly: 40 },
    { ts: NOW, rolling: 50, weekly: 50, monthly: 50 }
  ];
  fs.writeFileSync(path.join(dir, 'usage-history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, 'changelog.json'), JSON.stringify([]));
  const report = {
    generatedAt: '2026-09-05T00:00:00.000Z',
    pricing: { status: 'unchanged' },
    usage: { usage: { monthly: { percent: 50, resetsAt: '2026-10-01T00:00:00.000Z', status: 'ok' } } },
    pins: [],
    feedUpdates: []
  };
  const origNow = Date.now;
  Date.now = () => NOW;
  try {
    delivery.beginCycleCache();
    const md = delivery.renderMarkdown(report);
    const wi = delivery.windowInfo(history, 'monthly', NOW);
    const proj = changeMetric.projectThresholds(wi, NOW);
    const warnIso = changeMetric.thresholdDateIso(NOW, proj.daysToWarn);
    const critIso = changeMetric.thresholdDateIso(NOW, proj.daysToCrit);
    assert.ok(
      md.includes(`monthly projection: ~80% warn on ${warnIso}, ~95% crit on ${critIso}`),
      'report projection must use the shared helper dates'
    );
  } finally {
    Date.now = origNow;
    delivery.clearCycleCache();
  }
});
