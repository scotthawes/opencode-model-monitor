'use strict';

// Unit tests for the shared change-metric helpers (Closes #75):
//  - Δ% / × / $ math from old->new
//  - zero-old (brand-new price) handled gracefully as "new"
//  - direction -> color mapping (green=down, red=up, grey=flat)

const test = require('node:test');
const assert = require('node:assert');
const cm = require('../src/change-metric');

test('changeParts computes pct / mult / abs for a mid-range move', () => {
  const p = cm.changeParts(0.0725, 0.58);
  assert.ok(p, 'comparable');
  // 0.5075 / 0.0725 = 7.0 -> 700%
  assert.strictEqual(Math.round(p.pct), 700);
  assert.ok(Math.abs(p.mult - 8) < 1e-9, 'mult ~8x');
  assert.ok(Math.abs(p.abs - 0.5075) < 1e-9, 'abs ~0.5075');
  assert.strictEqual(p.direction, 'up');
});

test('fmtChangeMetric matches the spec example "+700% (8x, +$0.5075)"', () => {
  assert.strictEqual(cm.fmtChangeMetric(0.0725, 0.58), '+700% (8x, +$0.5075)');
});

test('a decrease formats as green-ward negative percent', () => {
  const s = cm.fmtChangeMetric(1.0, 0.5);
  assert.strictEqual(s, '-50% (0.5x, -$0.5)');
  assert.strictEqual(cm.changeParts(1.0, 0.5).direction, 'down');
});

test('zero-old (new price) is reported as "new", never Infinity', () => {
  const p = cm.changeParts(0, 0.58);
  assert.strictEqual(p.isNew, true);
  assert.strictEqual(p.direction, 'up');
  assert.strictEqual(cm.fmtChangeMetric(0, 0.58), 'new');
  assert.strictEqual(cm.fmtFeedPct(0, 0.58), '(new)');
});

test('unchanged price yields 0% / flat', () => {
  const p = cm.changeParts(0.5, 0.5);
  assert.strictEqual(p.pct, 0);
  assert.strictEqual(p.direction, 'flat');
  assert.strictEqual(cm.fmtChangeMetric(0.5, 0.5), '0% (1x, $0)');
});

test('0→0 renders 0% / 1x (not 0x), never "new"', () => {
  const p = cm.changeParts(0, 0);
  assert.strictEqual(p.isNew, false);
  assert.strictEqual(p.direction, 'flat');
  assert.strictEqual(p.pct, 0);
  assert.strictEqual(p.mult, 1);
  assert.strictEqual(cm.fmtChangeMetric(0, 0), '0% (1x, $0)');
  assert.strictEqual(cm.fmtMult(p), '1x');
});

test('non-numeric sides are not comparable', () => {
  assert.strictEqual(cm.changeParts(null, 1), null);
  assert.strictEqual(cm.changeParts(1, undefined), null);
  assert.strictEqual(cm.fmtChangeMetric(undefined, 1), '');
});

test('directionColor maps down->green, up->red, flat->grey', () => {
  assert.strictEqual(cm.directionColor('down'), '#27ae60');
  assert.strictEqual(cm.directionColor('up'), '#c0392b');
  assert.strictEqual(cm.directionColor('flat'), '#95a5a6');
});

test('fmtMoney is the single money rule: — when missing, $+trimNum otherwise', () => {
  assert.strictEqual(cm.fmtMoney(null), '—');
  assert.strictEqual(cm.fmtMoney(undefined), '—');
  assert.strictEqual(cm.fmtMoney(NaN), '—');
  assert.strictEqual(cm.fmtMoney(0.5075), '$0.5075');
  assert.strictEqual(cm.fmtMoney(0), '$0');
});

test('trimNum round-trips non-integer cap factors without float artifacts', () => {
  // 60/45 = 1.333333... — the factor must render cleanly, not as 1.33 or
  // 1.3333333333333333.
  assert.strictEqual(cm.trimNum(60 / 45), '1.33333');
  assert.strictEqual(cm.trimNum(60 / 100), '0.6');
  assert.strictEqual(cm.trimNum(4), '4');
});

test('projectThresholds bounds warn/crit dates by resetsAt', () => {
  const NOW = Date.parse('2026-09-05T00:00:00.000Z');
  const DAY = 864e5;
  // 40 -> 50 over 7d => warn in 21d, crit in 31.5d (unbounded).
  const wi = { current: 50, delta: 10, daysElapsed: 7 };
  const unbounded = cm.projectThresholds(wi, NOW);
  assert.ok(Math.abs(unbounded.daysToCrit - 31.5) < 1e-9, 'unbounded crit 31.5d');
  assert.strictEqual(unbounded.bounded, false);
  // Reset in 26d (Oct 1): warn (21d) stands, crit caps at the reset horizon.
  const bounded = cm.projectThresholds(wi, NOW, '2026-10-01T00:00:00.000Z');
  assert.ok(Math.abs(bounded.daysToWarn - 21) < 1e-9, 'warn before reset stands');
  assert.ok(Math.abs(bounded.daysToCrit - 26) < 1e-9, 'crit capped at reset, got ' + bounded.daysToCrit);
  assert.strictEqual(bounded.bounded, true);
  // Reset far out (or absent/unparseable) leaves projections untouched.
  const far = cm.projectThresholds(wi, NOW, '2027-01-01T00:00:00.000Z');
  assert.ok(Math.abs(far.daysToCrit - 31.5) < 1e-9, 'far reset does not bind');
  assert.strictEqual(far.bounded, false);
  const noReset = cm.projectThresholds(wi, NOW, 'garbage');
  assert.ok(Math.abs(noReset.daysToCrit - 31.5) < 1e-9, 'unparseable reset does not bind');
});
