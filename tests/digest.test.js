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
