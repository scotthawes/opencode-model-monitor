'use strict';

// Unit tests for the 7-day quota projection math exposed by delivery.windowInfo
// and discord-digest.warnDateFor: stable (no increase), already-at/above warn
// threshold, and linear rate -> projected warn/crit dates.

const test = require('node:test');
const assert = require('node:assert');

const delivery = require('../src/delivery');
const discordDigest = require('../src/discord-digest');

const DAY = 864e5;
// Fixed "now" so date math is deterministic across runs.
const NOW = Date.parse('2026-09-05T00:00:00.000Z');

function historyFor(monthlyOld, monthlyNew, ageDays = 7) {
  return [
    { ts: NOW - ageDays * DAY, monthly: monthlyOld },
    { ts: NOW, monthly: monthlyNew }
  ];
}

test('windowInfo computes current/oldest/delta/daysElapsed', () => {
  const hist = historyFor(40, 50);
  const wi = delivery.windowInfo(hist, 'monthly', NOW);
  assert.strictEqual(wi.current, 50);
  assert.strictEqual(wi.oldest, 40);
  assert.strictEqual(wi.delta, 10);
  assert.ok(Math.abs(wi.daysElapsed - 7) < 1e-6, 'daysElapsed ~7, got ' + wi.daysElapsed);
});

test('projection is stable (no increase) when rate <= 0', () => {
  const hist = historyFor(50, 50);
  const wi = delivery.windowInfo(hist, 'monthly', NOW);
  assert.strictEqual(wi.delta, 0);
  // warnDateFor returns null for a non-increasing window.
  assert.strictEqual(discordDigest.warnDateFor(hist, 'monthly', NOW), null);
});

test('projection reports already-at/above warn threshold', () => {
  const hist = historyFor(80, 85);
  const wi = delivery.windowInfo(hist, 'monthly', NOW);
  assert.ok(wi.current >= 80);
  assert.strictEqual(discordDigest.warnDateFor(hist, 'monthly', NOW), 'at/above warn');
});

test('projection reports already-at/above critical threshold', () => {
  const hist = historyFor(95, 97);
  const wi = delivery.windowInfo(hist, 'monthly', NOW);
  assert.ok(wi.current >= 95);
  assert.strictEqual(discordDigest.critDateFor(hist, 'monthly', NOW), 'at/above crit');
});

test('projection computes a projected warn date from the rate', () => {
  // 40% -> 50% over 7d => rate 10/7 %/d => (80-50)/(10/7) = 21 days to 80%.
  const hist = historyFor(40, 50);
  const got = discordDigest.warnDateFor(hist, 'monthly', NOW);
  const expectedDate = new Date(NOW + 21 * DAY).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
  assert.strictEqual(got, expectedDate, 'expected projected warn date ' + expectedDate + ', got ' + got);
});

test('projection computes a projected critical date from the rate', () => {
  // 40% -> 50% over 7d => rate 10/7 %/d => (95-50)/(10/7) = 31.5 days to 95%.
  const hist = historyFor(40, 50);
  const got = discordDigest.critDateFor(hist, 'monthly', NOW);
  const expectedDate = new Date(NOW + 31.5 * DAY).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
  assert.strictEqual(got, expectedDate, 'expected projected crit date ' + expectedDate + ', got ' + got);
});

test('projection needs a usable current value (returns null when empty)', () => {
  assert.strictEqual(discordDigest.warnDateFor([], 'monthly', NOW), null);
  assert.strictEqual(discordDigest.warnDateFor([{ ts: NOW, monthly: null }], 'monthly', NOW), null);
  assert.strictEqual(discordDigest.critDateFor([], 'monthly', NOW), null);
});

test('windowInfo splits the series at a reset drop (post-reset climb reads from the floor)', () => {
  // Previous cycle peaked at 85, then a reset dropped to 5; the new cycle
  // climbed to 15. Without the split the delta would read 15-85 = -70 (a
  // phantom improvement); with it, 15-5 = +10 (the real post-reset climb).
  const hist = [
    { ts: NOW - 6 * DAY, monthly: 80 },
    { ts: NOW - 5 * DAY, monthly: 85 },
    { ts: NOW - 4 * DAY, monthly: 5 }, // reset drop (-80)
    { ts: NOW - 2 * DAY, monthly: 10 },
    { ts: NOW, monthly: 15 }
  ];
  const wi = delivery.windowInfo(hist, 'monthly', NOW);
  assert.strictEqual(wi.oldest, 5, 'oldest must be the post-reset floor, got ' + wi.oldest);
  assert.strictEqual(wi.delta, 10, 'delta must be the post-reset climb, got ' + wi.delta);
});

test('windowInfo ignores small dips (no false reset split)', () => {
  const hist = [
    { ts: NOW - 6 * DAY, monthly: 40 },
    { ts: NOW - 3 * DAY, monthly: 38 }, // -2: noise, not a reset
    { ts: NOW, monthly: 50 }
  ];
  const wi = delivery.windowInfo(hist, 'monthly', NOW);
  assert.strictEqual(wi.oldest, 40);
  assert.strictEqual(wi.delta, 10);
});

test('warn/crit projections are bounded by resetsAt', () => {
  // 40 -> 50 over 7d => warn in 21d, crit in 31.5d unbounded; a reset in 10d
  // caps both at the horizon.
  const hist = historyFor(40, 50);
  const resetIso = new Date(NOW + 10 * DAY).toISOString();
  const warnIso = new Date(NOW + 10 * DAY).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
  assert.strictEqual(discordDigest.warnDateFor(hist, 'monthly', NOW, resetIso), warnIso);
  assert.strictEqual(discordDigest.critDateFor(hist, 'monthly', NOW, resetIso), warnIso);
});
