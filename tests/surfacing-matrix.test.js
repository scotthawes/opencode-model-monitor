'use strict';

// v0.18.0 (#107) surfacing matrix: every change type must reach all five
// surfaces (JSONL event log, alerts.log/changelog line, Discord table,
// digest "What changed", page feed) — or carry an explicit exclusion.
//
// Surfaces per descriptor:
//   1. JSONL      — events.eventForChange(ch) → expected type (null = excluded)
//   2. Log line   — delivery.modelChangeHumanMessage(ch) → distinctive text
//   3. Table      — delivery.modelChangeLineStr(ch) → marker line
//   4. Digest     — model_change event with that text appears in "What changed"
//   5. Page feed  — historyView.parseChangelogFeedLine(msg) → kind
//                   (cost returns null BY DESIGN: the series feed covers it)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const events = require('../src/events');
const delivery = require('../src/delivery');
const discordDigest = require('../src/discord-digest');
const historyView = require('../src/history-view');
const publishSnapshot = require('../scripts/publish-snapshot');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-matrix-'));
}

const REPORT = {
  pricing: { status: 'ok', modelCount: 5 },
  usage: {
    status: 'ok',
    usage: { monthly: { percent: 42, resetsAt: '2026-10-01T00:00:00.000Z' } }
  }
};

// One descriptor per surfaced change type.
const MATRIX = [
  {
    name: 'added',
    ch: { subtype: 'added', model: 'm-added', cost: { input: 1, output: 2 }, meta: { name: 'M Added' } },
    jsonl: 'added',
    msgRe: /^Added model: m-added$/,
    tableRe: /ADDED/,
    feedKind: 'added'
  },
  {
    name: 'removed',
    ch: { subtype: 'removed', model: 'm-removed', meta: { name: 'M Removed' } },
    jsonl: 'removed',
    msgRe: /^Removed model: m-removed$/,
    tableRe: /REMOVED/,
    feedKind: 'removed'
  },
  {
    name: 'cost',
    ch: { subtype: 'cost', model: 'm-cost', oldCost: { input: 1 }, newCost: { input: 2 }, meta: {} },
    jsonl: 'cost-changed',
    msgRe: /m-cost/,
    tableRe: /m-cost/,
    feedKind: null // BY DESIGN: cost moves render from the price series, not the changelog feed
  },
  {
    name: 'tiers',
    ch: { subtype: 'tiers', model: 'm-tiers', oldTiers: ['a'], newTiers: ['a', 'b'], meta: {} },
    jsonl: 'tiers-changed',
    msgRe: /^Tiers changed for m-tiers$/,
    tableRe: /TIERS/,
    feedKind: 'tiers'
  },
  {
    name: 'cap',
    ch: { subtype: 'cap', model: 'm-cap', oldCap: 60, newCap: 15, factor: 4, direction: 'downgraded', meta: {} },
    jsonl: 'quota-changed',
    msgRe: /^Quota moved for m-cap: \$60 -> \$15/,
    tableRe: /QUOTA 60→15/,
    feedKind: 'cap'
  },
  {
    name: 'free-available',
    ch: { subtype: 'free', reason: 'available', model: 'm-free', meta: {} },
    jsonl: 'free-available',
    msgRe: /^Free model available: m-free$/,
    tableRe: /FREE available/,
    feedKind: 'free'
  },
  {
    name: 'free-changed',
    ch: { subtype: 'free', reason: 'changed', model: 'm-free', meta: {} },
    jsonl: 'free-changed',
    msgRe: /^Free model changed: m-free$/,
    tableRe: /FREE CHANGED/,
    feedKind: 'free'
  },
  {
    name: 'free-removed',
    ch: { subtype: 'free', reason: 'removed', model: 'm-free', meta: {} },
    jsonl: 'free-removed',
    msgRe: /^Free model removed: m-free$/,
    tableRe: /FREE REMOVED/,
    feedKind: 'free'
  },
  {
    name: 'privacy',
    ch: { subtype: 'privacy', model: 'm-priv', old: { training: true }, new: { training: false }, meta: {} },
    jsonl: 'privacy-changed',
    msgRe: /^Privacy changed for m-priv: /,
    tableRe: /PRIVACY/,
    feedKind: 'privacy'
  },
  {
    name: 'deprecated',
    ch: { subtype: 'deprecated', model: 'm-dep', meta: { deprecated: true } },
    jsonl: 'deprecated',
    msgRe: /^Model deprecated: m-dep$/,
    tableRe: /DEPRECATED/,
    feedKind: 'deprecated'
  },
  {
    name: 'withdrawn',
    ch: { subtype: 'withdrawn', model: 'm-wd', meta: {} },
    jsonl: 'withdrawn',
    msgRe: /^Model withdrawn: m-wd \(priced but not serving\)$/,
    tableRe: /WITHDRAWN/,
    feedKind: 'withdrawn'
  },
  {
    name: 'anomaly',
    ch: { subtype: 'anomaly', model: 'm-anom', oldCost: { output: 1 }, newCost: { output: 8 }, meta: {} },
    jsonl: 'anomaly',
    msgRe: /m-anom/,
    tableRe: /⚠️/,
    feedKind: 'anomaly'
  },
  {
    name: 'meta',
    ch: { subtype: 'meta', model: 'm-meta', old: { family: 'a' }, new: { family: 'b' }, meta: {} },
    jsonl: 'meta-changed',
    msgRe: /^Meta changed for m-meta: family a→b$/,
    tableRe: /ℹ️/,
    feedKind: 'meta'
  }
];

for (const row of MATRIX) {
  test(`matrix: ${row.name} reaches all five surfaces`, () => {
    // 1. JSONL event log.
    const ev = events.eventForChange(row.ch);
    assert.ok(ev, `${row.name}: expected a JSONL event`);
    assert.strictEqual(ev.type, row.jsonl, `${row.name}: JSONL type`);
    assert.strictEqual(ev.model, row.ch.model, `${row.name}: JSONL model`);

    // 2. alerts.log / changelog human line (distinctive, never the generic fallback).
    const msg = delivery.modelChangeHumanMessage(row.ch);
    assert.ok(msg && !/^Model changed: /.test(msg), `${row.name}: must not use generic fallback, got: ${msg}`);
    assert.match(msg, row.msgRe, `${row.name}: log line`);

    // 3. Discord table marker line.
    const line = delivery.modelChangeLineStr(row.ch);
    assert.ok(line && line.length > 0, `${row.name}: expected a table line`);
    assert.match(line, row.tableRe, `${row.name}: table line`);

    // 4. Digest "What changed" carries the model_change event.
    const d = tmpDir();
    try {
      const ts = new Date(Date.now() - 36e5).toISOString();
      fs.writeFileSync(
        path.join(d, 'changelog.json'),
        JSON.stringify([{ ts, level: 'model_change', title: 'Model changed', message: msg }])
      );
      const chunks = discordDigest.buildDigestChunks(REPORT, { stateDir: d });
      const all = chunks.join('\n');
      assert.ok(all.includes('What changed'), `${row.name}: digest needs a What changed section`);
      assert.ok(all.includes(row.ch.model), `${row.name}: digest must name the model`);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }

    // 5. Page feed (non-cost changelog lines; cost rides the price series).
    const parsed = historyView.parseChangelogFeedLine(msg);
    if (row.feedKind === null) {
      assert.strictEqual(parsed, null, `${row.name}: cost lines stay out of the changelog feed by design`);
    } else {
      assert.ok(parsed, `${row.name}: expected a page feed item`);
      assert.strictEqual(parsed.kind, row.feedKind, `${row.name}: feed kind`);
      assert.strictEqual(parsed.model, row.ch.model, `${row.name}: feed model`);
    }
  });
}

test('matrix exclusions: seed usage-moved/info stay JSONL-only by design', () => {
  // No descriptor subtype exists for seed history — eventForChange maps
  // nothing for them, so they can never enter the table/log/digest/page.
  assert.strictEqual(events.eventForChange({ subtype: 'usage-moved', model: 'x' }), null);
  assert.strictEqual(events.eventForChange({ subtype: 'info', model: 'x' }), null);
  assert.strictEqual(events.eventForChange({ subtype: 'feed', model: 'x' }), null);
});

test('matrix: public Full log keeps model_change only (warnings/info stay local)', () => {
  const ts = new Date().toISOString();
  const kept = { ts, level: 'model_change', title: 'Model changed', message: 'Added model: x' };
  const droppedWarn = { ts, level: 'warning', title: 'Quota', message: 'monthly 95%' };
  const droppedInfo = { ts, level: 'info', title: 'Meta', message: 'Meta changed for x' };
  const out = publishSnapshot.filterChangelog([kept, droppedWarn, droppedInfo]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].message, 'Added model: x');
});

test('matrix caps: digest top-8, report last-30 noted', () => {
  assert.strictEqual(discordDigest.MAX_EVENTS, 8, 'digest shows top-8 (was top-5)');
});
