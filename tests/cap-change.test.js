'use strict';

// Unit tests for v0.10.0: quota / usage-cap change detection (price-watch).
//  - a downgrade ($60 -> $15) yields factor 4 ("4x more expensive") + direction
//  - an upgrade ($60 -> $100) yields factor 0.6 ("cheaper")
//  - a model absent from the prior snapshot is NOT alerted (no first-run flood)
//  - a live api.json `usage` field overrides the seeded table cap
//  - the Discord model-change table renders the cap row with the magnitude

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const usageTable = require('../src/usage-table');
const { computeCapChanges } = require('../src/price-watch');
const delivery = require('../src/delivery');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-cap-'));
}

test('downgrade $60 -> $15 is 4x more expensive', () => {
  usageTable.setTable({ 'm-cap': 15 });
  try {
    const prev = { 'm-cap': 60 };
    const modelsMap = { 'm-cap': { cost: { output: 1 }, meta: null, usage: null } };
    const changes = computeCapChanges(prev, modelsMap);
    assert.strictEqual(changes.length, 1);
    const c = changes[0];
    assert.strictEqual(c.subtype, 'cap');
    assert.strictEqual(c.model, 'm-cap');
    assert.strictEqual(c.oldCap, 60);
    assert.strictEqual(c.newCap, 15);
    assert.strictEqual(c.factor, 4); // 60/15
    assert.strictEqual(c.direction, 'downgraded');
  } finally {
    usageTable.setTable(null);
  }
});

test('upgrade $60 -> $100 is 0.6x cheaper', () => {
  usageTable.setTable({ 'm-cap2': 100 });
  try {
    const prev = { 'm-cap2': 60 };
    const modelsMap = { 'm-cap2': { cost: { output: 1 }, meta: null, usage: null } };
    const changes = computeCapChanges(prev, modelsMap);
    assert.strictEqual(changes.length, 1);
    const c = changes[0];
    assert.strictEqual(c.factor, 0.6);
    assert.strictEqual(c.direction, 'upgraded');
  } finally {
    usageTable.setTable(null);
  }
});

test('model absent from prior snapshot is not alerted (no first-run flood)', () => {
  usageTable.setTable({ 'fresh': 15 });
  try {
    const changes = computeCapChanges({}, { 'fresh': { cost: {}, meta: null, usage: null } });
    assert.strictEqual(changes.length, 0);
  } finally {
    usageTable.setTable(null);
  }
});

test('unchanged cap produces no change', () => {
  usageTable.setTable({ 'same': 30 });
  try {
    const changes = computeCapChanges({ 'same': 30 }, { 'same': { cost: {}, meta: null, usage: null } });
    assert.strictEqual(changes.length, 0);
  } finally {
    usageTable.setTable(null);
  }
});

test('live api.json usage field overrides the seeded table cap', () => {
  // Table says 60, but the live catalog reports usage: 15 -> treated as downgrade.
  usageTable.setTable({ 'live-m': 60 });
  try {
    const prev = { 'live-m': 60 };
    const modelsMap = { 'live-m': { cost: {}, meta: null, usage: 15 } };
    const changes = computeCapChanges(prev, modelsMap);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].newCap, 15);
    assert.strictEqual(changes[0].factor, 4);
  } finally {
    usageTable.setTable(null);
  }
});

test('Discord model-change table renders the cap row with magnitude', () => {
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    tmpDir()
  );
  const rows = [
    { subtype: 'cap', model: 'grok-4.6', oldCap: 60, newCap: 15, factor: 4, direction: 'downgraded', meta: null }
  ];
  // Cap moves ride in the `lines` bucket (like added/removed/tiers), not the cost table.
  const body = delivery.buildModelChangeChunks([], rows).join('\n');
  assert.ok(body.includes('grok-4.6'), 'model id present');
  assert.ok(body.includes('60'), 'old cap present');
  assert.ok(body.includes('15'), 'new cap present');
  assert.ok(body.includes('4x more expensive'), 'magnitude present');
  assert.ok(body.includes('⚠️'), 'warning marker present');
});
