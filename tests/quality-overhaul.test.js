'use strict';

// Tests for the v0.7.0 alert-quality overhaul:
//  (a) crossings-only quota: warn/crit fires ONCE per crossing; recovery resets
//  (b) new-model dedup across feed + api sources
//  (c) Discord embeds (color / fields / timestamp / non-empty content)
//  (d) humanizeReset relative phrasing
//  (f) digest "What changed" prioritizes model_change events

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const usage = require('../src/usage');
const discordDigest = require('../src/discord-digest');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-qov-'));
}

// ---------------------------------------------------------------------------
// (a) Crossings-only quota alerting
// ---------------------------------------------------------------------------

test('classifyQuota maps percent to ok/warn/crit', () => {
  assert.strictEqual(usage.classifyQuota(50, 80, 95), 'ok');
  assert.strictEqual(usage.classifyQuota(82, 80, 95), 'warn');
  assert.strictEqual(usage.classifyQuota(96, 80, 95), 'crit');
  assert.strictEqual(usage.classifyQuota(NaN, 80, 95), 'unknown');
});

test('quotaTransition fires once per crossing; same status is silent', () => {
  // Same status -> no alert (caller logs DEBUG).
  assert.deepStrictEqual(usage.quotaTransition('warn', 'warn'), { alert: false });
  assert.deepStrictEqual(usage.quotaTransition('crit', 'crit'), { alert: false });
  // Upward crossings alert at the new level.
  assert.deepStrictEqual(usage.quotaTransition('ok', 'warn'), { alert: true, level: 'warning' });
  assert.deepStrictEqual(usage.quotaTransition('warn', 'crit'), { alert: true, level: 'critical' });
  assert.deepStrictEqual(usage.quotaTransition('ok', 'crit'), { alert: true, level: 'critical' });
  // Recovery (back to ok) fires an optional info.
  assert.deepStrictEqual(usage.quotaTransition('warn', 'ok'), { alert: true, level: 'info', recovery: true });
  assert.deepStrictEqual(usage.quotaTransition('crit', 'ok'), { alert: true, level: 'info', recovery: true });
});

test('quotaTransition: first sighting only alerts when non-nominal', () => {
  assert.deepStrictEqual(usage.quotaTransition('unknown', 'ok'), { alert: false });
  assert.deepStrictEqual(usage.quotaTransition('unknown', 'warn'), { alert: true, level: 'warning' });
  assert.deepStrictEqual(usage.quotaTransition('unknown', 'crit'), { alert: true, level: 'critical' });
});

test('quota-status file persists across cycles (recovery resets)', () => {
  const d = tmpDir();
  try {
    const file = path.join(d, 'quota-status.json');
    usage.saveQuotaStatus(file, { monthly: 'warn' });
    const loaded = usage.loadQuotaStatus(file);
    assert.strictEqual(loaded.monthly, 'warn');
    const empty = usage.loadQuotaStatus(path.join(d, 'does-not-exist.json'));
    assert.deepStrictEqual(empty, {});
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('runUsage fires a warn alert exactly once per crossing; repeat is DEBUG', async () => {
  const d = tmpDir();
  try {
    delivery.configure({ logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null }, d);
    delivery.setSubscribers([]);
    delivery.init(d, {});
    fs.writeFileSync(path.join(d, 'auth.json'), JSON.stringify({ 'opencode-go': { key: 'test' } }));

    const mk = (pct) => ({
      rolling: { percent: pct, resetsAt: new Date(Date.now() + 864e5).toISOString() },
      weekly: { percent: 10 },
      monthly: { percent: 10 }
    });
    const fakeRes = (pct) => ({ ok: true, json: async () => ({ usage: mk(pct) }) });
    const origFetch = global.fetch;

    // Cycle 1: rolling at 85% (>= warn 80) -> first sighting warns.
    global.fetch = async () => fakeRes(85);
    await usage.runUsage(path.join(d, 'auth.json'), { warning: 80, critical: 95 }, d);

    // Cycle 2: still 85% -> same status, must NOT re-alert (DEBUG only).
    await usage.runUsage(path.join(d, 'auth.json'), { warning: 80, critical: 95 }, d);

    const cl = JSON.parse(fs.readFileSync(path.join(d, 'quota-status.json'), 'utf8'));
    assert.strictEqual(cl.rolling, 'warn', 'status persisted as warn');
    const changelog = JSON.parse(fs.readFileSync(path.join(d, 'changelog.json'), 'utf8'));
    const warns = changelog.filter((e) => e.level === 'warning' && /Quota rolling warning/.test(e.title));
    assert.strictEqual(warns.length, 1, 'rolling warn alert fired exactly once across two identical cycles');

    // Cycle 3: drops to 10% -> recovery (info), status resets to ok.
    global.fetch = async () => fakeRes(10);
    await usage.runUsage(path.join(d, 'auth.json'), { warning: 80, critical: 95 }, d);
    const cl2 = JSON.parse(fs.readFileSync(path.join(d, 'quota-status.json'), 'utf8'));
    assert.strictEqual(cl2.rolling, 'ok', 'status reset to ok after recovery');
    const changelog2 = JSON.parse(fs.readFileSync(path.join(d, 'changelog.json'), 'utf8'));
    const recovered = changelog2.filter((e) => /Quota rolling recovered/.test(e.title));
    assert.strictEqual(recovered.length, 1, 'recovery info fired once');
    global.fetch = origFetch;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) New-model dedup across sources
// ---------------------------------------------------------------------------

test('computeDedupKey parses model id from message text (brand-new model)', () => {
  delivery.setKnownModelIds(new Set());
  const k1 = delivery.computeDedupKey('Model changed', 'Added model: brandnew-1');
  assert.strictEqual(k1, 'model:brandnew1');
  const k2 = delivery.computeDedupKey('Model changed', 'Cost changed for brandnew-1: {"input":1} -> {"input":2}');
  assert.strictEqual(k2, 'model:brandnew1');
});

test('new-model alert dedupes across feed + api sources within TTL', async () => {
  const d = tmpDir();
  try {
    delivery.configure({ logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null }, d);
    delivery.setSubscribers([]);
    delivery.setKnownModelIds(new Set()); // simulate a brand-new model not yet in catalog
    delivery.init(d, { dedupTtlMs: 86400000 });

    // Source 1: api diff emits "Added model: X".
    const r1 = await delivery.alert('model_change', 'Model changed', 'Added model: brandnew-1');
    assert.strictEqual(r1.delivered, true, 'first sighting delivered');
    // Source 2: Go/Zen feed emits a commit title referencing the same model.
    const r2 = await delivery.alert('model_change', 'Feed update: goPricing', 'docs(go): add brandnew-1 (#45836)');
    assert.strictEqual(r2.delivered, false, 'cross-source duplicate suppressed');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) Discord embed shape
// ---------------------------------------------------------------------------

test('warning alert builds an embed with color, fields, timestamp; content non-empty', () => {
  const payload = delivery.buildDiscordPayload('warning', '[WARNING] X — y', {
    title: 'Quota warning',
    description: '85% used',
    fields: [{ name: 'Usage', value: '85%' }]
  });
  assert.ok(Array.isArray(payload.embeds) && payload.embeds.length === 1);
  assert.strictEqual(payload.embeds[0].color, 0xf1c40f);
  assert.strictEqual(payload.embeds[0].title, 'Quota warning');
  assert.strictEqual(payload.embeds[0].description, '85% used');
  assert.strictEqual(payload.embeds[0].fields[0].name, 'Usage');
  assert.ok(typeof payload.embeds[0].timestamp === 'string');
  assert.ok(payload.content.length > 0 && payload.content.length <= 1900);
});

// ---------------------------------------------------------------------------
// (d) humanizeReset
// ---------------------------------------------------------------------------

test('humanizeReset renders relative phrasing', () => {
  const now = Date.now();
  assert.strictEqual(delivery.humanizeReset(new Date(now - 1000).toISOString()), 'overdue');
  assert.strictEqual(delivery.humanizeReset('not-a-date'), '?');
  assert.strictEqual(delivery.humanizeReset(new Date(now + 3600_000).toISOString()), 'today');
  assert.strictEqual(delivery.humanizeReset(new Date(now + 26 * 3600_000).toISOString()), 'tomorrow');
  // +60s margin so sub-ms clock drift between the two Date.now() calls cannot
  // round the 4h remainder down to 3h.
  assert.strictEqual(delivery.humanizeReset(new Date(now + 3 * 864e5 + 4 * 3600_000 + 60000).toISOString()), 'in 3d 4h');
});

// ---------------------------------------------------------------------------
// (f) digest "What changed" prioritizes model_change
// ---------------------------------------------------------------------------

test('digest "What changed" lists model_change before quota crossings', () => {
  const d = tmpDir();
  try {
    const tsOld = new Date(Date.now() - 2 * 864e5).toISOString();
    const tsNew = new Date(Date.now() - 1 * 864e5).toISOString();
    const events = [
      { ts: tsOld, level: 'warning', title: 'Quota monthly warning', message: '85% used' },
      {
        ts: tsNew,
        level: 'model_change',
        title: 'Model changed',
        message: 'Cost changed for hy3: {"input":0.0175} -> {"input":0.14}'
      }
    ];
    fs.writeFileSync(path.join(d, 'changelog.json'), JSON.stringify(events));
    const REPORT = {
      pricing: { status: 'ok', modelCount: 5 },
      usage: { status: 'ok', usage: { monthly: { percent: 42, resetsAt: new Date(Date.now() + 5 * 864e5).toISOString() } } }
    };
    const chunks = discordDigest.buildDigestChunks(REPORT, { stateDir: d });
    const body = chunks[0];
    assert.ok(body.includes('What changed'), 'has What changed section');
    const mcIdx = body.indexOf('— model_change');
    const warnIdx = body.indexOf('— warning');
    assert.ok(mcIdx >= 0 && warnIdx >= 0, 'both bullet kinds present');
    assert.ok(mcIdx < warnIdx, 'model_change bullet precedes warning bullet');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
