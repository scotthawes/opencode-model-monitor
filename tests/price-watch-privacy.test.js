'use strict';

// Unit + integration tests for v0.11.0 (Closes #83): privacy/training-status
// change detection (dormant unless api.json carries a `privacy` block) and
// free-model available-duration tracking (availableFrom on add, duration on
// remove like "19 days"). No network beyond a mocked fetch.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const { runPriceWatch, extractPrivacy, detectPrivacyChanges, formatFreeDuration } = require('../src/price-watch');
const events = require('../src/events');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-priv-'));
}

function setup(d) {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.setStateDir(d);
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
}

function mockFetchWithZen(goCatalog, zenCatalog) {
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ 'opencode-go': { models: goCatalog }, 'opencode': { models: zenCatalog || {} } })
  });
}

function writeSnapshot(d, models) {
  fs.writeFileSync(path.join(d, 'pricing-snapshot.json'), JSON.stringify(models, null, 2));
}

const mk = (cost, tiers = null) => ({ cost, tiers });

// --- Pure helpers --------------------------------------------------------

test('extractPrivacy parses a privacy block and returns null without one', () => {
  assert.deepStrictEqual(
    extractPrivacy({ privacy: { training: 'ZDR-not-renewed', zdrValidUntil: '2026-09-30' } }),
    { training: 'ZDR-not-renewed', zdrValidUntil: '2026-09-30' }
  );
  assert.strictEqual(extractPrivacy({}), null);
  assert.strictEqual(extractPrivacy({ privacy: {} }), null);
  assert.strictEqual(extractPrivacy(null), null);
});

test('detectPrivacyChanges returns a descriptor only on a real change', () => {
  assert.strictEqual(detectPrivacyChanges('m', null, null), null);
  const a = { training: 'X' };
  const b = { zdrValidUntil: '2026-09-30' };
  const ch = detectPrivacyChanges('m', a, b);
  assert.ok(ch, 'change expected');
  assert.strictEqual(ch.model, 'm');
  assert.deepStrictEqual(ch.old, a);
  assert.deepStrictEqual(ch.new, b);
});

test('formatFreeDuration renders days / hours / minutes', () => {
  const DAY = 86400000;
  assert.strictEqual(formatFreeDuration(16 * DAY), '16 days');
  assert.strictEqual(formatFreeDuration(1 * DAY), '1 day');
  assert.strictEqual(formatFreeDuration(5 * DAY + 3 * 3600000), '5 days');
  assert.strictEqual(formatFreeDuration(3 * 3600000), '3 hours');
  assert.strictEqual(formatFreeDuration(2 * 60000), '2 minutes');
  assert.strictEqual(formatFreeDuration(-100), '1 minute');
});

// --- Integration ----------------------------------------------------------

test('privacy-changed event is logged when api.json carries a privacy move', async () => {
  const d = tmpDir();
  try {
    setup(d);
    events._resetDedup();
    // First run: seed prior privacy (ZDR valid until Aug 31).
    writeSnapshot(d, {
      'ds-v4': Object.assign(mk({ input: 0.1 }), { privacy: { zdrValidUntil: '2026-08-31' }, meta: { name: 'DS V4' } })
    });
    mockFetchWithZen({ 'ds-v4': Object.assign(mk({ input: 0.1 }), { privacy: { training: 'ZDR-not-renewed' }, meta: { name: 'DS V4' } }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Privacy changed for ds-v4')),
      'expected a privacy change line, got: ' + JSON.stringify(r.changes)
    );
    const life = events.getModelLife(d, 'ds-v4');
    assert.ok(life.some((e) => e.type === 'privacy-changed' && e.new && e.new.training === 'ZDR-not-renewed'),
      'privacy-changed event logged');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('free-model removal records an available-duration', async () => {
  const d = tmpDir();
  try {
    setup(d);
    events._resetDedup();
    // Prior snapshot: a free model first seen 19 days ago.
    const addedAt = new Date(Date.now() - 19 * 86400000).toISOString();
    writeSnapshot(d, {
      a: mk({ input: 1 }),
      freeModels: { 'zenmodel-free': { cost: { input: 0 }, addedAt } }
    });
    // Zen catalog no longer lists the free model -> removal.
    mockFetchWithZen({ a: mk({ input: 1 }) }, {});
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Free model removed: zenmodel-free')),
      'expected a free-removed line, got: ' + JSON.stringify(r.changes)
    );
    const life = events.getModelLife(d, 'zenmodel-free');
    const removed = life.find((e) => e.type === 'free-removed');
    assert.ok(removed, 'free-removed event present');
    assert.ok(typeof removed.duration === 'string' && /day/.test(removed.duration), 'duration recorded: ' + removed.duration);
    assert.strictEqual(removed.availableFrom, addedAt, 'availableFrom preserved from prior snapshot');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('free-model add records an availableFrom', async () => {
  const d = tmpDir();
  try {
    setup(d);
    events._resetDedup();
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetchWithZen({ a: mk({ input: 1 }) }, { 'zenmodel-free': mk({ input: 0 }) });
    const r = await runPriceWatch(d);
    assert.ok(r.freeModels.includes('zenmodel-free'), 'free model tracked');
    const life = events.getModelLife(d, 'zenmodel-free');
    const added = life.find((e) => e.type === 'free-available');
    assert.ok(added, 'free-available event present');
    assert.ok(typeof added.availableFrom === 'string' && !isNaN(Date.parse(added.availableFrom)), 'availableFrom recorded');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
