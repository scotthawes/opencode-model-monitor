'use strict';

// Unit tests for v0.10.0: the cheapest-effective-cost leaderboard (calc.js).
//  - leaderboard() ranks by effective cost/request ascending
//  - each row carries cap + multiplier + requestsPerMo
//  - a lower cap (more expensive) still sorts by effective cost, not by cap
//  - limit caps the output

const test = require('node:test');
const assert = require('node:assert');

const calc = require('../src/calc');
const usageTable = require('../src/usage-table');

// Distinct costs so the effective $/request ordering is unambiguous.
const MODELS = {
  'tiny': { cost: { input: 0.01, output: 0.02, cache_read: 0.002, cache_write: 0.012 } },
  'mid': { cost: { input: 1.0, output: 2.0, cache_read: 0.2, cache_write: 1.2 } },
  'big': { cost: { input: 50.0, output: 90.0, cache_read: 10.0, cache_write: 60.0 } }
};

test('leaderboard ranks by effective cost/request ascending and carries cap', () => {
  usageTable.setTable(null); // all default cap 60 -> 1x
  try {
    const lb = calc.leaderboard(MODELS, calc.DEFAULT_PATTERN);
    assert.strictEqual(lb.length, 3);
    assert.strictEqual(lb[0].id, 'tiny');
    assert.strictEqual(lb[lb.length - 1].id, 'big');
    for (let i = 1; i < lb.length; i++) {
      assert.ok(lb[i].effective >= lb[i - 1].effective, 'not ascending at ' + i);
    }
    // every row carries the public fields
    for (const r of lb) {
      assert.ok(typeof r.cap === 'number', 'cap missing on ' + r.id);
      assert.ok(typeof r.multiplier === 'number', 'multiplier missing on ' + r.id);
      assert.ok(typeof r.requestsPerMo === 'number' || !isFinite(r.requestsPerMo), 'req/mo missing on ' + r.id);
    }
  } finally {
    usageTable.setTable(null);
  }
});

test('leaderboard reflects a lower cap (more expensive) via the multiplier', () => {
  // One model, same list cost: a $15 cap (4x) must make it 4x more expensive
  // than a $60 cap (1x). This is the user's #2 priority — moving caps = price.
  const COST = { input: 1.0, output: 2.0, cache_read: 0.2, cache_write: 1.2 };
  usageTable.setTable({ 'x': 15 });
  let lb15;
  try {
    lb15 = calc.leaderboard({ 'x': { cost: COST } }, calc.DEFAULT_PATTERN)[0];
  } finally {
    usageTable.setTable(null);
  }
  usageTable.setTable({ 'x': 60 });
  let lb60;
  try {
    lb60 = calc.leaderboard({ 'x': { cost: COST } }, calc.DEFAULT_PATTERN)[0];
  } finally {
    usageTable.setTable(null);
  }
  assert.strictEqual(lb15.multiplier, 4);
  assert.strictEqual(lb60.multiplier, 1);
  assert.ok(lb15.effective > lb60.effective, 'lower cap => more expensive effective cost');
  assert.ok(Math.abs(lb15.effective / lb60.effective - 4) < 1e-9, '4x ratio holds');
});

test('leaderboard limit caps output', () => {
  usageTable.setTable(null);
  try {
    const lb = calc.leaderboard(MODELS, calc.DEFAULT_PATTERN, 2);
    assert.strictEqual(lb.length, 2);
    assert.strictEqual(lb[0].id, 'tiny');
  } finally {
    usageTable.setTable(null);
  }
});

test('parseArgs recognizes --leaderboard', () => {
  const a = calc.parseArgs(['--leaderboard']);
  assert.strictEqual(a.leaderboard, true);
});
