'use strict';

// Unit tests for v0.10.0: the one-time usage-cap seed script (scripts/seed-usage-table.js).
//  - buildModelsMap strips the opencode-go/ prefix and maps usage -> cap
//  - invalid / non-positive usage values are skipped (model keeps default cap)
//  - tier duplicates of the same model share one cap (first occurrence wins)
//  - buildTable records source + seededAt provenance in _meta

const test = require('node:test');
const assert = require('node:assert');
const { buildModelsMap, buildTable, stripPrefix } = require('../scripts/seed-usage-table');

test('stripPrefix removes the opencode-go/ prefix', () => {
  assert.strictEqual(stripPrefix('opencode-go/grok-4.6'), 'grok-4.6');
  assert.strictEqual(stripPrefix('grok-4.6'), 'grok-4.6');
  assert.strictEqual(stripPrefix('opencode-go/hy3'), 'hy3');
});

test('buildModelsMap maps usage -> cap and strips the prefix', () => {
  const data = {
    models: [
      { id: 'opencode-go/grok-4.6', usage: 15 },
      { id: 'opencode-go/gpt-5.6-luna', usage: 30 },
      { id: 'opencode-go/glm-5.2', usage: 60 }
    ]
  };
  const m = buildModelsMap(data);
  assert.strictEqual(m['grok-4.6'], 15);
  assert.strictEqual(m['gpt-5.6-luna'], 30);
  assert.strictEqual(m['glm-5.2'], 60);
});

test('buildModelsMap skips invalid / non-positive usage', () => {
  const data = {
    models: [
      { id: 'opencode-go/a', usage: 0 }, // non-positive -> skipped
      { id: 'opencode-go/b', usage: -5 }, // negative -> skipped
      { id: 'opencode-go/c', usage: 'nope' }, // non-finite -> skipped
      { id: 'opencode-go/d', usage: 100 }, // valid
      { id: 'opencode-go/e' } // missing usage -> skipped
    ]
  };
  const m = buildModelsMap(data);
  assert.deepStrictEqual(m, { 'd': 100 });
});

test('buildModelsMap dedupes tiers of the same model (first cap wins)', () => {
  const data = {
    models: [
      { id: 'opencode-go/grok-4.6', tier: '<=200K', usage: 15 },
      { id: 'opencode-go/grok-4.6', tier: '>200K', usage: 15 }
    ]
  };
  const m = buildModelsMap(data);
  assert.strictEqual(Object.keys(m).length, 1);
  assert.strictEqual(m['grok-4.6'], 15);
});

test('buildTable records source + seededAt provenance', () => {
  const data = { models: [{ id: 'opencode-go/hy3', usage: 15 }] };
  const table = buildTable(data, '2026-09-05T00:00:00.000Z');
  assert.strictEqual(table.models['hy3'], 15);
  assert.strictEqual(table._meta.source, 'https://ocgo-pricing.all-the.rest/data/latest.json');
  assert.strictEqual(table._meta.seededAt, '2026-09-05T00:00:00.000Z');
  assert.strictEqual(table._meta.defaultCap, 60);
  assert.ok(Array.isArray(table._meta.capTiers));
  assert.ok(table._meta.capTiers.includes(15));
});

test('buildModelsMap tolerates a missing/non-array models list', () => {
  assert.deepStrictEqual(buildModelsMap(null), {});
  assert.deepStrictEqual(buildModelsMap({}), {});
  assert.deepStrictEqual(buildModelsMap({ models: 'nope' }), {});
});
