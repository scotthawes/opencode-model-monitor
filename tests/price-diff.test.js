'use strict';

// Unit tests for the price-watch diff logic (added / removed / cost / tiers).
// No network: global.fetch is mocked to return a fixed catalog, and a previous
// snapshot is seeded into a temp state dir so we exercise the real diff path.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const { runPriceWatch, extractModelMeta } = require('../src/price-watch');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-price-'));
}

function setup(d) {
  // Keep all delivery side-effects off the real state dir / subscribers.
  delivery.configure(
    { logFile: false, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.setStateDir(d);
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
}

function mockFetch(catalog) {
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ 'opencode-go': { models: catalog } })
  });
}

// Like mockFetch but also serves a `opencode` (Zen) catalog so the additive
// free-model track (P1-2, #51) can be exercised.
function mockFetchWithZen(goCatalog, zenCatalog) {
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ 'opencode-go': { models: goCatalog }, 'opencode': { models: zenCatalog || {} } })
  });
}

function writeSnapshot(d, models) {
  fs.writeFileSync(
    path.join(d, 'pricing-snapshot.json'),
    JSON.stringify(models, null, 2)
  );
}

const mk = (cost, tiers = null) => ({ cost, tiers });

test('detects an added model', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetch({ a: mk({ input: 1 }), b: mk({ input: 2 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Added model: b')),
      'expected an "Added model: b" change, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('detects a removed model', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }), b: mk({ input: 2 }) });
    mockFetch({ a: mk({ input: 1 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Removed model: b')),
      'expected a "Removed model: b" change, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('detects a cost change (old -> new)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetch({ a: mk({ input: 2 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('(a)') && c.includes('$1→$2') && c.includes('+100%')),
      'expected a cost-change line in the unified metric-delta shape, got: ' + JSON.stringify(r.changes)
    );
    // Fix 2 (#88): no raw JSON dump in the cost-change line.
    assert.ok(
      !r.changes.some((c) => c.includes('{"input":1}') || c.includes('Cost changed for')),
      'cost-change line must not contain raw JSON, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('detects a tiers change', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }, ['free']) });
    mockFetch({ a: mk({ input: 1 }, ['paid']) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Tiers changed for a')),
      'expected a "Tiers changed for a" change, got: ' + JSON.stringify(r.changes)
    );
    // Cost was unchanged, so no cost-change line.
    assert.ok(
      !r.changes.some((c) => c.includes('Cost changed for a')),
      'cost should NOT be reported as changed'
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('no diff when catalog is identical', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetch({ a: mk({ input: 1 }) });
    const r = await runPriceWatch(d);
    assert.strictEqual(r.changes.length, 0, 'expected zero changes, got: ' + JSON.stringify(r.changes));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- P0-2: metadata extraction (capabilities / context / provider) ----------

test('metadata extraction preserves cost diff (additive, never breaks cost/tiers)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    // Catalog entry carries full metadata alongside cost.
    const fullModel = {
      cost: { input: 2 },
      limit: { context: 1000000, output: 65536 },
      provider: { npm: '@ai-sdk/anthropic' },
      tool_call: true,
      reasoning: true,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      open_weights: false,
      knowledge: '2025-04',
      name: 'Model A'
    };
    mockFetch({ a: fullModel });
    const r = await runPriceWatch(d);
    // Cost diff must still be detected exactly as before.
    assert.ok(
      r.changes.some((c) => c.includes('(a)') && c.includes('$1→$2') && c.includes('+100%')),
      'expected cost-change line preserved in unified shape, got: ' + JSON.stringify(r.changes)
    );
    assert.ok(
      !r.changes.some((c) => c.includes('{"input":1}') || c.includes('Cost changed for')),
      'cost-change line must not contain raw JSON, got: ' + JSON.stringify(r.changes)
    );
    // And the structured change must carry the metadata.
    const change = (r.modelChanges || []).find((c) => c.model === 'a' && c.subtype === 'cost');
    assert.ok(change, 'expected a cost modelChange entry, got: ' + JSON.stringify(r.modelChanges));
    assert.ok(change.meta, 'expected meta on the cost change');
    assert.strictEqual(change.meta.contextWindow, 1000000);
    assert.strictEqual(change.meta.provider, '@ai-sdk/anthropic');
    assert.strictEqual(change.meta.capabilities.tool_call, true);
    assert.strictEqual(change.meta.capabilities.reasoning, true);
    // Snapshot now persists meta for the model.
    const snap = JSON.parse(fs.readFileSync(path.join(d, 'pricing-snapshot.json'), 'utf8'));
    assert.ok(snap.a.meta && snap.a.meta.contextWindow === 1000000, 'snapshot should persist meta');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('metadata extraction handles missing fields gracefully (no crash, all-null)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }), b: mk({ input: 2 }) });
    // `b` is removed; `a` keeps only cost (no metadata at all).
    mockFetch({ a: mk({ input: 1 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Removed model: b')),
      'expected a "Removed model: b" change, got: ' + JSON.stringify(r.changes)
    );
    // Meta is present but empty for the surviving model — no throw, no false diff.
    const snap = JSON.parse(fs.readFileSync(path.join(d, 'pricing-snapshot.json'), 'utf8'));
    assert.ok('meta' in snap.a, 'snapshot entry should have a meta key');
    assert.strictEqual(snap.a.meta.contextWindow, null);
    assert.strictEqual(snap.a.meta.provider, null);
    assert.strictEqual(snap.a.meta.capabilities, null);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('extractModelMeta maps api.json fields and degrades to nulls', () => {
  const full = extractModelMeta({
    name: 'Qwen3.7 Max',
    limit: { context: 256000, output: 65536 },
    provider: { npm: '@ai-sdk/anthropic' },
    tool_call: true,
    reasoning: true,
    attachment: false,
    structured_output: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: true,
    knowledge: '2025-04',
    release_date: '2026-05-21'
  });
  assert.strictEqual(full.name, 'Qwen3.7 Max');
  assert.strictEqual(full.contextWindow, 256000);
  assert.strictEqual(full.outputLimit, 65536);
  assert.strictEqual(full.provider, '@ai-sdk/anthropic');
  assert.strictEqual(full.open_weights, true);
  assert.strictEqual(full.knowledge, '2025-04');
  assert.strictEqual(full.capabilities.tool_call, true);
  assert.strictEqual(full.capabilities.reasoning, true);
  assert.strictEqual(full.capabilities.attachment, false);
  assert.deepStrictEqual(full.capabilities.modalities.input, ['text', 'image']);

  const minimal = extractModelMeta({ id: 'x' });
  assert.strictEqual(minimal.contextWindow, null);
  assert.strictEqual(minimal.provider, null);
  assert.strictEqual(minimal.capabilities, null);
  assert.strictEqual(minimal.open_weights, null);

  // Provider id without npm still captured if a string/object id is present.
  const pid = extractModelMeta({ provider: { id: 'openai' } });
  assert.strictEqual(pid.provider, 'openai');
});

// --- P1-2: free Zen-model detection + announce (#51) -----------------------
//
// Free models are tracked under the `opencode` (Zen) key and reported in their
// own snapshot list (`freeModels`) without touching the billable cost/tiers diff.

test('free Zen model is detected and announced on add', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetchWithZen({ a: mk({ input: 1 }) }, { 'zenmodel-free': mk({ input: 0 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.freeModels.includes('zenmodel-free'),
      'expected zenmodel-free in freeModels, got: ' + JSON.stringify(r.freeModels)
    );
    assert.ok(
      r.changes.some((c) => c.includes('Free model available: zenmodel-free')),
      'expected a "Free model available: zenmodel-free" change, got: ' + JSON.stringify(r.changes)
    );
    // The billable diff must remain untouched (a is unchanged).
    assert.strictEqual(r.changes.some((c) => c.includes('Added model: a')), false, 'a should not be reported added');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('free Zen model change is announced when its cost definition changes', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }), freeModels: { 'zenmodel-free': { cost: { input: 0 } } } });
    // Cost moved from {input:0} -> {input:1} but the id still ends in -free, so it
    // stays free yet is flagged as a change.
    mockFetchWithZen({ a: mk({ input: 1 }) }, { 'zenmodel-free': mk({ input: 1 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Free model changed: zenmodel-free')),
      'expected a "Free model changed: zenmodel-free" change, got: ' + JSON.stringify(r.changes)
    );
    assert.ok(r.freeModels.includes('zenmodel-free'), 'zenmodel-free should still be tracked as free');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('free Zen model removal is announced', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }), freeModels: { 'zenmodel-free': { cost: { input: 0 } } } });
    // Zen catalog no longer lists the free model.
    mockFetchWithZen({ a: mk({ input: 1 }) }, {});
    const r = await runPriceWatch(d);
    assert.ok(
      r.changes.some((c) => c.includes('Free model removed: zenmodel-free')),
      'expected a "Free model removed: zenmodel-free" change, got: ' + JSON.stringify(r.changes)
    );
    assert.ok(
      !r.freeModels.includes('zenmodel-free'),
      'zenmodel-free must not remain in freeModels after removal, got: ' + JSON.stringify(r.freeModels)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('paid Zen model is NOT flagged as free (no false positives)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetchWithZen({ a: mk({ input: 1 }) }, { 'zenpaid': mk({ input: 5, output: 9 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      !r.freeModels.includes('zenpaid'),
      'zenpaid must NOT be flagged free, got: ' + JSON.stringify(r.freeModels)
    );
    assert.ok(
      !r.changes.some((c) => c.toLowerCase().includes('free')),
      'no free-model change should be emitted for a paid model, got: ' + JSON.stringify(r.changes)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('free detection is additive: no Zen key means no free models and no regressions', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    // Legacy mock (no `opencode` key at all) must behave exactly as before.
    mockFetch({ a: mk({ input: 1 }) });
    const r = await runPriceWatch(d);
    assert.deepStrictEqual(r.freeModels, [], 'freeModels should be empty with no Zen key');
    assert.deepStrictEqual(r.zenModels, [], 'zenModels should be empty with no Zen key');
    assert.strictEqual(r.changes.length, 0, 'expected zero changes, got: ' + JSON.stringify(r.changes));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- Zen billable set for Zen liveness scoping (#98) ------------------------
// The opencode-provider BILLABLE ids are tracked in the snapshot (`zenModels`)
// and returned by runPriceWatch so monitor.js can scope Zen liveness to
// Zen-priced + free — never the opencode-go map. Fully additive: the Go
// cost/tiers diff is untouched.

test('paid Zen models are tracked as zenModels without touching the Go diff', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }) });
    mockFetchWithZen({ a: mk({ input: 1 }) }, { 'zenpaid': mk({ input: 5, output: 9 }), 'zenfree-free': mk({ input: 0 }) });
    const r = await runPriceWatch(d);
    assert.deepStrictEqual(r.zenModels, ['zenpaid'], 'expected zenpaid in zenModels, got: ' + JSON.stringify(r.zenModels));
    assert.ok(r.freeModels.includes('zenfree-free'), 'free model must still be tracked');
    assert.ok(!r.zenModels.includes('zenfree-free'), 'free model must NOT be in the billable set');
    assert.ok(!r.zenModels.includes('a'), 'Go model must NOT be in the Zen billable set');
    // Go diff untouched: no added/removed/cost noise for a.
    assert.ok(!r.changes.some((c) => c.includes('Added model: a') || c.includes('Removed model: a')));
    // Snapshot persists the map for 304 cycles.
    const snap = JSON.parse(fs.readFileSync(path.join(d, 'pricing-snapshot.json'), 'utf8'));
    assert.ok(snap.zenModels && typeof snap.zenModels['zenpaid'] === 'object', 'snapshot must persist zenModels map');
    assert.ok(snap.freeModels && typeof snap.freeModels['zenfree-free'] === 'object', 'snapshot must still persist freeModels map');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('zenModels key in prior snapshot never leaks into the Go diff', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }), zenModels: { 'zenpaid': mk({ input: 5 }) } });
    mockFetchWithZen({ a: mk({ input: 1 }) }, { 'zenpaid': mk({ input: 5, output: 9 }) });
    const r = await runPriceWatch(d);
    assert.ok(
      !r.changes.some((c) => c.includes('zenpaid') && (c.includes('Added') || c.includes('Removed'))),
      'zenModels must never be diffed as Go models, got: ' + JSON.stringify(r.changes)
    );
    assert.deepStrictEqual(r.zenModels, ['zenpaid']);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('304 without zenModels backfills via one etag-less refetch (#98)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    // Pre-v0.15.1 snapshot: Go model only, no zenModels key. Seed the etag so
    // the first fetch is a 304.
    writeSnapshot(d, { a: mk({ input: 1 }) });
    fs.writeFileSync(path.join(d, '.etag-pricing'), 'W/"old"');
    let calls = 0;
    global.fetch = async (url, opts) => {
      calls += 1;
      const sentEtag = opts && opts.headers ? opts.headers['If-None-Match'] : null;
      if (calls === 1) {
        assert.strictEqual(sentEtag, 'W/"old"', 'first fetch must send the etag');
        return { status: 304, ok: false, headers: { get: () => null } };
      }
      assert.ok(!sentEtag, 'backfill refetch must NOT send If-None-Match, got: ' + sentEtag);
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'opencode-go': { models: { a: mk({ input: 1 }) } },
          'opencode': { models: { 'zenpaid': mk({ input: 5, output: 9 }) } }
        })
      };
    };
    const r = await runPriceWatch(d);
    assert.strictEqual(calls, 2, 'expected 304 + one backfill refetch');
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.zenModels, ['zenpaid']);
    const snap = JSON.parse(fs.readFileSync(path.join(d, 'pricing-snapshot.json'), 'utf8'));
    assert.ok(snap.zenModels && typeof snap.zenModels['zenpaid'] === 'object', 'backfill must persist zenModels');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('304 backfill failure falls back to unchanged with free-only scope (#98)', async () => {
  const d = tmpDir();
  try {
    setup(d);
    writeSnapshot(d, { a: mk({ input: 1 }), freeModels: { 'zenfree-free': { cost: { input: 0 } } } });
    fs.writeFileSync(path.join(d, '.etag-pricing'), 'W/"old"');
    global.fetch = async (url, opts) => {
      const sentEtag = opts && opts.headers ? opts.headers['If-None-Match'] : null;
      if (sentEtag) return { status: 304, ok: false, headers: { get: () => null } };
      throw new Error('offline');
    };
    const r = await runPriceWatch(d);
    assert.strictEqual(r.status, 'unchanged');
    assert.deepStrictEqual(r.zenModels, [], 'billable set unknown until a full fetch succeeds');
    assert.deepStrictEqual(r.freeModels, ['zenfree-free'], 'free scope must survive from the snapshot');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

