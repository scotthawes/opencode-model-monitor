'use strict';

// Unit tests for P1-1: local read-only calculator CLI (Closes #50).
//  - cost-per-request math with a known cost shape
//  - default token pattern is applied when none is given
//  - effective price scales by the 60/usageCap multiplier
//  - unknown model -> findModel returns null (CLI exits non-zero)
//  - rankByEffective returns cheapest-effective first, capped at top 5
//  - fuzzy matching resolves case/subset/token variants

const test = require('node:test');
const assert = require('node:assert');

const calc = require('../src/calc');
const usageTable = require('../src/usage-table');

// qwen3.7-max live cost shape (USD / 1M tokens).
const KNOWN_COST = { input: 2.5, output: 7.5, cache_read: 0.5, cache_write: 3.125 };

// Expected raw cost/request for KNOWN_COST under the default pattern
// (390 input / 32500 cachedRead / 120 output), with the 5%/95% split:
//   2.5*(390*0.05)/1e6 + 3.125*(390*0.95)/1e6 + 0.5*32500/1e6 + 7.5*120/1e6
const EXPECTED_RAW = 0.00004875 + 0.0011578125 + 0.01625 + 0.0009; // 0.0183565625

test('costPerRequest matches hand-computed value for a known cost', () => {
  const got = calc.costPerRequest(KNOWN_COST, calc.DEFAULT_PATTERN);
  assert.ok(Math.abs(got - EXPECTED_RAW) < 1e-12, `got ${got}, expected ${EXPECTED_RAW}`);
});

test('default pattern is used when none is supplied', () => {
  assert.strictEqual(calc.costPerRequest(KNOWN_COST), calc.costPerRequest(KNOWN_COST, calc.DEFAULT_PATTERN));
});

test('costPerRequest degrades when cache_write is missing', () => {
  // No cache_write price -> whole prompt billed at list input rate.
  const noWrite = { input: 2.5, output: 7.5, cache_read: 0.5 };
  const p = calc.DEFAULT_PATTERN;
  const got = calc.costPerRequest(noWrite, p);
  const expected = (2.5 * p.input + 0.5 * p.cachedRead + 7.5 * p.output) / 1e6;
  assert.ok(Math.abs(got - expected) < 1e-12, `got ${got}, expected ${expected}`);
});

test('effective cost scales by the 60/usageCap multiplier', () => {
  usageTable.setTable({ 'tm-eff': 15 }); // 60/15 = 4x
  try {
    const eff = calc.effectiveCostPerRequest(KNOWN_COST, 'tm-eff', calc.DEFAULT_PATTERN);
    assert.ok(Math.abs(eff - EXPECTED_RAW * 4) < 1e-12, `eff ${eff}`);
    assert.strictEqual(usageTable.effectiveMultiplier('tm-eff'), 4);
  } finally {
    usageTable.setTable(null);
  }
});

test('requests/month = 60 / effectiveCost', () => {
  usageTable.setTable({ 'tm-rm': 60 }); // 1x
  try {
    const eff = calc.effectiveCostPerRequest(KNOWN_COST, 'tm-rm', calc.DEFAULT_PATTERN);
    const rpm = calc.requestsPerMonth(eff);
    assert.ok(Math.abs(rpm - 60 / eff) < 1e-9);
    assert.ok(Math.abs(rpm - 3268.88) < 1); // ~3268 requests/month
  } finally {
    usageTable.setTable(null);
  }
});

test('unknown model -> findModel returns null (CLI errors)', () => {
  const models = { 'alpha-1': { cost: KNOWN_COST }, 'beta-2': { cost: KNOWN_COST } };
  assert.strictEqual(calc.findModel(models, 'zzz-no-such'), null);
  assert.strictEqual(calc.findModel(models, ''), null);
  assert.strictEqual(calc.findModel({}, 'anything'), null);
});

test('fuzzy matching resolves exact, case-insensitive, and substring', () => {
  const models = { 'qwen3.7-max': { cost: KNOWN_COST }, 'deepseek-v4': { cost: KNOWN_COST } };
  assert.strictEqual(calc.findModel(models, 'qwen3.7-max'), 'qwen3.7-max');
  assert.strictEqual(calc.findModel(models, 'QWEN3.7-MAX'), 'qwen3.7-max');
  assert.strictEqual(calc.findModel(models, 'qwen3.7'), 'qwen3.7-max'); // substring
  assert.strictEqual(calc.findModel(models, 'deep'), 'deepseek-v4'); // substring
});

test('rankByEffective returns cheapest-effective first, capped at top 5', () => {
  // Build 7 models with distinct effective costs. Caps vary so the multiplier
  // matters; costs are chosen so ordering is unambiguous under the default pattern.
  const models = {
    'm-cheap': { cost: { input: 0.1, output: 0.2, cache_read: 0.02, cache_write: 0.12 } },
    'm-mid': { cost: { input: 1.0, output: 2.0, cache_read: 0.2, cache_write: 1.2 } },
    'm-pricey': { cost: { input: 5.0, output: 10.0, cache_read: 1.0, cache_write: 6.0 } },
    'm-ultra': { cost: { input: 20.0, output: 40.0, cache_read: 4.0, cache_write: 24.0 } },
    'm-tiny': { cost: { input: 0.01, output: 0.02, cache_read: 0.002, cache_write: 0.012 } },
    'm-big': { cost: { input: 50.0, output: 90.0, cache_read: 10.0, cache_write: 60.0 } },
    'm-huge': { cost: { input: 200.0, output: 400.0, cache_read: 40.0, cache_write: 240.0 } }
  };
  // All unknown -> default cap 60 -> 1x, so ordering follows raw cost/request.
  usageTable.setTable(null);
  const ranked = calc.rankByEffective(models, calc.DEFAULT_PATTERN, 5);
  assert.strictEqual(ranked.length, 5, 'should be capped at top 5');
  // Strictly ascending effective cost.
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      ranked[i].effective >= ranked[i - 1].effective,
      `ordering broken at ${i}: ${ranked[i - 1].id}(${ranked[i - 1].effective}) -> ${ranked[i].id}(${ranked[i].effective})`
    );
  }
  // Cheapest is m-tiny; 5th is m-ultra (m-big/m-huge excluded by the limit).
  assert.strictEqual(ranked[0].id, 'm-tiny');
  assert.strictEqual(ranked[ranked.length - 1].id, 'm-ultra');

  // Without a limit, all 7 models are ranked.
  assert.strictEqual(calc.rankByEffective(models, calc.DEFAULT_PATTERN).length, 7);
});

test('parseArgs parses --pattern and positional model', () => {
  const a = calc.parseArgs(['qwen3.7-max', '--pattern', '100,5000,50']);
  assert.strictEqual(a.model, 'qwen3.7-max');
  assert.deepStrictEqual(a.pattern, { input: 100, cachedRead: 5000, output: 50 });

  const b = calc.parseArgs(['gpt', '-p', '1,2,3']);
  assert.strictEqual(b.model, 'gpt');
  assert.deepStrictEqual(b.pattern, { input: 1, cachedRead: 2, output: 3 });

  // Missing/invalid pattern throws.
  assert.throws(() => calc.parseArgs(['m', '--pattern', 'bad']));
  assert.throws(() => calc.parseArgs(['m', '-p', '1,2']));
});
