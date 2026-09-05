'use strict';

// Unit tests for the Discord digest builder's TL;DR chunk:
//  - quiet (no changelog events) -> "All quiet"
//  - with a model_change event -> lists "What changed" with old -> new cost

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const discordDigest = require('../src/discord-digest');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-digest-'));
}

const REPORT = {
  pricing: { status: 'ok', modelCount: 5 },
  usage: {
    status: 'ok',
    usage: { monthly: { percent: 42, resetsAt: '2026-10-01T00:00:00.000Z' } }
  }
};

test('TL;DR is quiet when there are no recent events', () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, 'changelog.json'), '[]');
    const chunks = discordDigest.buildDigestChunks(REPORT, { stateDir: d });
    assert.ok(chunks.length >= 1, 'expected at least one chunk');
    assert.ok(chunks[0].includes('**Monitor**'), chunks[0]);
    assert.ok(chunks[0].includes('All quiet'), chunks[0]);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('TL;DR lists a model change under "What changed"', () => {
  const d = tmpDir();
  try {
    const ts = new Date(Date.now() - 864e5).toISOString();
    const events = [
      {
        ts,
        level: 'model_change',
        title: 'Model changed',
        message: 'Cost changed for hy3: {"input":0.0175} -> {"input":0.14}'
      }
    ];
    fs.writeFileSync(path.join(d, 'changelog.json'), JSON.stringify(events));
    const chunks = discordDigest.buildDigestChunks(REPORT, { stateDir: d });
    assert.ok(chunks[0].includes('**Monitor**'), chunks[0]);
    assert.ok(chunks[0].includes('What changed'), chunks[0]);
    assert.ok(chunks[0].includes('0.0175→0.14'), chunks[0]);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('model_change surfaces even when older than the last 20 events', () => {
  const d = tmpDir();
  try {
    const now = Date.now();
    const events = [];
    // 30 recent non-model events spread across the 7-day window.
    for (let i = 0; i < 30; i++) {
      events.push({
        ts: new Date(now - i * 3600e3).toISOString(),
        level: 'warning',
        title: 'Some other event',
        message: 'info ' + i
      });
    }
    // An OLD model_change (older than the last 20) near the start of the window.
    events.unshift({
      ts: new Date(now - 29 * 3600e3).toISOString(),
      level: 'model_change',
      title: 'Model changed',
      message: 'Cost changed for hy3: {"input":0.0175} -> {"input":0.14}'
    });
    // Plus a fresh model_change at the very end.
    events.push({
      ts: new Date(now - 1 * 3600e3).toISOString(),
      level: 'model_change',
      title: 'Model changed',
      message: 'Added model: nova'
    });
    fs.writeFileSync(path.join(d, 'changelog.json'), JSON.stringify(events));
    const chunks = discordDigest.buildDigestChunks(REPORT, { stateDir: d });
    const body = chunks[0];
    assert.ok(body.includes('What changed'), 'has What changed section');
    assert.ok(body.includes('0.0175→0.14'), 'old model_change must surface beyond last-20: ' + body);
    assert.ok(body.includes('nova'), 'new model_change must surface: ' + body);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('repeated quota warnings collapse to one bullet per window', () => {
  const d = tmpDir();
  try {
    const now = Date.now();
    const events = [];
    for (let i = 0; i < 3; i++) {
      events.push({
        ts: new Date(now - i * 3600e3).toISOString(),
        level: 'warning',
        title: 'Quota monthly warning',
        message: 80 + i + '% used'
      });
    }
    // A model_change that must stay visible despite the quota noise.
    events.push({
      ts: new Date(now - 0.5 * 3600e3).toISOString(),
      level: 'model_change',
      title: 'Model changed',
      message: 'Added model: nova'
    });
    fs.writeFileSync(path.join(d, 'changelog.json'), JSON.stringify(events));
    const chunks = discordDigest.buildDigestChunks(REPORT, { stateDir: d });
    const body = chunks[0];
    const matches = body.match(/Quota monthly warning/g) || [];
    assert.strictEqual(matches.length, 1, 'monthly quota warning should collapse to one bullet: ' + body);
    assert.ok(body.includes('(latest, 3 repeats)'), 'should report repeat count: ' + body);
    assert.ok(body.includes('nova'), 'model_change still visible: ' + body);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
