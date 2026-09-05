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
