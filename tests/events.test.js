'use strict';

// Unit tests for the v0.8.0 event-sourced history (src/events.js) and its
// wiring into price-watch / delivery. No network. Uses temp state dirs.
//
// Covers:
//  - append + per-model query (ts-sorted, filtered)
//  - a model DROP is a first-class `removed` event (with prior cost)
//  - monthly rotation naming (events-YYYY-MM.jsonl)
//  - one-time changelog migration is idempotent (marker, no dupes)
//  - dual-write: delivery still writes changelog.json AND now events.jsonl

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const events = require('../src/events');
const delivery = require('../src/delivery');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-events-'));
}

// Isolate the in-process dedup Set between tests.
function fresh() {
  events._resetDedup();
  return tmpDir();
}

test('appendEvent writes one JSONL line; readEvents returns it', () => {
  const d = fresh();
  try {
    events.appendEvent(d, { type: 'added', model: 'hy3', new: { input: 0.14 } });
    const all = events.readEvents(d);
    assert.strictEqual(all.length, 1, 'exactly one event expected');
    assert.strictEqual(all[0].type, 'added');
    assert.strictEqual(all[0].model, 'hy3');
    assert.deepStrictEqual(all[0].new, { input: 0.14 });
    assert.ok(typeof all[0].ts === 'string', 'ts is present');
    assert.strictEqual(all[0].old, null);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('getModelLife returns only that model, ts-sorted across months', () => {
  const d = fresh();
  try {
    events.appendEvent(d, { ts: '2026-09-01T00:00:00.000Z', type: 'added', model: 'a' });
    events.appendEvent(d, { ts: '2026-08-15T00:00:00.000Z', type: 'cost-changed', model: 'b' });
    events.appendEvent(d, { ts: '2026-09-02T00:00:00.000Z', type: 'cost-changed', model: 'a' });

    const lifeA = events.getModelLife(d, 'a');
    assert.strictEqual(lifeA.length, 2, 'model a has two events');
    assert.deepStrictEqual(
      lifeA.map((e) => e.ts),
      ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
      'sorted oldest -> newest, only model a'
    );

    const lifeB = events.getModelLife(d, 'b');
    assert.strictEqual(lifeB.length, 1);
    assert.strictEqual(lifeB[0].model, 'b');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a model DROP is a first-class removed event carrying prior cost', () => {
  const d = fresh();
  try {
    const ev = events.eventForChange({
      subtype: 'removed',
      model: 'doomed-model',
      cost: { input: 0.5, output: 3 }
    });
    assert.strictEqual(ev.type, 'removed', 'removal is a first-class type');
    assert.strictEqual(ev.model, 'doomed-model');
    assert.deepStrictEqual(ev.old, { input: 0.5, output: 3 }, 'prior cost preserved as old');
    assert.strictEqual(ev.new, null);

    events.appendChanges(d, [{ subtype: 'removed', model: 'doomed-model', cost: { input: 0.5 } }]);
    const life = events.getModelLife(d, 'doomed-model');
    assert.strictEqual(life.length, 1);
    assert.strictEqual(life[0].type, 'removed');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('eventForChange maps every model-change subtype', () => {
  const d = fresh();
  try {
    assert.strictEqual(events.eventForChange({ subtype: 'added', model: 'x', cost: { input: 1 } }).type, 'added');
    assert.strictEqual(
      events.eventForChange({ subtype: 'cost', model: 'x', oldCost: { a: 1 }, newCost: { a: 2 } }).type,
      'cost-changed'
    );
    const tiers = events.eventForChange({ subtype: 'tiers', model: 'x', oldTiers: ['f'], newTiers: ['p'] });
    assert.strictEqual(tiers.type, 'tiers-changed');
    assert.deepStrictEqual(tiers.old, ['f']);
    assert.deepStrictEqual(tiers.new, ['p']);
    assert.strictEqual(events.eventForChange({ subtype: 'free', reason: 'available', model: 'f' }).type, 'free-available');
    assert.strictEqual(events.eventForChange({ subtype: 'free', reason: 'changed', model: 'f' }).type, 'free-changed');
    assert.strictEqual(events.eventForChange({ subtype: 'free', reason: 'removed', model: 'f' }).type, 'free-removed');
    // A non-model-change descriptor yields no event.
    assert.strictEqual(events.eventForChange({ subtype: 'feed', model: 'x' }), null);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('monthly rotation: events land in events-YYYY-MM.jsonl by UTC month', () => {
  const d = fresh();
  try {
    // Same logical model, two different months -> two files.
    events.appendEvent(d, { ts: '2026-08-31T23:59:00.000Z', type: 'added', model: 'm' });
    events.appendEvent(d, { ts: '2026-09-01T00:00:00.000Z', type: 'cost-changed', model: 'm' });

    const files = events.listEventFiles(d);
    assert.deepStrictEqual(
      files.sort(),
      ['events-2026-08.jsonl', 'events-2026-09.jsonl'],
      'one file per UTC month'
    );
    // File name strictly matches the rotation pattern.
    for (const f of files) assert.ok(/^events-\d{4}-\d{2}\.jsonl$/.test(f), 'bad name: ' + f);

    // Reading the model's life spans both months, in order.
    const life = events.getModelLife(d, 'm');
    assert.strictEqual(life.length, 2);
    assert.strictEqual(life[0].ts, '2026-08-31T23:59:00.000Z');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('eventsFileFor uses the UTC month of the event ts', () => {
  assert.strictEqual(events.eventsFileFor('2026-09-05T10:12:00.000Z'), 'events-2026-09.jsonl');
  assert.strictEqual(events.eventsFileFor('2026-01-01T00:00:00.000Z'), 'events-2026-01.jsonl');
});

test('appendEvent is best-effort: bad input never throws', () => {
  const d = fresh();
  try {
    assert.doesNotThrow(() => events.appendEvent(null, null));
    assert.doesNotThrow(() => events.appendEvent(d, { type: null }));
    assert.doesNotThrow(() => events.appendEvent(d, { type: 'added' })); // no model is fine
    // Still produces a parseable event when given a valid type.
    const all = events.readEvents(d);
    assert.ok(all.some((e) => e.type === 'added'), 'valid append registered');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('changelog migration imports pricing events and is idempotent', () => {
  const d = fresh();
  try {
    const changelog = [
      { ts: '2026-08-30T03:26:56.450Z', level: 'model_change', title: 'Model changed', message: 'Cost changed for hy3: {"input":0.0175} -> {"input":0.14}' },
      { ts: '2026-09-01T03:44:39.440Z', level: 'model_change', title: 'Feed update: goPricing', message: 'docs: something — https://x/y' },
      { ts: '2026-09-02T05:25:37.810Z', level: 'model_change', title: 'Model changed', message: 'Added model: newmodel' },
      { ts: '2026-09-03T05:25:37.810Z', level: 'model_change', title: 'Model changed', message: 'Removed model: oldmodel' },
      { ts: '2026-09-04T05:25:37.810Z', level: 'model_change', title: 'Model changed', message: 'Free model available: free1' },
      { ts: '2026-09-05T05:25:37.810Z', level: 'warning', title: 'Pricing fetch failed', message: 'HTTP 503' }
    ];
    fs.writeFileSync(path.join(d, 'changelog.json'), JSON.stringify(changelog, null, 2));

    const r1 = events.migrateFromChangelog(d);
    assert.strictEqual(r1.skipped, false);
    // 5 model_change entries, but 1 is a feed update (not a pricing change) →
    // 4 pricing events imported (warning entry is skipped by level check).
    assert.strictEqual(r1.imported, 4, 'feed update + warning excluded');

    const all = events.readEvents(d);
    assert.strictEqual(all.length, 4, 'no duplicates on first run');
    assert.ok(all.some((e) => e.type === 'cost-changed' && e.model === 'hy3'), 'hy3 cost event');
    assert.ok(all.some((e) => e.type === 'added' && e.model === 'newmodel'), 'add event');
    assert.ok(all.some((e) => e.type === 'removed' && e.model === 'oldmodel'), 'drop event');
    assert.ok(all.some((e) => e.type === 'free-available' && e.model === 'free1'), 'free event');
    assert.ok(!all.some((e) => e.model === undefined), 'no feed-update leaked');

    // Second run must be a no-op (marker guard).
    const r2 = events.migrateFromChangelog(d);
    assert.strictEqual(r2.skipped, true, 'marker prevents re-migration');
    assert.strictEqual(events.readEvents(d).length, 4, 'still exactly 4 after re-run');
    assert.ok(fs.existsSync(path.join(d, '.events-migrated')), 'marker file written');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('dual-write: delivery writes changelog.json AND events.jsonl', async () => {
  const d = fresh();
  try {
    delivery.configure(
      { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
      d
    );
    delivery.setStateDir(d);
    delivery.setSubscribers([]);
    delivery.setKnownModelIds(new Set());

    await delivery.deliverModelChangeTable(
      [{ subtype: 'cost', model: 'dual-model', oldCost: { input: 0.1 }, newCost: { input: 0.2 } }],
      { send: async () => {} }
    );

    // New: JSONL event log carries the change (source of truth).
    const life = events.getModelLife(d, 'dual-model');
    assert.strictEqual(life.length, 1, 'event logged for the change');
    assert.strictEqual(life[0].type, 'cost-changed');
    assert.deepStrictEqual(life[0].old, { input: 0.1 });
    assert.deepStrictEqual(life[0].new, { input: 0.2 });

    // Backward compat: changelog.json still records the model_change.
    const cl = JSON.parse(fs.readFileSync(path.join(d, 'changelog.json'), 'utf8'));
    assert.ok(Array.isArray(cl) && cl.length >= 1, 'changelog.json still written');
    assert.ok(cl.some((e) => e.level === 'model_change'), 'model_change present in changelog');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('dual-write from price-watch path records model changes as events', async () => {
  const d = fresh();
  try {
    delivery.configure(
      { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
      d
    );
    delivery.setStateDir(d);
    delivery.setSubscribers([]);
    delivery.setKnownModelIds(new Set());

    // Simulate price-watch emitting a drop + a cost change through the same
    // appendChanges path it uses.
    events.appendChanges(d, [
      { subtype: 'removed', model: 'gone', cost: { input: 0.9 } },
      { subtype: 'cost', model: 'priced', oldCost: { input: 0.1 }, newCost: { input: 0.3 } }
    ]);

    const gone = events.getModelLife(d, 'gone');
    const priced = events.getModelLife(d, 'priced');
    assert.strictEqual(gone.length, 1);
    assert.strictEqual(gone[0].type, 'removed');
    assert.strictEqual(priced.length, 1);
    assert.strictEqual(priced[0].type, 'cost-changed');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
