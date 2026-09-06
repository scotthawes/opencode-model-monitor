'use strict';

// v0.17 insight (#105): anomaly, burn-rate, arrows, meta diffs.
// Pure-math unit tests + surface-render tests + dedup behavior. No network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const changeMetric = require('../src/change-metric');
const delivery = require('../src/delivery');
const discordDigest = require('../src/discord-digest');
const historyView = require('../src/history-view');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-insight-'));
}

function setup(d) {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.init(d, {});
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
}

// --- a. sudden-jump anomaly math --------------------------------------------

test('anomaly: 8x jump flagged (hy3 case)', () => {
  assert.equal(changeMetric.isAnomalousMove(0.0725, 0.58), true);
});

test('anomaly: exactly 2x flagged, below 2x not', () => {
  assert.equal(changeMetric.isAnomalousMove(1, 2), true);
  assert.equal(changeMetric.isAnomalousMove(1, 1.4), false); // +40%, 1.4x: calm
});

test('anomaly: -50% flagged, -49% not', () => {
  assert.equal(changeMetric.isAnomalousMove(2, 1), true);
  assert.equal(changeMetric.isAnomalousMove(100, 51), false);
});

test('anomaly: new (old 0) and non-numbers never anomalous', () => {
  assert.equal(changeMetric.isAnomalousMove(0, 5), false);
  assert.equal(changeMetric.isAnomalousMove(null, 5), false);
  assert.equal(changeMetric.isAnomalousMove(5, 5), false);
});

test('anomalyText prefers output, formats Nx line', () => {
  const t = changeMetric.anomalyText('hy3', { input: 0.0175, output: 0.0725 }, { input: 0.14, output: 0.58 });
  assert.ok(t && t.startsWith('Anomaly: hy3 moved 8x between polls'), t);
  assert.ok(t.includes('output'), t);
});

test('anomalyText falls back to input, null when calm', () => {
  const t = changeMetric.anomalyText('m', { input: 1 }, { input: 3 });
  assert.ok(t && t.includes('input'), t);
  assert.equal(changeMetric.anomalyText('m', { output: 1 }, { output: 1.2 }), null);
});

test('anomaly dedup: hourly per-model suppression honored', async () => {
  const d = tmpDir();
  try {
    setup(d);
    const opts = { dedupKey: 'anomaly:hy3', dedupTtlMs: 3600000 };
    const r1 = await delivery.alert('warning', 'Anomaly: hy3 sudden price jump', 'Anomaly: hy3 moved 8x', opts);
    assert.equal(r1.delivered, true);
    const r2 = await delivery.alert('warning', 'Anomaly: hy3 sudden price jump', 'Anomaly: hy3 moved 8x', opts);
    assert.equal(r2.delivered, false);
    // A different model is not suppressed by hy3's key.
    const r3 = await delivery.alert('warning', 'Anomaly: other sudden price jump', 'Anomaly: other moved 3x', {
      dedupKey: 'anomaly:other',
      dedupTtlMs: 3600000
    });
    assert.equal(r3.delivered, true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- b. burn-rate / acceleration --------------------------------------------

test('burnRateInfo: rate, days-to-95, exhausts-before-reset', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const wi = { current: 71, delta: 7, daysElapsed: 7 }; // 1 pt/day
  const resetFar = new Date(now + 60 * 864e5).toISOString();
  const b = changeMetric.burnRateInfo(wi, resetFar, now);
  assert.equal(b.ratePerDay, 1);
  assert.equal(b.daysToCrit, 24);
  assert.equal(b.exhaustsBeforeReset, true);
  const resetSoon = new Date(now + 2 * 864e5).toISOString();
  const b2 = changeMetric.burnRateInfo(wi, resetSoon, now);
  assert.equal(b2.exhaustsBeforeReset, false);
});

test('burnRateInfo: null when stable or unprojectable', () => {
  assert.equal(changeMetric.burnRateInfo({ current: 50, delta: 0, daysElapsed: 7 }, null, Date.now()), null);
  assert.equal(changeMetric.burnRateInfo(null, null, Date.now()), null);
  const b = changeMetric.burnRateInfo({ current: 50, delta: 7, daysElapsed: 7 }, null, Date.now());
  assert.equal(b.exhaustsBeforeReset, null);
});

function usageHist(points, baseTs) {
  // points: [[ageMs, val], ...] oldest-first; returns [{ts, monthly}]
  return points.map(([age, v]) => ({ ts: baseTs - age, monthly: v }));
}

test('accelerationAlarm: 24h spike over flat week alarms', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const D = 864e5;
  const h = usageHist([[7 * D, 60], [6 * D, 60], [2 * D, 60], [1 * D, 60], [0, 66]], now);
  const a = changeMetric.accelerationAlarm(h, 'monthly', now);
  assert.ok(a, 'expected alarm');
  assert.equal(a.ratio, Infinity);
});

test('accelerationAlarm: steady climb does not alarm', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const D = 864e5;
  const h = usageHist([[7 * D, 60], [3.5 * D, 63.5], [1 * D, 66.5], [0, 67]], now);
  assert.equal(changeMetric.accelerationAlarm(h, 'monthly', now), null);
});

test('accelerationAlarm: 2x-vs-baseline boundary', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const D = 864e5;
  // Baseline 1pt/day over days 7..1, recent 2pt/day over last day -> ratio 2.
  const h = usageHist([[7 * D, 60], [1 * D, 66], [0, 68]], now);
  const a = changeMetric.accelerationAlarm(h, 'monthly', now);
  assert.ok(a && a.ratio >= 2, JSON.stringify(a));
});

// --- c. arrows + cap-upset ---------------------------------------------------

test('rankArrows: up/down/flat/new', () => {
  const r = changeMetric.rankArrows(['a', 'b', 'c'], ['b', 'a', 'c']);
  assert.equal(r.a.arrow, '▲');
  assert.equal(r.b.arrow, '▼');
  assert.equal(r.c.arrow, '–');
  const r2 = changeMetric.rankArrows(['new-model'], ['a']);
  assert.equal(r2['new-model'].arrow, '–');
  assert.equal(r2['new-model'].pastRank, null);
});

test('capUpsets: flags $15-cap list-cheap/effective-expensive', () => {
  const raw = ['cheap15', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
  const eff = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'cheap15'];
  const out = changeMetric.capUpsets(raw, eff, { cheap15: 15, x1: 60 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'cheap15');
  assert.equal(out[0].gap, 6);
  // Non-$15 caps never flag.
  assert.equal(changeMetric.capUpsets(raw, eff, { cheap15: 60 }).length, 0);
});

// --- d. meta diffs, each tracked field ---------------------------------------

test('diffMeta: each tracked field fires, others ignored', () => {
  const base = { family: 'f', knowledge: 'k', open_weights: true, contextWindow: 100 };
  assert.deepEqual(changeMetric.diffMeta(base, { ...base, family: 'g' }).map((d) => d.field), ['family']);
  assert.deepEqual(changeMetric.diffMeta(base, { ...base, knowledge: 'k2' }).map((d) => d.field), ['knowledge']);
  assert.deepEqual(changeMetric.diffMeta(base, { ...base, open_weights: false }).map((d) => d.field), ['open_weights']);
  assert.deepEqual(changeMetric.diffMeta(base, { ...base, contextWindow: 200 }).map((d) => d.field), ['contextWindow']);
  assert.deepEqual(changeMetric.diffMeta(base, base), []);
  // capabilities churn is noise — not tracked.
  assert.deepEqual(
    changeMetric.diffMeta({ ...base, capabilities: { tool_call: true } }, { ...base, capabilities: {} }),
    []
  );
});

test('metaChangeText: single-line info format', () => {
  const t = changeMetric.metaChangeText('m', { family: 'a', knowledge: null, open_weights: null, contextWindow: null }, { family: 'b', knowledge: null, open_weights: null, contextWindow: null });
  assert.equal(t, 'Meta changed for m: family a→b');
  assert.equal(changeMetric.metaChangeText('m', null, null), null);
});

// --- surfaces render ----------------------------------------------------------

test('report Upcoming renders burn-rate block', () => {
  const d = tmpDir();
  try {
    setup(d);
    const now = Date.now();
    const D = 864e5;
    const hist = [
      { ts: now - 7 * D, rolling: 10, weekly: 30, monthly: 60 },
      { ts: now - 1 * D, rolling: 12, weekly: 33, monthly: 66 },
      { ts: now, rolling: 13, weekly: 34, monthly: 67 }
    ];
    fs.writeFileSync(path.join(d, 'usage-history.json'), JSON.stringify(hist));
    delivery.beginCycleCache();
    const md = delivery.renderMarkdown({
      generatedAt: new Date(now).toISOString(),
      pricing: { status: 'ok', modelCount: 3, models: {}, changes: [] },
      usage: {
        usage: {
          rolling: { percent: 13, status: 'ok', resetsAt: new Date(now + 2 * D).toISOString() },
          weekly: { percent: 34, status: 'ok', resetsAt: new Date(now + 3 * D).toISOString() },
          monthly: { percent: 67, status: 'ok', resetsAt: new Date(now + 20 * D).toISOString() }
        }
      },
      pins: [],
      feedUpdates: []
    });
    assert.ok(md.includes('**Burn rate**'), md.slice(md.indexOf('Upcoming')));
    assert.ok(md.includes('burn:'), md);
    assert.ok(md.includes('pts/day'), md);
  } finally {
    delivery.clearCycleCache();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('digest renders cheapest arrows + burn lines', () => {
  const d = tmpDir();
  try {
    setup(d);
    const now = Date.now();
    const D = 864e5;
    fs.writeFileSync(path.join(d, 'usage-history.json'), JSON.stringify([
      { ts: now - 7 * D, monthly: 60 },
      { ts: now - 1 * D, monthly: 66 },
      { ts: now, monthly: 67 }
    ]));
    fs.writeFileSync(path.join(d, 'history.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify({}));
    const report = {
      pricing: {
        models: {
          aaa: { cost: { input: 0.1, output: 0.2, cache_read: 0.01 } },
          bbb: { cost: { input: 1, output: 2, cache_read: 0.1 } }
        },
        modelCount: 2
      },
      usage: { usage: { monthly: { percent: 67, resetsAt: new Date(now + 20 * D).toISOString() } } }
    };
    const chunks = discordDigest.buildDigestChunks(report, { stateDir: d });
    assert.ok(chunks.length >= 1);
    assert.ok(chunks[0].includes('Cheapest right now'), chunks[0]);
    const all = chunks.join('\n');
    assert.ok(all.includes('burn'), all);
  } finally {
    delivery.clearCycleCache();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('page leaderboard rows carry arrow + upset fields', () => {
  const now = Date.now();
  const D = 864e5;
  const iso = (t) => new Date(t).toISOString();
  const history = [
    { ts: iso(now - 8 * D), models: { aaa: { cost: { input: 2, output: 4 } }, bbb: { cost: { input: 0.1, output: 0.2 } } } },
    { ts: iso(now - 1 * D), models: { aaa: { cost: { input: 0.1, output: 0.2 } }, bbb: { cost: { input: 0.1, output: 0.2 } } } }
  ];
  const data = historyView.buildPricingData(history, {}, { now });
  assert.ok(data.leaderboard.length >= 2);
  for (const r of data.leaderboard) {
    assert.ok(['▲', '▼', '–'].includes(r.arrow), JSON.stringify(r));
    assert.equal(typeof r.upset, 'boolean');
  }
  // aaa got cheaper -> should have climbed vs 8d ago.
  const aaa = data.leaderboard.find((r) => r.id === 'aaa');
  assert.equal(aaa.arrow, '▲');
});
