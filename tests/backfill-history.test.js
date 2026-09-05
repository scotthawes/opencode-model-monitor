'use strict';

// Unit tests for scripts/backfill-history.js (Closes #81):
//  - reconstruct from 2 synthetic cost events -> 4-point timeline, correct old/new
//  - idempotent rerun (no doubling)
//  - seed merge never duplicates
//  - 90d age prune + 500-entry cap respected

const test = require('node:test');
const assert = require('node:assert');

const bf = require('../scripts/backfill-history');

const HY3_OLD = { input: 0.0175, output: 0.0725, cache_read: 0.004375 };
const HY3_NEW = { input: 0.14, output: 0.58, cache_read: 0.035 };

function syntheticEvents() {
  return [
    {
      type: 'cost-changed',
      model: 'hy3',
      old: HY3_OLD,
      new: HY3_NEW,
      ts: '2026-08-30T03:26:56.450Z'
    },
    {
      type: 'cost-changed',
      model: 'other',
      old: { input: 1, output: 2 },
      new: { input: 2, output: 4 },
      ts: '2026-09-01T12:00:00.000Z'
    }
  ];
}

test('reconstructFromEvents yields 4 points (old@ts-1s, new@ts) with correct values', () => {
  const pts = bf.reconstructFromEvents(syntheticEvents());
  assert.strictEqual(pts.length, 4, 'two cost-changed events -> four points');

  // old points sit 1s before the event ts
  const oldHy3 = pts.find((p) => p.ts === '2026-08-30T03:26:55.450Z' && p.models.hy3);
  const newHy3 = pts.find((p) => p.ts === '2026-08-30T03:26:56.450Z' && p.models.hy3);
  assert.ok(oldHy3, 'old hy3 point at ts-1s present');
  assert.ok(newHy3, 'new hy3 point at ts present');
  assert.deepStrictEqual(oldHy3.models.hy3.cost, HY3_OLD, 'old cost correct');
  assert.deepStrictEqual(newHy3.models.hy3.cost, HY3_NEW, 'new cost correct');

  // the second event too
  const newOther = pts.find((p) => p.ts === '2026-09-01T12:00:00.000Z' && p.models.other);
  assert.ok(newOther, 'new other point present');
  assert.deepStrictEqual(newOther.models.other.cost, { input: 2, output: 4 }, 'new other cost correct');
});

test('mergeHistory is idempotent across reruns (no doubling)', () => {
  const existing = [{ ts: '2026-09-05T10:00:00.000Z', models: { hy3: { cost: HY3_NEW, tiers: null } } }];
  const backfilled = bf.dedupSamples(bf.reconstructFromEvents(syntheticEvents()));

  const r1 = bf.mergeHistory(existing, backfilled, { now: Date.parse('2026-09-22T00:00:00Z') });
  const r2 = bf.mergeHistory(r1, backfilled, { now: Date.parse('2026-09-22T00:00:00Z') });

  assert.strictEqual(r2.length, r1.length, 'rerun does not add duplicates');
  // existing sample + 4 backfilled = 5 (no extra)
  assert.strictEqual(r1.length, 5, 'existing(1) + backfilled(4) = 5');
  // sorted ascending
  for (let i = 1; i < r1.length; i++) {
    assert.ok(Date.parse(r1[i].ts) >= Date.parse(r1[i - 1].ts), 'sorted ascending');
  }
});

test('changelog model_change is reconstructed and deduped against events', () => {
  const changelog = [
    {
      ts: '2026-08-30T03:26:56.450Z',
      level: 'model_change',
      message: `Cost changed for hy3: ${JSON.stringify(HY3_OLD)} -> ${JSON.stringify(HY3_NEW)}`
    }
  ];
  const pts = bf.reconstructFromChangelog(changelog);
  assert.strictEqual(pts.length, 2, 'changelog yields 2 points');
  assert.strictEqual(pts[0].models.hy3.cost.input, 0.0175, 'old input from changelog');
  assert.strictEqual(pts[1].models.hy3.cost.input, 0.14, 'new input from changelog');

  // Deduped against the structurally-identical event (same ts+models) -> 4 total, not 6.
  const events = syntheticEvents();
  const all = bf.dedupSamples([...bf.reconstructFromEvents(events), ...pts]);
  assert.strictEqual(all.length, 4, 'changelog duplicates are deduped against events');
});

test('seed merge never duplicates (idempotent)', () => {
  const hist = [{ ts: '2026-09-05T10:00:00.000Z', models: { hy3: { cost: HY3_NEW, tiers: null } } }];
  const seed = [
    { ts: '2026-08-15T00:00:00.000Z', models: { hy3: { cost: HY3_OLD, tiers: null } }, source: 'seed' },
    { ts: '2026-08-15T00:00:00.000Z', models: { hy3: { cost: HY3_OLD, tiers: null } }, source: 'seed' }
  ];
  const r1 = bf.mergeHistory(hist, seed, { now: Date.parse('2026-09-22T00:00:00Z') });
  const r2 = bf.mergeHistory(r1, seed, { now: Date.parse('2026-09-22T00:00:00Z') });
  assert.strictEqual(r1.length, 2, 'duplicate seed merged to one');
  assert.strictEqual(r2.length, r1.length, 'seed merge idempotent');
  assert.ok(r1.some((s) => s.source === 'seed'), 'seed tag preserved');
});

test('mapSeedData fuzzy-maps to known ids and logs/skips unmatched', () => {
  const known = ['hy3', 'qwen3.7-max'];
  const payload = [
    { ts: '2026-08-10T00:00:00Z', models: { hy3: { input: 0.01, output: 0.05 }, unknownModelX: { input: 9, output: 9 } } },
    { date: '2026-08-11', prices: { 'qwen3.7-max': { input: 2.5, output: 7.5 } } }
  ];
  const mapped = bf.mapSeedData(payload, known);
  const ids = mapped.map((m) => Object.keys(m.models)[0]).sort();
  assert.deepStrictEqual(ids, ['hy3', 'qwen3.7-max'], 'only known ids mapped');
  assert.ok(mapped.every((m) => m.source === 'seed'), 'seed tag set');
  assert.ok(mapped.every((m) => Object.keys(m.models)[0] !== 'unknownModelX'), 'unmatched skipped');
});

test('90d age prune drops samples older than 90d', () => {
  const now = Date.parse('2026-09-22T00:00:00Z');
  const arr = [
    { ts: '2026-05-01T00:00:00.000Z', models: { x: { cost: { input: 1 }, tiers: null } } }, // >90d old
    { ts: '2026-08-30T03:26:55.450Z', models: { hy3: { cost: HY3_OLD, tiers: null } } }, // within 90d
    { ts: '2026-09-05T10:00:00.000Z', models: { hy3: { cost: HY3_NEW, tiers: null } } }
  ];
  const capped = bf.applyCap(arr, now);
  assert.strictEqual(capped.length, 2, 'old sample pruned');
  assert.ok(capped.every((s) => Date.parse(s.ts) >= now - bf.HISTORY_MAX_AGE_MS), 'all within 90d');
});

test('500-entry cap is enforced', () => {
  const now = Date.parse('2026-09-22T00:00:00Z');
  const arr = [];
  for (let i = 0; i < 600; i++) {
    arr.push({ ts: new Date(now - i * 1000).toISOString(), models: { x: { cost: { input: i }, tiers: null } } });
  }
  const capped = bf.applyCap(arr, now);
  assert.strictEqual(capped.length, bf.HISTORY_MAX_ENTRIES, 'capped at 500');
  // keeps the most RECENT 500 (newest first by ts -> last 500 by sort)
  assert.strictEqual(capped.length, 500);
  // monotonic ascending after cap
  for (let i = 1; i < capped.length; i++) {
    assert.ok(Date.parse(capped[i].ts) >= Date.parse(capped[i - 1].ts));
  }
});

test('parseChangelogCost handles the real Aug-30 message shape', () => {
  const msg = `Cost changed for hy3: ${JSON.stringify(HY3_OLD)} -> ${JSON.stringify(HY3_NEW)}`;
  const parsed = bf.parseChangelogCost(msg);
  assert.strictEqual(parsed.model, 'hy3');
  assert.deepStrictEqual(parsed.old, HY3_OLD);
  assert.deepStrictEqual(parsed.new, HY3_NEW);
  assert.strictEqual(bf.parseChangelogCost('something unrelated'), null);
});
