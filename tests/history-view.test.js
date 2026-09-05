'use strict';

// Unit tests for P2-1: static compare/history view generator (Closes #54).
//   - generator handles empty/missing history
//   - single-sample history renders a model row
//   - multi-sample trend renders varied text-bar sparkline
//   - HTML escaping for model ids / messages with special chars
// Pure function tests only — no real state/ files are read.

const test = require('node:test');
const assert = require('node:assert');

const { generateHistoryHtml, sparkline, esc } = require('../src/history-view');

// Helpers to build fake history samples.
function sample(ts, models) {
  return { ts, models };
}
function m(output, input) {
  return { cost: { input: input == null ? output : input, output }, tiers: null };
}

test('empty history produces a valid, escaped page with no models', () => {
  const html = generateHistoryHtml([], { pricing: {}, changelog: [] });
  assert.ok(html.includes('<!DOCTYPE html>'), 'must be a full HTML doc');
  assert.ok(html.includes('No models recorded'), 'reports empty models');
  assert.ok(html.includes('No changelog events'), 'reports empty changelog');
  assert.ok(html.includes('0 sample(s)'));
});

test('missing/garbage history (non-array) does not throw', () => {
  // generateHistoryHtml treats non-array as empty (CLI layer guards separately).
  const html = generateHistoryHtml(null, {});
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('No models recorded'));
});

test('single sample renders the model row with current cost', () => {
  const hist = [sample('2026-09-05T10:00:00.000Z', { hy3: m(0.58, 0.14) })];
  const html = generateHistoryHtml(hist, { pricing: {}, changelog: [] });
  assert.ok(html.includes('hy3'), 'model id present in table');
  assert.ok(html.includes('$0.1400'), 'input cost formatted');
  assert.ok(html.includes('$0.5800'), 'output cost formatted');
});

test('multi-sample trend renders a varied text-bar sparkline', () => {
  // Rising output cost across samples -> sparkline should span light..full bars.
  const hist = [
    sample('t1', { hy3: m(0.10) }),
    sample('t2', { hy3: m(0.30) }),
    sample('t3', { hy3: m(0.60) }),
    sample('t4', { hy3: m(0.90) })
  ];
  const html = generateHistoryHtml(hist, { pricing: {}, changelog: [] });
  const bars = sparkline([0.1, 0.3, 0.6, 0.9]);
  assert.ok(bars.length === 4, 'sparkline length matches samples');
  assert.ok(bars.includes('▁'), 'sparkline has the lightest bar');
  assert.ok(bars.includes('█'), 'sparkline has the fullest bar');
  // The rising trend must appear in the rendered page.
  assert.ok(html.includes(esc(bars)), 'sparkline rendered into the page');
});

test('flat multi-sample trend renders uniform mid bars (no divide-by-zero)', () => {
  const bars = sparkline([0.5, 0.5, 0.5]);
  assert.strictEqual(bars, '▄▄▄');
});

test('sparkline returns empty string for empty/missing values', () => {
  assert.strictEqual(sparkline([]), '');
  assert.strictEqual(sparkline(null), '');
});

test('HTML escaping neutralizes special chars in model ids and messages', () => {
  const evilId = '<script>x="y">&z';
  const hist = [sample('t1', { [evilId]: m(1.0) })];
  const changelog = [
    { ts: 't2', level: 'model_change', title: '<b>hi</b>', message: 'a & b < c' }
  ];
  const html = generateHistoryHtml(hist, { pricing: {}, changelog });

  // The raw dangerous substrings must NOT appear unescaped.
  assert.ok(!html.includes('<script>x'), 'no raw <script> injected from model id');
  assert.ok(!html.includes('<b>hi</b>'), 'no raw HTML from changelog title');
  // Escaped forms should be present.
  assert.ok(html.includes('&lt;script&gt;'), 'model id angle brackets escaped');
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;'), 'title angle brackets escaped');
  assert.ok(html.includes('a &amp; b &lt; c'), 'message ampersand/angle escaped');
  // data-id attribute keeps the escaped id so the filter still matches it.
  assert.ok(html.includes('data-id="&lt;script&gt;x=&quot;y&quot;&gt;&amp;z"'));
});
