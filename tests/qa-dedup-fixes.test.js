'use strict';

// Regression tests for QA issue #85: privacy redup (BUG 1), event double-write
// (BUG 2), and pure-letter id dedup (BUG 3). No network beyond a mocked fetch.
// Each test isolates its own temp state dir + in-process dedup Set.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const { runPriceWatch, extractPrivacy, detectPrivacyChanges } = require('../src/price-watch');
const events = require('../src/events');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-qa85-'));
}

function setup(d) {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.setStateDir(d);
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
  events._resetDedup();
}

function mockFetch(goCatalog, zenCatalog) {
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

// ---------------------------------------------------------------------------
// BUG 1 (major): privacy diff must not re-emit every cycle.
// Capture prevPrivacy before the strip so run-2 reads the real baseline and
// suppresses an unchanged privacy block (instead of re-firing "Privacy changed").
// ---------------------------------------------------------------------------

test('BUG1: unchanged privacy is NOT re-emitted on a second run', async () => {
  const d = tmpDir();
  try {
    setup(d);
    // Run 1: seed a privacy block in the baseline snapshot (first sighting fires).
    writeSnapshot(d, {
      beta: Object.assign(mk({ input: 0.1 }), {
        privacy: { training: 'ZDR-not-renewed', zdrValidUntil: '2026-09-30' },
        meta: { name: 'Beta' }
      })
    });
    mockFetch({
      beta: Object.assign(mk({ input: 0.1 }), {
        privacy: { training: 'ZDR-not-renewed', zdrValidUntil: '2026-09-30' },
        meta: { name: 'Beta' }
      })
    });
    const r1 = await runPriceWatch(d);
    assert.ok(
      r1.changes.some((c) => c.includes('Privacy changed for beta')),
      'run-1 should fire the first privacy sighting, got: ' + JSON.stringify(r1.changes)
    );

    // Run 2: identical privacy block. The captured prevPrivacy baseline must
    // suppress the duplicate emission.
    mockFetch({
      beta: Object.assign(mk({ input: 0.1 }), {
        privacy: { training: 'ZDR-not-renewed', zdrValidUntil: '2026-09-30' },
        meta: { name: 'Beta' }
      })
    });
    const r2 = await runPriceWatch(d);
    assert.ok(
      !r2.changes.some((c) => c.includes('Privacy changed for beta')),
      'run-2 must NOT re-emit an unchanged privacy block (redup), got: ' + JSON.stringify(r2.changes)
    );

    // Exactly one privacy-changed event on disk across both runs.
    const life = events.getModelLife(d, 'beta');
    const priv = life.filter((e) => e.type === 'privacy-changed');
    assert.strictEqual(priv.length, 1, 'exactly one privacy-changed event expected, got: ' + priv.length);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('BUG1: a real privacy move is still detected', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, {
      beta: Object.assign(mk({ input: 0.1 }), {
        privacy: { zdrValidUntil: '2026-08-31' },
        meta: { name: 'Beta' }
      })
    });
    mockFetch({
      beta: Object.assign(mk({ input: 0.1 }), {
        privacy: { training: 'ZDR-not-renewed', zdrValidUntil: '2026-09-30' },
        meta: { name: 'Beta' }
      })
    });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Privacy changed for beta')),
      'a genuine privacy move must be detected, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BUG 2 (minor): a single cost/added/removed/tiers change must write exactly
// ONE event to the JSONL log (the table-path write in delivery.js). The old
// second write from price-watch.js was removed, so we no longer get a duplicate
// record with a different ts.
// ---------------------------------------------------------------------------

test('BUG2: a cost change writes exactly one event (no double-write)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    // Run 1: baseline cost.
    writeSnapshot(d, { hy3: mk({ input: 1, output: 2 }) });
    mockFetch({ hy3: mk({ input: 1, output: 2 }) });
    await runPriceWatch(d);

    // Run 2: cost changes.
    mockFetch({ hy3: mk({ input: 3, output: 6 }) });
    await runPriceWatch(d);

    const life = events.getModelLife(d, 'hy3');
    const cost = life.filter((e) => e.type === 'cost-changed');
    assert.strictEqual(cost.length, 1, 'exactly one cost-changed event expected, got: ' + cost.length);
    assert.deepStrictEqual(cost[0].old, { input: 1, output: 2 });
    assert.deepStrictEqual(cost[0].new, { input: 3, output: 6 });
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BUG 3 (major): pure-letter model ids (beta, gpt) must produce a dedup key
// via the message fallback instead of returning null. The explicit-message
// regex (step 1) is still preferred for our own structured phrasing, and a
// digit/hyphen-bearing id still wins over a pure-letter word.
// ---------------------------------------------------------------------------

test('BUG3: pure-letter id yields a non-null fallback dedup key', () => {
  delivery.setKnownModelIds(new Set());
  // Empty/neutral title isolates the fallback scan so the model token wins.
  assert.strictEqual(delivery.computeDedupKey('', 'beta'), 'model:beta');
  assert.strictEqual(delivery.computeDedupKey('', 'gpt'), 'model:gpt');
});

test('BUG3: explicit "added model" phrasing parses a pure-letter id (step 1)', () => {
  delivery.setKnownModelIds(new Set());
  assert.strictEqual(delivery.computeDedupKey('Model changed', 'Added model: beta'), 'model:beta');
});

test('BUG3: explicit "cost changed for" phrasing parses a pure-letter id (step 1)', () => {
  delivery.setKnownModelIds(new Set());
  assert.strictEqual(
    delivery.computeDedupKey('Model changed', 'Cost changed for beta: {"input":1} -> {"input":2}'),
    'model:beta'
  );
});

test('BUG3: explicit "removed model" phrasing parses a pure-letter id (step 1)', () => {
  delivery.setKnownModelIds(new Set());
  assert.strictEqual(delivery.computeDedupKey('Model changed', 'Removed model: gpt'), 'model:gpt');
});

test('BUG3: digit/hyphen-bearing id still preferred over a pure-letter word', () => {
  delivery.setKnownModelIds(new Set());
  assert.strictEqual(delivery.computeDedupKey('', 'alpha hy3'), 'model:hy3');
});

test('BUG3 helpers remain pure', () => {
  assert.strictEqual(extractPrivacy({}), null);
  assert.strictEqual(detectPrivacyChanges('m', { training: 'X' }, { training: 'X' }), null);
  assert.ok(detectPrivacyChanges('m', { training: 'X' }, { training: 'Y' }));
});
