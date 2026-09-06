'use strict';

// Unit tests for the redesigned public page (Closes #75):
//  - buildPricingData computes 7-day Δ% / × / $ per model
//  - color assignment: direction -> dir-* class + correct swatch/row color
//  - feed capped at 10 + "Full log → changelog.json" link present in the HTML
//  - no secret / personal-data leakage into the public page output

const test = require('node:test');
const assert = require('node:assert');
const { buildPricingData, generatePublicPage } = require('../src/history-view');

function historyFrom(pairs) {
  // pairs: [{ ts, id, output, input }]
  return pairs.map((p) => ({
    ts: p.ts,
    models: { [p.id]: { cost: { output: p.output, input: p.input == null ? p.output : p.input }, tiers: null } }
  }));
}

test('buildPricingData computes windowed delta (Δ% / × / $) per model', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = historyFrom([
    { ts: '2026-09-01T00:00:00.000Z', id: 'hy3', output: 0.0725, input: 0.14 },
    { ts: '2026-09-08T00:00:00.000Z', id: 'hy3', output: 0.58, input: 0.14 }
  ]);
  const data = buildPricingData(hist, { hy3: { meta: { name: 'Hy3' } } }, { now });
  const m = data.models.find((x) => x.id === 'hy3');
  assert.ok(m, 'hy3 present');
  // v0.19.0 (#110): deltaWindow is canonical (page window = 30d); delta7d is a
  // deprecated alias carrying the same object.
  assert.strictEqual(m.deltaWindow.direction, 'up');
  assert.strictEqual(m.delta7d, m.deltaWindow, 'alias must be the same block');
  assert.ok(Math.abs(m.deltaWindow.output.pct - 700) < 1, 'output +700%');
  assert.ok(Math.abs(m.deltaWindow.output.mult - 8) < 1e-9, 'output 8x');
  assert.ok(Math.abs(m.deltaWindow.output.abs - 0.5075) < 1e-9, 'output +$0.5075');
  // input unchanged -> flat
  assert.strictEqual(m.deltaWindow.input.direction, 'flat');
});

test('window labels match the math (30d page window, not 7d)', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = historyFrom([{ ts: '2026-09-08T00:00:00.000Z', id: 'hy3', output: 0.58 }]);
  const data = buildPricingData(hist, { hy3: { meta: { name: 'Hy3' } } }, { now });
  assert.strictEqual(data.windowDays, 30, 'page math uses the 30d window');
  const html = generatePublicPage(hist, { pricing: { hy3: { meta: { name: 'Hy3' } } }, now });
  assert.ok(html.includes('30-day window'), 'sub header names the 30d window');
  assert.ok(html.includes('Model table — 30-day price change'), 'table header names 30d');
  assert.ok(html.includes('Δ30d output'), 'delta columns name 30d');
  assert.ok(!html.includes('Δ7d'), 'no stale 7d delta label on the page');
});

test('a price decrease is marked down (green) and an increase up (red)', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = historyFrom([
    { ts: '2026-09-01T00:00:00.000Z', id: 'cheap', output: 1.0 },
    { ts: '2026-09-08T00:00:00.000Z', id: 'cheap', output: 0.5 }
  ]);
  const data = buildPricingData(hist, { cheap: { meta: { name: 'Cheap' } } }, { now });
  const m = data.models.find((x) => x.id === 'cheap');
  assert.strictEqual(m.deltaWindow.direction, 'down');

  const html = generatePublicPage(hist, { pricing: { cheap: { meta: { name: 'Cheap' } } }, now });
  // Row carries the direction class so the page can color it.
  assert.ok(html.includes('class="dir-down"'), 'down row class present');
  assert.ok(html.includes('#27ae60'), 'green color (down) present in page');
  assert.ok(html.includes('class="dir-up"') === false, 'no up row when nothing rose');
});

test('feed is capped at 10 and the full-log link is present', () => {
  const now = Date.parse('2026-09-13T00:00:00.000Z');
  const hist = [];
  let out = 0.1;
  for (let i = 0; i < 13; i++) {
    hist.push({ ts: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, models: { hy3: { cost: { output: out }, tiers: null } } });
    out += 0.05;
  }
  const data = buildPricingData(hist, { hy3: { meta: { name: 'Hy3' } } }, { now });
  assert.ok(data.feed.length <= 10, 'feed <= 10, got ' + data.feed.length);

  const html = generatePublicPage(hist, { pricing: { hy3: { meta: { name: 'Hy3' } } }, now });
  assert.ok(html.includes('Full log → changelog.json'), 'full-log link present');
  assert.ok(html.includes('<canvas'), 'canvas present for graph');
  assert.ok(html.includes('id="pricing-data"'), 'embedded pricing JSON present');
});

test('no secret / personal data leaks into the public page output', () => {
  const hist = historyFrom([{ ts: '2026-09-08T00:00:00.000Z', id: 'hy3', output: 0.58 }]);
  // A pricing map carrying personal-looking fields that must NEVER reach docs/.
  const pricing = {
    hy3: {
      cost: { output: 0.58 },
      tiers: null,
      meta: {
        name: 'Hy3',
        authPath: '/Users/scott/.config/auth.json',
        webhook: 'https://hooks.example/abc',
        secret: 'leakme',
        usage: { percent: 42 }
      }
    }
  };
  const html = generatePublicPage(hist, { pricing, now: Date.parse('2026-09-08T00:00:00.000Z') });
  assert.ok(!html.includes('leakme'), 'secret value not published');
  assert.ok(!html.includes('auth.json'), 'auth path not published');
  assert.ok(!html.includes('hooks.example'), 'webhook not published');
  assert.ok(!html.toLowerCase().includes('quota'), 'no quota wording on public page');
  // The embedded JSON (pricing-data) must also be clean.
  const jsonMatch = html.match(/id="pricing-data">([\s\S]*?)<\/script>/);
  assert.ok(jsonMatch, 'embedded JSON found');
  assert.ok(!jsonMatch[1].includes('leakme'), 'secret not in embedded JSON');
});

test('public page renders the Leaderboard section + cap badge (no personal usage)', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = historyFrom([
    { ts: '2026-09-01T00:00:00.000Z', id: 'cheap', output: 0.5 },
    { ts: '2026-09-08T00:00:00.000Z', id: 'cheap', output: 0.5 }
  ]);
  const html = generatePublicPage(hist, {
    pricing: { cheap: { meta: { name: 'Cheap' }, cost: { output: 0.5 } } },
    now
  });
  assert.ok(html.toLowerCase().includes('leaderboard'), 'Leaderboard section present');
  assert.ok(html.includes('id="leaderboard"'), 'leaderboard anchor present');
  assert.ok(html.includes('cap-badge'), 'cap badge rendered');
  // Cap tiers are published pricing, never the personal usage % — confirm the page
  // does not publish the user's personal usage percentage from meta.
  assert.ok(!html.toLowerCase().includes('quota'), 'no quota wording on public page');
});

test('buildPricingData exposes per-model cap + a leaderboard array', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = historyFrom([
    { ts: '2026-09-01T00:00:00.000Z', id: 'cheap', output: 0.5 },
    { ts: '2026-09-08T00:00:00.000Z', id: 'cheap', output: 0.5 }
  ]);
  const data = buildPricingData(hist, { cheap: { meta: { name: 'Cheap' }, cost: { output: 0.5 } } }, { now });
  assert.ok(Array.isArray(data.leaderboard), 'leaderboard array present');
  assert.ok(data.leaderboard.length >= 1, 'leaderboard non-empty');
  assert.strictEqual(data.leaderboard[0].id, 'cheap');
  assert.ok('cap' in data.leaderboard[0], 'leaderboard row carries cap');
  assert.ok('cap' in data.models[0], 'model carries cap');
});

test('leaderboard renders as a proper table ABOVE the graph', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = historyFrom([
    { ts: '2026-09-01T00:00:00.000Z', id: 'cheap', output: 0.5, input: 0.1 },
    { ts: '2026-09-08T00:00:00.000Z', id: 'cheap', output: 0.5, input: 0.1 },
    { ts: '2026-09-01T00:00:00.000Z', id: 'mid', output: 1.2, input: 0.2 },
    { ts: '2026-09-08T00:00:00.000Z', id: 'mid', output: 1.0, input: 0.2 }
  ]);
  const pricing = {
    cheap: { meta: { name: 'Cheap' }, cost: { output: 0.5, input: 0.1 } },
    mid: { meta: { name: 'Mid' }, cost: { output: 1.0, input: 0.2 } }
  };
  const html = generatePublicPage(hist, { pricing, now });
  const lbStart = html.indexOf('<section id="leaderboard"');
  const canvasPos = html.indexOf('<canvas');
  assert.ok(lbStart !== -1, 'leaderboard section present');
  assert.ok(canvasPos !== -1, 'graph canvas present');
  assert.ok(lbStart < canvasPos, 'leaderboard appears before the graph');
  const lbSection = html.slice(lbStart, canvasPos);
  assert.ok(lbSection.includes('<table'), 'leaderboard section has a <table>');
  assert.ok(lbSection.includes('Eff $/req'), 'table has the Eff $/req column');
  assert.ok(lbSection.includes('Req-mo'), 'table has the Req-mo column');
  assert.ok(lbSection.includes('class="num"'), 'numeric cells use the right-align class');
  assert.ok(lbSection.includes('cap-badge'), 'cap badge present in the leaderboard table');
});

test('graph uses daily bucket labels (no hours/minutes), not hourly timestamps', () => {
  const now = Date.parse('2026-09-13T00:00:00.000Z');
  const hist = [];
  for (let i = 0; i < 9; i++) {
    hist.push({ ts: `2026-09-${String(i + 1).padStart(2, '0')}T05:00:00.000Z`, models: { hy3: { cost: { output: 0.1 + i * 0.01 }, tiers: null } } });
  }
  const data = buildPricingData(hist, { hy3: { meta: { name: 'Hy3' } } }, { now });
  assert.ok(Array.isArray(data.dailyLabels), 'dailyLabels array present');
  assert.ok(data.dailyLabels.length >= 1, 'has daily labels');
  for (const lbl of data.dailyLabels) {
    assert.ok(!lbl.includes(':'), 'label has no hours/minutes: ' + lbl);
    assert.ok(/^[A-Z][a-z]{2} \d+$/.test(lbl), 'label looks like "Sep 5": ' + lbl);
  }
  const m = data.models[0];
  assert.strictEqual(m.dailySeries.length, data.dailyLabels.length, 'dailySeries aligns 1:1 with labels');
});

test('graph canvas height attribute is capped (<=400) and wrapped to cap height', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = historyFrom([{ ts: '2026-09-08T00:00:00.000Z', id: 'hy3', output: 0.58 }]);
  const html = generatePublicPage(hist, { pricing: { hy3: { meta: { name: 'Hy3' } } }, now });
  const m = html.match(/<canvas[^>]*height="(\d+)"[^>]*>/);
  assert.ok(m, 'canvas height attribute present');
  assert.ok(Number(m[1]) <= 400, 'canvas height <= 400, got ' + m[1]);
  assert.ok(html.includes('class="graph-wrap"'), 'graph wrapper present to cap height');
});

test('topMovers rank by % move (cheap-model shocks beat big-ticket drift)', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = [
    { ts: '2026-09-01T00:00:00.000Z', models: { whale: { cost: { output: 100, input: 10 }, tiers: null }, guppy: { cost: { output: 0.1, input: 0.05 }, tiers: null } } },
    { ts: '2026-09-08T00:00:00.000Z', models: { whale: { cost: { output: 110, input: 10 }, tiers: null }, guppy: { cost: { output: 0.8, input: 0.05 }, tiers: null } } }
  ];
  // whale moved +$10 (+10%); guppy moved +$0.70 (+700%). Old abs-$ ranking put
  // whale first; %-ranking must put guppy first.
  const data = buildPricingData(hist, {}, { now });
  assert.strictEqual(data.topMovers[0], 'guppy', 'top mover must be the %-shock, got ' + data.topMovers[0]);
});

test('topMovers include input-only moves (output flat, input moved)', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const hist = [
    { ts: '2026-09-01T00:00:00.000Z', models: { inmover: { cost: { output: 1.0, input: 0.1 }, tiers: null }, flat: { cost: { output: 1.0, input: 0.1 }, tiers: null } } },
    { ts: '2026-09-08T00:00:00.000Z', models: { inmover: { cost: { output: 1.0, input: 0.8 }, tiers: null }, flat: { cost: { output: 1.0, input: 0.1 }, tiers: null } } }
  ];
  // inmover: output flat, input +700%. Old output-only ranking scored it 0.
  const data = buildPricingData(hist, {}, { now });
  assert.strictEqual(data.topMovers[0], 'inmover', 'input-only move must rank first, got ' + data.topMovers[0]);
});

test('$100 cap badge has a distinct color; unknown caps carry a ? marker', () => {
  const hv = require('../src/history-view');
  assert.notStrictEqual(hv.capBadgeColor(100), hv.capBadgeColor(60), '$100 must differ from $60 green');
  assert.strictEqual(hv.capBadgeColor(100), '#2980b9');
  assert.ok(hv.fmtCapBadge(60, true).includes('$60') && !hv.fmtCapBadge(60, true).includes('?'), 'known cap: no marker');
  assert.ok(hv.fmtCapBadge(60, false).includes('$60?'), 'unknown cap: ? marker');
  assert.strictEqual(hv.fmtCapBadge(null), '—');
});

