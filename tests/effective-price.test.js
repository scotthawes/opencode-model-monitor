'use strict';

// Unit tests for P0-3: effective price after the $60 credit multiplier (#49).
//  - multiplier math: usage cap 15 -> 4x, 60 -> 1x, 30 -> 2x, 100 -> 0.6x
//  - unknown model falls back to default cap 60 (-> 1x)
//  - a table override is honored in effectiveMultiplier / effectiveCost
//  - the Discord model-change table renders the Effx column and stays <=1900 chars
//  - report.md surfaces an effective-price line for cost-changed models

const test = require('node:test');
const assert = require('node:assert');

const usageTable = require('../src/usage-table');
const delivery = require('../src/delivery');

test('multiplier math: 60/cap', () => {
  assert.strictEqual(usageTable.multiplierForCap(15), 4);
  assert.strictEqual(usageTable.multiplierForCap(60), 1);
  assert.strictEqual(usageTable.multiplierForCap(30), 2);
  assert.strictEqual(usageTable.multiplierForCap(100), 0.6);
  // non-positive / non-finite cap is rejected (defensive)
  assert.strictEqual(usageTable.multiplierForCap(0), null);
  assert.strictEqual(usageTable.multiplierForCap(-5), null);
  assert.strictEqual(usageTable.multiplierForCap('nope'), null);
});

test('unknown model falls back to default cap 60 (-> 1x)', () => {
  usageTable.setTable(null); // ensure disk/default table
  assert.strictEqual(usageTable.getUsageCap('no-such-model-xyz'), 60);
  assert.strictEqual(usageTable.effectiveMultiplier('no-such-model-xyz'), 1);
  const eff = usageTable.effectiveCost({ input: 0.14, output: 1.1 }, 'no-such-model-xyz');
  assert.strictEqual(eff.input, 0.14);
  assert.strictEqual(eff.output, 1.1);
});

test('table override is honored in multiplier and effective cost', () => {
  usageTable.setTable({ 'cheap-cap': 15, 'premium-cap': 100 });
  try {
    assert.strictEqual(usageTable.getUsageCap('cheap-cap'), 15);
    assert.strictEqual(usageTable.effectiveMultiplier('cheap-cap'), 4);
    assert.strictEqual(usageTable.effectiveMultiplier('premium-cap'), 0.6);
    const eff = usageTable.effectiveCost(
      { input: 0.1, output: 0.4, cache_read: 0.02, cache_write: 0.2 },
      'cheap-cap'
    );
    assert.strictEqual(eff.input, 0.4);
    assert.strictEqual(eff.output, 1.6);
    assert.strictEqual(eff.cache_read, 0.08);
    assert.strictEqual(eff.cache_write, 0.8);
    // non-numeric metrics are dropped
    assert.deepStrictEqual(
      usageTable.effectiveCost({ input: 'x' }, 'cheap-cap'),
      {}
    );
  } finally {
    usageTable.setTable(null);
  }
});

test('Discord model-change table renders Effx column and stays <=1900 chars', () => {
  const rows = [
    {
      subtype: 'cost',
      model: 'hy3',
      oldCost: { input: 0.0175, output: 0.14 },
      newCost: { input: 0.14, output: 1.1 }
    }
  ];
  const body = delivery.buildModelChangeChunks(rows, []).join('\n');
  assert.ok(body.includes('Eff×'), 'Effx header missing:\n' + body);
  assert.ok(body.includes('1x'), 'default multiplier (1x) missing:\n' + body);
  assert.ok(body.includes('0.14'), 'new input cost missing:\n' + body);
  assert.ok(body.includes('→'), 'arrow missing:\n' + body);
  for (const c of delivery.buildModelChangeChunks(rows, [])) {
    assert.ok(c.length <= 1900, 'chunk exceeded 1900 chars: ' + c.length);
  }
});

test('report.md surfaces effective price line for cost-changed models', () => {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    require('os').tmpdir()
  );
  const report = {
    generatedAt: new Date().toISOString(),
    pricing: {
      status: 'ok',
      modelCount: 1,
      modelChanges: [
        {
          subtype: 'cost',
          model: 'hy3',
          oldCost: { input: 0.0175, output: 0.14 },
          newCost: { input: 0.14, output: 1.1 }
        }
      ]
    }
  };
  const md = delivery.renderMarkdown(report);
  assert.ok(md.includes('Effective price (after $60 credit multiplier)'), 'section missing:\n' + md);
  assert.ok(md.includes('hy3'), 'model missing:\n' + md);
  assert.ok(md.includes('input 0.14'), 'effective input missing:\n' + md);
});

test('effective cost is computed at render (raw snapshot unchanged)', () => {
  // The effective cost helper never mutates the input cost object.
  usageTable.setTable({ 'cheap-cap': 15 });
  try {
    const raw = { input: 0.1, output: 0.4 };
    const before = JSON.stringify(raw);
    usageTable.effectiveCost(raw, 'cheap-cap');
    assert.strictEqual(JSON.stringify(raw), before, 'input cost mutated');
  } finally {
    usageTable.setTable(null);
  }
});
