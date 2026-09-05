'use strict';

// Unit tests for P1-3: model context-tier effective cost in alerts (#52).
//  - a tiered model (standard + large-context) renders BOTH tiers' effective
//    cost in the Discord model-change table (second line) and in report.md.
//  - a single-tier model (no `context_over_200k` / no numeric `tiers[]`) is
//    rendered UNCHANGED — no extra tier line.
//  - legacy / missing / string tiers degrade gracefully (no crash, no line).
//
// No network: delivery side-effects are disabled and a fixed usage table is
// injected via usageTable.setTable so the $60-credit multiplier is deterministic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const usageTable = require('../src/usage-table');

function setup(d) {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.setStateDir(d);
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
}

// A realistic tiered cost object: standard (<=200K) + large-context (>200K).
function tieredCost() {
  return {
    input: 0.5,
    output: 3,
    cache_read: 0.05,
    cache_write: 0.625,
    tiers: [{ input: 2, output: 6, cache_read: 0.2, cache_write: 2.5, tier: { type: 'context', size: 256000 } }],
    context_over_200k: { input: 2, output: 6, cache_read: 0.2, cache_write: 2.5 }
  };
}

test('tiered model: usage-table extracts both tiers and computes effective cost', () => {
  usageTable.setTable({ 'tiered-model': 60 }); // 1x multiplier
  try {
    const tiers = usageTable.effectiveTierCosts(tieredCost(), 'tiered-model');
    assert.strictEqual(tiers.length, 2, 'expected standard + large-context, got: ' + JSON.stringify(tiers));
    assert.strictEqual(tiers[0].label, 'standard');
    assert.strictEqual(tiers[1].label, 'large-context');
    // 1x multiplier => effective == list.
    assert.strictEqual(tiers[0].effective.input, 0.5);
    assert.strictEqual(tiers[1].effective.input, 2);
    assert.strictEqual(tiers[1].effective.output, 6);
  } finally {
    usageTable.setTable(null);
  }
});

test('tiered model: multiplier applies to both tiers', () => {
  usageTable.setTable({ 'tiered-model': 15 }); // 4x multiplier
  try {
    const tiers = usageTable.effectiveTierCosts(tieredCost(), 'tiered-model');
    assert.strictEqual(tiers.length, 2);
    assert.strictEqual(tiers[0].effective.input, 2); // 0.5 * 4
    assert.strictEqual(tiers[1].effective.input, 8); // 2 * 4
  } finally {
    usageTable.setTable(null);
  }
});

test('tiered model: Discord table renders both tiers on the second line', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-tier-'));
  try {
    setup(d);
    usageTable.setTable({ 'tiered-model': 60 });
    const captured = [];
    await delivery.deliverModelChangeTable(
      [{ subtype: 'cost', model: 'tiered-model', oldCost: { input: 0.1 }, newCost: tieredCost() }],
      { send: async (c) => captured.push(c) }
    );
    const body = captured.join('\n');
    assert.ok(captured.length > 0, 'expected a Discord post');
    assert.ok(body.includes('tiered-model tiers:'), 'tier line missing:\n' + body);
    assert.ok(body.includes('standard'), 'standard tier missing:\n' + body);
    assert.ok(body.includes('large-context'), 'large-context tier missing:\n' + body);
    // Effective (1x) costs must appear for both tiers.
    assert.ok(body.includes('i0.5') && body.includes('i2'), 'effective input costs missing:\n' + body);
    for (const c of captured) assert.ok(c.length <= 1900, 'chunk exceeded 1900 chars: ' + c.length);
  } finally {
    usageTable.setTable(null);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('tiered model: report.md surfaces both tiers under effective price', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-tier-'));
  try {
    setup(d);
    usageTable.setTable({ 'tiered-model': 60 });
    const report = {
      generatedAt: new Date().toISOString(),
      pricing: {
        status: 'ok',
        modelCount: 1,
        modelChanges: [
          { subtype: 'cost', model: 'tiered-model', oldCost: { input: 0.1 }, newCost: tieredCost() }
        ]
      }
    };
    const md = delivery.renderMarkdown(report);
    assert.ok(md.includes('tiered-model tiers:'), 'tier line missing in report.md:\n' + md);
    assert.ok(md.includes('standard'), 'standard tier missing in report.md:\n' + md);
    assert.ok(md.includes('large-context'), 'large-context tier missing in report.md:\n' + md);
  } finally {
    usageTable.setTable(null);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('untiered model: rendered unchanged (no tier line)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-tier-'));
  try {
    setup(d);
    usageTable.setTable({ 'flat-model': 60 });
    const captured = [];
    await delivery.deliverModelChangeTable(
      [{ subtype: 'cost', model: 'flat-model', oldCost: { input: 0.1 }, newCost: { input: 0.14, output: 1.1 } }],
      { send: async (c) => captured.push(c) }
    );
    const body = captured.join('\n');
    assert.ok(!body.includes('tiers:'), 'untiered model must NOT render a tier line:\n' + body);

    const md = delivery.renderMarkdown({
      generatedAt: new Date().toISOString(),
      pricing: {
        status: 'ok',
        modelCount: 1,
        modelChanges: [
          { subtype: 'cost', model: 'flat-model', oldCost: { input: 0.1 }, newCost: { input: 0.14, output: 1.1 } }
        ]
      }
    });
    assert.ok(!md.includes('tiers:'), 'report.md must NOT render a tier line for untiered model:\n' + md);
  } finally {
    usageTable.setTable(null);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('missing / legacy string tiers: no crash and no tier line', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-tier-'));
  try {
    setup(d);
    usageTable.setTable({ 'legacy-model': 60 });
    // Legacy api.json shape: tiers is an array of strings (no numeric prices).
    const legacyCost = { input: 0.14, output: 1.1, tiers: ['free'] };
    const tiers = usageTable.effectiveTierCosts(legacyCost, 'legacy-model');
    assert.deepStrictEqual(tiers, [], 'string tiers must yield no tier lines');

    const captured = [];
    await delivery.deliverModelChangeTable(
      [{ subtype: 'cost', model: 'legacy-model', oldCost: { input: 0.1 }, newCost: legacyCost }],
      { send: async (c) => captured.push(c) }
    );
    assert.ok(!captured.join('\n').includes('tiers:'), 'legacy string tiers must not render a line:\n' + captured.join('\n'));

    // Missing tiers field entirely + null.
    assert.deepStrictEqual(usageTable.effectiveTierCosts(null, 'x'), []);
    assert.deepStrictEqual(usageTable.effectiveTierCosts({ input: 0 }, 'x'), [], 'single-tier (no alternate) must yield none');
  } finally {
    usageTable.setTable(null);
    fs.rmSync(d, { recursive: true, force: true });
  }
});
