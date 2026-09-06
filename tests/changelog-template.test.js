'use strict';

// Regression tests for v0.11.2 changelog template hardening (audit #88).
//
//  - Fix 1: added/removed/free lines show display name (meta.name else pretty
//    id), in/out per 1M, ctx, caps, cap, and flag junk descriptions with
//    "⚠️ desc-unverified" (never printing the junk verbatim).
//  - Fix 2: the cost-change line is the single metric-delta shape
//    "🔴 <Name> (<id>) output $A→$B (+P%, Nx, +$D) · in $C→$E · Eff Nx" — no
//    raw JSON dump, and changelog/report/digest all parse one format.
//  - Fix 3: tiers carry old→new labels + moved bound; privacy maps to words
//    (never raw JSON/null); cap line kept as exemplar; missing
//    family/provider/knowledge flagged with ?-markers.
//  - Extraction: description carried into meta; structured_output/interleaved
//    preserve absent (null) vs false; status:deprecated -> "⚠️ deprecated".

const test = require('node:test');
const assert = require('node:assert');

const delivery = require('../src/delivery');
const priceWatch = require('../src/price-watch');
const events = require('../src/events');

// --- Fix 1: pretty name -----------------------------------------------------

test('prettyId title-cases and splits on -_.:', () => {
  assert.strictEqual(delivery.prettyId('hy3-alpha'), 'Hy3 Alpha');
  assert.strictEqual(delivery.prettyId('ox.alpha.free'), 'Ox Alpha Free');
  assert.strictEqual(delivery.prettyId('gpt-4_5'), 'Gpt 4 5');
});

test('modelDisplayName prefers meta.name, falls back to pretty id', () => {
  const a = delivery.modelDisplayName('hy3-alpha', { name: 'Hy3 Alpha long display name used here' });
  assert.strictEqual(a.name, 'Hy3 Alpha long display name used here');
  assert.strictEqual(a.junk, false);

  const b = delivery.modelDisplayName('hy3-alpha', { name: null });
  assert.strictEqual(b.name, 'Hy3 Alpha');
  assert.strictEqual(b.junk, false);
});

test('junk descriptions are flagged and never shown verbatim', () => {
  // too short
  const short = delivery.modelDisplayName('olmo', { name: 'lol' });
  assert.strictEqual(short.junk, true);
  assert.strictEqual(short.name, 'Olmo'); // pretty id, not the junk

  // meme-case
  const meme = delivery.modelDisplayName('x', { name: 'aLpHa mOdEl' });
  assert.strictEqual(meme.junk, true);

  // duplicated across models (dupCount > 1)
  const dup = delivery.modelDisplayName('a', { name: 'Shared Model' }, 2);
  assert.strictEqual(dup.junk, true);

  // a legit (>=30 char, normal-case) description is used as-is
  const ok = delivery.modelDisplayName('nova', { name: 'A perfectly reasonable model description here' });
  assert.strictEqual(ok.junk, false);
  assert.strictEqual(ok.name, 'A perfectly reasonable model description here');
});

// --- Fix 1: added line shape -------------------------------------------------

test('added line uses display name + in/out per 1M + ctx + caps + cap', () => {
  const line = delivery.modelChangeLineStr({
    subtype: 'added',
    model: 'hy3-alpha',
    cost: { input: 0.0175, output: 0.0725 },
    meta: { name: 'Hy3 Alpha long form display name for added', contextWindow: 1000000, capabilities: { tool_call: true, reasoning: true } }
  });
  assert.ok(line.includes('🟢 Hy3 Alpha long form display name for added (hy3-alpha) ADDED'), 'display name + id + ADDED: ' + line);
  assert.ok(line.includes('in/out $0.0175/$0.0725 per 1M'), 'in/out per 1M: ' + line);
  assert.ok(line.includes('ctx 1M'), 'ctx token: ' + line);
  assert.ok(line.includes('tool+rsn'), 'caps: ' + line);
  assert.ok(/cap \$\d/.test(line), 'cap token: ' + line);
  assert.ok(!line.includes('⚠️'), 'no warning markers for a clean add: ' + line);
});

test('added line flags junk descriptions but never prints them', () => {
  const line = delivery.modelChangeLineStr({
    subtype: 'added',
    model: 'olmo',
    cost: { input: 1, output: 2 },
    meta: { name: 'lol' }
  });
  assert.ok(line.includes('⚠️ desc-unverified'), 'desc-unverified marker: ' + line);
  assert.ok(!line.includes('lol'), 'junk description must not appear verbatim: ' + line);
  assert.ok(line.includes('🟢 Olmo (olmo) ADDED'), 'pretty id shown instead: ' + line);
});

test('added line marks deprecated models (ox-alpha-free case)', () => {
  const line = delivery.modelChangeLineStr({
    subtype: 'added',
    model: 'ox-alpha-free',
    cost: { input: 0, output: 0 },
    meta: { name: 'Ox Alpha Free', status: 'deprecated', deprecated: true }
  });
  assert.ok(line.includes('⚠️ deprecated'), 'deprecated marker: ' + line);
});

// --- Fix 2: cost metric-delta shape (no JSON) --------------------------------

test('costChangeHumanText prefers output, falls back to input, no JSON', () => {
  const out = delivery.costChangeHumanText('hy3', { input: 0.0175, output: 0.0725 }, { input: 0.14, output: 0.58 }, { meta: { name: 'Hy3' } });
  assert.ok(out.startsWith('🔴 Hy3 (hy3) output $0.0725→$0.58'), 'prefers output: ' + out);
  assert.ok(out.includes('in $0.0175→$0.14'), 'secondary input line: ' + out);
  assert.ok(/Eff \d/.test(out), 'eff multiplier: ' + out);
  assert.ok(!out.includes('{'), 'no raw JSON: ' + out);

  // input-only model still produces a usable line
  const inOnly = delivery.costChangeHumanText('a', { input: 1 }, { input: 2 }, { meta: null });
  assert.ok(inOnly.startsWith('🔴 A (a) input $1→$2'), 'falls back to input: ' + inOnly);
  assert.ok(inOnly.includes('+100%'), 'metric magnitude: ' + inOnly);
  assert.ok(!inOnly.includes('{'), 'no raw JSON: ' + inOnly);
});

test('modelChangeHumanMessage cost branch has no raw JSON dump', () => {
  const msg = delivery.modelChangeHumanMessage({
    subtype: 'cost',
    model: 'hy3',
    oldCost: { input: 0.0175, output: 0.0725 },
    newCost: { input: 0.14, output: 0.58 },
    meta: { name: 'Hy3' }
  });
  assert.ok(!msg.includes('Cost changed for'), 'old prefix gone: ' + msg);
  assert.ok(!msg.includes('{'), 'no braces: ' + msg);
  assert.ok(/🔴 .+ \(hy3\) (output|input) \$\d/.test(msg), 'new shape: ' + msg);
});

test('changelog/report/digest parse one format (cost)', () => {
  // The new format round-trips through the migration parser (events).
  const msg = delivery.modelChangeHumanMessage({
    subtype: 'cost',
    model: 'hy3',
    oldCost: { input: 0.0175, output: 0.0725 },
    newCost: { input: 0.14, output: 0.58 },
    meta: { name: 'Hy3' }
  });
  const parsed = events.parseCostLine(msg);
  assert.strictEqual(parsed.model, 'hy3');
  assert.strictEqual(parsed.old.output, 0.0725);
  assert.strictEqual(parsed.new.output, 0.58);
  assert.strictEqual(parsed.old.input, 0.0175);
  assert.strictEqual(parsed.new.input, 0.14);
});

// --- Fix 3: tiers labels + moved bound ---------------------------------------

test('tiers line carries old->new labels and moved bound', () => {
  const line = delivery.modelChangeLineStr({
    subtype: 'tiers',
    model: 'hy3',
    oldTiers: [{ type: 'standard', size: 200000 }, { type: 'large-context', size: 256000 }],
    newTiers: [{ type: 'standard', size: 200000 }, { type: 'large-context', size: 1000000 }],
    meta: { name: 'A sufficiently long model display name for tiers' }
  });
  assert.ok(line.includes('⚪ A sufficiently long model display name for tiers (hy3) TIERS standard+large-context → standard+large-context'), 'labels: ' + line);
  assert.ok(line.includes('large-context ctx 256k→1M'), 'moved bound: ' + line);
});

test('tiersNormalizedEqual skips pure reorderings (no false alert)', () => {
  assert.strictEqual(
    priceWatch.tiersNormalizedEqual(
      [{ type: 'standard', size: 200000 }, { type: 'large-context', size: 1000000 }],
      [{ type: 'large-context', size: 1000000 }, { type: 'standard', size: 200000 }]
    ),
    true,
    'reorder is not a change'
  );
  assert.strictEqual(
    priceWatch.tiersNormalizedEqual(
      [{ type: 'standard', size: 200000 }],
      [{ type: 'standard', size: 256000 }]
    ),
    false,
    'size move is a change'
  );
});

test('cap line is kept as the exemplar (with magnitude + warning)', () => {
  const line = delivery.modelChangeLineStr({
    subtype: 'cap',
    model: 'grok-4.6',
    oldCap: 60,
    newCap: 15,
    factor: 4,
    direction: 'downgraded',
    meta: null
  });
  assert.ok(line.includes('⚠️'), 'warning kept: ' + line);
  assert.ok(line.includes('60→15'), 'old→new cap: ' + line);
  assert.ok(line.includes('4x more expensive'), 'magnitude kept: ' + line);
});

test('metaShort flags missing family/provider/knowledge with ?-markers', () => {
  const s = delivery.metaShort({ contextWindow: 1000000, capabilities: { tool_call: true } });
  assert.ok(s.includes('family?'), 'missing family flagged: ' + s);
  assert.ok(s.includes('provider?'), 'missing provider flagged: ' + s);
  assert.ok(s.includes('knowledge?'), 'missing knowledge flagged: ' + s);
  const present = delivery.metaShort({ family: 'x', provider: '@ai/anthropic', knowledge: '2025-04' });
  assert.ok(present.includes('provider:anthropic'), 'present provider shortened: ' + present);
  assert.ok(!present.includes('provider?'), 'present provider not flagged: ' + present);
});

// --- Fix 3: privacy words ----------------------------------------------------

test('formatPrivacyWords maps to words, never raw JSON/null', () => {
  assert.strictEqual(delivery.formatPrivacyWords(null), 'unknown');
  assert.strictEqual(delivery.formatPrivacyWords({ training: true }), 'privacy: trains');
  assert.strictEqual(delivery.formatPrivacyWords({ training: false }), 'privacy: no-train');
  assert.strictEqual(
    delivery.formatPrivacyWords({ training: true, zdrValidUntil: '2026-12-31' }),
    'privacy: trains · ZDR until 2026-12-31'
  );
  assert.ok(!/\{/.test(delivery.formatPrivacyWords({ training: true })), 'no JSON: ' + delivery.formatPrivacyWords({ training: true }));
});

// --- Extraction hardening ----------------------------------------------------

test('extractModelMeta carries description and status:deprecated', () => {
  const m = priceWatch.extractModelMeta({ name: 'Ox Alpha Free', status: 'deprecated', description: 'free alpha build' });
  assert.strictEqual(m.name, 'Ox Alpha Free');
  assert.strictEqual(m.description, 'free alpha build');
  assert.strictEqual(m.status, 'deprecated');
  assert.strictEqual(m.deprecated, true);

  // description survives even when name is absent
  const noName = priceWatch.extractModelMeta({ description: 'a long description of the model' });
  assert.strictEqual(noName.name, null);
  assert.strictEqual(noName.description, 'a long description of the model');
});

test('extractModelMeta preserves absent (null) vs explicit false', () => {
  const absent = priceWatch.extractModelMeta({ tool_call: true });
  assert.strictEqual(absent.capabilities.structured_output, null, 'absent -> null, not false');
  assert.strictEqual(absent.capabilities.interleaved, null, 'absent -> null, not false');

  const explicitFalse = priceWatch.extractModelMeta({ tool_call: true, structured_output: false, interleaved: false });
  assert.strictEqual(explicitFalse.capabilities.structured_output, false, 'explicit false stays false');
  assert.strictEqual(explicitFalse.capabilities.interleaved, false, 'explicit false stays false');
});
