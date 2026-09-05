'use strict';

// Unit tests for the P2-2 (#55) api.json shape validation (validateApiShape).
// Pure, no network: exercises the hand-rolled schema check directly.

const test = require('node:test');
const assert = require('node:assert');

const { validateApiShape } = require('../src/price-watch');

const mk = (cost, tiers = null) => ({ cost, tiers });

test('validateApiShape: valid catalog passes', () => {
  const data = {
    'opencode-go': {
      models: {
        a: mk({ input: 1, output: 2 }),
        b: mk({ input: 3 })
      }
    }
  };
  const r = validateApiShape(data);
  assert.strictEqual(r.ok, true, 'expected ok:true, got: ' + JSON.stringify(r));
});

test('validateApiShape: missing key fails', () => {
  // No opencode-go at all.
  const r = validateApiShape({ 'opencode': { models: { a: mk({ input: 1 }) } } });
  assert.strictEqual(r.ok, false, 'expected ok:false without opencode-go');
  assert.match(r.reason, /opencode-go/);
});

test('validateApiShape: HTML string payload fails', () => {
  // A 200-OK that returns an HTML error page instead of JSON.
  const r = validateApiShape('<html><body>502 Bad Gateway</body></html>');
  assert.strictEqual(r.ok, false, 'expected ok:false for HTML string');
  assert.match(r.reason, /not an object/);
});

test('validateApiShape: empty models fails', () => {
  const r = validateApiShape({ 'opencode-go': { models: {} } });
  assert.strictEqual(r.ok, false, 'expected ok:false for empty models');
  assert.match(r.reason, /empty/);
});

test('validateApiShape: model without cost fails with clear reason', () => {
  const r = validateApiShape({
    'opencode-go': { models: { a: { name: 'NoCost' } } }
  });
  assert.strictEqual(r.ok, false, 'expected ok:false for model lacking cost');
  assert.match(r.reason, /model 'a'/);
  assert.match(r.reason, /cost-like numeric field/);
});

test('validateApiShape: flat input/output numeric fields are accepted', () => {
  const r = validateApiShape({
    'opencode-go': { models: { a: { input: 1.2, output: 4.5 } } }
  });
  assert.strictEqual(r.ok, true, 'expected ok:true for flat numeric fields, got: ' + JSON.stringify(r));
});

test('validateApiShape: cost object with string values fails', () => {
  const r = validateApiShape({
    'opencode-go': { models: { a: { cost: { input: 'cheap' } } } }
  });
  assert.strictEqual(r.ok, false, 'expected ok:false when cost has no numeric field');
  assert.match(r.reason, /cost-like numeric field/);
});
