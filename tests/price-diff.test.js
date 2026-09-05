'use strict';

// Unit tests for the price-watch diff logic (added / removed / cost / tiers).
// No network: global.fetch is mocked to return a fixed catalog, and a previous
// snapshot is seeded into a temp state dir so we exercise the real diff path.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const { runPriceWatch } = require('../src/price-watch');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-price-'));
}

function setup(d) {
  // Keep all delivery side-effects off the real state dir / subscribers.
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.setStateDir(d);
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
}

function mockFetch(catalog) {
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ 'opencode-go': { models: catalog } })
  });
}

function writeSnapshot(d, models) {
  fs.writeFileSync(
    path.join(d, 'pricing-snapshot.json'),
    JSON.stringify(models, null, 2)
  );
}

const mk = (cost, tiers = null) => ({ cost, tiers });

test('detects an added model', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetch({ a: mk({ input: 1 }), b: mk({ input: 2 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Added model: b')),
      'expected an "Added model: b" change, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('detects a removed model', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }), b: mk({ input: 2 }) });
    mockFetch({ a: mk({ input: 1 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Removed model: b')),
      'expected a "Removed model: b" change, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('detects a cost change (old -> new)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetch({ a: mk({ input: 2 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Cost changed for a:') && c.includes('{"input":1}') && c.includes('{"input":2}')),
      'expected a cost-change line with old/new values, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('detects a tiers change', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }, ['free']) });
    mockFetch({ a: mk({ input: 1 }, ['paid']) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Tiers changed for a')),
      'expected a "Tiers changed for a" change, got: ' + JSON.stringify(r.changes)
    );
    // Cost was unchanged, so no cost-change line.
    assert.ok(
      !r.changes.some((c) => c.includes('Cost changed for a')),
      'cost should NOT be reported as changed'
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('no diff when catalog is identical', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetch({ a: mk({ input: 1 }) });
    const r = await runPriceWatch(d);
    assert.strictEqual(r.changes.length, 0, 'expected zero changes, got: ' + JSON.stringify(r.changes));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
