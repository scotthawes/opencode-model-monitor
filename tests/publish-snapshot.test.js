'use strict';

// Unit tests for P2-3: public published snapshot (Closes #56).
//   - only allowlisted pricing fields are published (usage/quota/paths stripped)
//   - changelog is reduced to model_change events only
//   - buildSnapshot writes the expected docs/ files (all pass the privacy guard)
//   - the privacy guardrail aborts when a forbidden substring is present

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeCost,
  sanitizePricingEntry,
  sanitizePricingSnapshot,
  sanitizeHistorySample,
  filterChangelog,
  buildSnapshot,
  assertNoForbidden,
  FORBIDDEN
} = require('../scripts/publish-snapshot');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-publish-'));
}

test('sanitizeCost keeps only allowlisted cost fields', () => {
  const out = sanitizeCost({
    input: 1,
    output: 2,
    cache_read: 0.5,
    cache_write: 1,
    secret: 99, // must be dropped
    quota_used: 40 // must be dropped
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ['cache_read', 'cache_write', 'input', 'output']);
  assert.strictEqual(out.input, 1);
  assert.strictEqual(out.output, 2);
});

test('sanitizePricingEntry drops personal fields and keeps public meta', () => {
  const entry = {
    id: 'hy3',
    cost: { input: 0.14, output: 0.58 },
    tiers: null,
    meta: {
      name: 'Hy3',
      family: 'hy3',
      provider: null,
      contextWindow: 1,
      // personal-looking junk that must be stripped:
      authPath: '/Users/scott/.config/auth.json',
      webhook: 'https://hooks.example/xyz',
      subscribers: 3,
      usage: { percent: 42 }
    }
  };
  const clean = sanitizePricingEntry('hy3', entry);
  assert.ok(!('authPath' in clean.meta), 'meta.authPath stripped');
  assert.ok(!('webhook' in clean.meta), 'meta.webhook stripped');
  assert.ok(!('subscribers' in clean.meta), 'meta.subscribers stripped');
  assert.ok(!('usage' in clean.meta), 'meta.usage stripped');
  assert.strictEqual(clean.meta.name, 'Hy3');
  assert.strictEqual(clean.id, 'hy3');
});

test('sanitizePricingSnapshot maps by id with only public fields', () => {
  const snap = {
    a: { cost: { input: 1, output: 2 }, tiers: null, meta: { name: 'A' } },
    b: { cost: { input: 3 }, tiers: null, meta: { name: 'B', token: 'x' } }
  };
  const { map, list } = sanitizePricingSnapshot(snap);
  assert.strictEqual(list.length, 2);
  assert.ok(!('token' in map.b.meta), 'token stripped from b.meta');
  assert.strictEqual(map.a.meta.name, 'A');
});

test('sanitizeHistorySample keeps only cost/tiers per model', () => {
  const sample = {
    ts: '2026-09-05T00:00:00.000Z',
    models: {
      hy3: { cost: { input: 0.14, output: 0.58 }, tiers: null, pins: ['/Users/scott/x'] }
    }
  };
  const clean = sanitizeHistorySample(sample);
  assert.ok(!('pins' in clean.models.hy3), 'model.pins stripped');
  assert.strictEqual(clean.models.hy3.cost.output, 0.58);
  assert.strictEqual(clean.ts, sample.ts);
});

test('filterChangelog keeps only model_change events', () => {
  const log = [
    { ts: 't1', level: 'model_change', title: 'Model changed', message: 'Cost changed for hy3: {...}' },
    { ts: 't2', level: 'info', title: 'Quota weekly changed', message: '39% used' },
    { ts: 't3', level: 'warning', title: 'Usage fetch failed', message: 'fetch failed' },
    { ts: 't4', level: 'model_change', title: 'Model changed', message: 'Cost changed for x: {...}' }
  ];
  const out = filterChangelog(log);
  assert.strictEqual(out.length, 2, 'only the two model_change events survive');
  assert.ok(out.every((e) => e.level === 'model_change'));
  assert.ok(!out.some((e) => e.message.includes('% used')), 'no quota data');
});

test('assertNoForbidden throws on any forbidden substring', () => {
  for (const needle of ['/Users/', 'webhook', 'subscribers', 'auth.json', 'gho_XXXX']) {
    assert.throws(() => assertNoForbidden('preamble ' + needle + ' tail', 'test'),
      new RegExp('PRIVACY VIOLATION'),
      `should reject ${needle}`);
  }
  assert.doesNotThrow(() => assertNoForbidden('cost changed for hy3: {"input":0.14}', 'test'));
});

test('buildSnapshot writes all docs files and they pass the privacy guard', () => {
  const inDir = tmpDir();
  const outDir = tmpDir();
  fs.writeFileSync(path.join(inDir, 'pricing-snapshot.json'), JSON.stringify({
    hy3: {
      cost: { input: 0.14, output: 0.58, cache_read: 0.035 },
      tiers: null,
      meta: { name: 'Hy3', family: 'hy3', contextWindow: 1, secret: 'leak' }
    }
  }));
  fs.writeFileSync(path.join(inDir, 'history.json'), JSON.stringify([
    { ts: '2026-09-05T00:00:00.000Z', models: { hy3: { cost: { input: 0.14, output: 0.58 }, tiers: null } } }
  ]));
  fs.writeFileSync(path.join(inDir, 'changelog.json'), JSON.stringify([
    { ts: 't1', level: 'model_change', title: 'Model changed', message: 'Cost changed for hy3: {...}' },
    { ts: 't2', level: 'info', title: 'Quota weekly changed', message: '39% used' }
  ]));

  const written = buildSnapshot(outDir, inDir);
  assert.ok(written, 'returns a list of written files');
  const names = written.map((f) => path.basename(f)).sort();
  assert.deepStrictEqual(names,
    ['README.md', 'changelog.json', 'history.json', 'index.html', 'pricing-snapshot.json'].sort());

  // No personal "secret" field leaked through.
  const pricingOut = fs.readFileSync(path.join(outDir, 'pricing-snapshot.json'), 'utf8');
  assert.ok(!pricingOut.includes('leak'), 'personal secret field not published');
  assert.ok(!pricingOut.includes('"secret"'), 'secret key not published');

  // changelog.json is model_change only.
  const chOut = JSON.parse(fs.readFileSync(path.join(outDir, 'changelog.json'), 'utf8'));
  assert.strictEqual(chOut.length, 1);

  // Privacy guardrail held across every written file.
  for (const f of written) {
    for (const needle of FORBIDDEN) {
      assert.ok(!fs.readFileSync(f, 'utf8').toLowerCase().includes(needle.toLowerCase()),
        `forbidden ${needle} must not appear in ${path.basename(f)}`);
    }
  }
});

test('buildSnapshot aborts (throws) if a forbidden substring sneaks into output', () => {
  const inDir = tmpDir();
  const outDir = tmpDir();
  fs.writeFileSync(path.join(inDir, 'pricing-snapshot.json'), JSON.stringify({
    hy3: { cost: { input: 1, output: 2 }, tiers: null, meta: { name: 'Hy3' } }
  }));
  // A model_change message that tries to exfiltrate a webhook URL.
  fs.writeFileSync(path.join(inDir, 'changelog.json'), JSON.stringify([
    { ts: 't1', level: 'model_change', title: 'Model changed',
      message: 'Cost changed AND webhook=https://hooks.example/abc' }
  ]));
  assert.throws(() => buildSnapshot(outDir, inDir), /PRIVACY VIOLATION/);
});

test('buildSnapshot returns null when state pricing snapshot is absent', () => {
  const outDir = tmpDir();
  const res = buildSnapshot(outDir, tmpDir()); // empty inDir, no pricing file
  assert.strictEqual(res, null, 'preserves committed docs/ when no live state');
});
