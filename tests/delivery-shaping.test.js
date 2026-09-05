'use strict';

// Unit tests for delivery shaping:
//  - Discord webhooks get { content } (+ username); Slack/custom get { text }
//  - model-change table is chunked at 1900 chars and paginates past 10 rows
//  - the cost-change table renders old -> new values with an arrow

const test = require('node:test');
const assert = require('node:assert');

const delivery = require('../src/delivery');
const discordDigest = require('../src/discord-digest');

const SUB = { name: 's' };
const DISCORD_URL = 'https://discord.com/api/webhooks/123/abc';
const SLACK_URL = 'https://hooks.slack.com/services/T/B/X';

test('Discord payload uses { content, embeds } with color, Slack uses { text }', () => {
  const d = delivery.buildSubscriberDelivery(SUB, DISCORD_URL, 'warning', 'Title', 'Msg');
  // Fix (c): embed-eligible levels send a rich embed with a non-empty content
  // fallback (Discord requires content) so the post is always valid.
  assert.ok(Array.isArray(d.payload.embeds), 'Discord payload must include embeds');
  assert.strictEqual(d.payload.embeds.length, 1, 'exactly one embed');
  assert.strictEqual(d.payload.embeds[0].color, 0xf1c40f, 'warning color is amber');
  assert.strictEqual(d.payload.embeds[0].description, 'Msg');
  assert.strictEqual(d.payload.embeds[0].title, 'Title');
  assert.ok(typeof d.payload.embeds[0].timestamp === 'string', 'embed has a timestamp');
  assert.ok(d.payload.content.length > 0 && d.payload.content.length <= 1900, 'non-empty content fallback');
  assert.strictEqual(d.payload.username, 'model-monitor');

  const s = delivery.buildSubscriberDelivery(SUB, SLACK_URL, 'warning', 'Title', 'Msg');
  assert.deepStrictEqual(s.payload, { text: '[WARNING] Title — Msg' });
});

test('embed colors map to status (model_change green / critical red)', () => {
  const mc = delivery.buildSubscriberDelivery(SUB, DISCORD_URL, 'model_change', 'M', 'msg');
  assert.strictEqual(mc.payload.embeds[0].color, 0x2ecc71, 'model_change green');
  const crit = delivery.buildSubscriberDelivery(SUB, DISCORD_URL, 'critical', 'C', 'msg');
  assert.strictEqual(crit.payload.embeds[0].color, 0xe74c3c, 'critical red');
});

test('embed respects field + total limits (<=5 fields, content<=1900)', () => {
  const fields = [];
  for (let i = 0; i < 8; i++) fields.push({ name: 'n' + i, value: 'v' + i });
  const payload = delivery.buildDiscordPayload('warning', 'fallback text', {
    title: 'T',
    description: 'desc',
    fields
  });
  assert.strictEqual(payload.embeds[0].fields.length, 5, 'fields capped at 5');
  assert.ok(payload.content.length > 0 && payload.content.length <= 1900, 'content within 1900');
  const total = JSON.stringify(payload).length;
  assert.ok(total <= 6000, 'total envelope within 6000, got ' + total);
});

test('embed content is non-empty even when description would be empty', () => {
  const payload = delivery.buildDiscordPayload('warning', 'fallback', { title: 'T', description: '' });
  assert.ok(payload.content.length > 0, 'content fallback present');
  assert.strictEqual(payload.embeds[0].description, '', 'empty description preserved');
});

test('model-change table chunk respects the 1900-char cap and paginates', () => {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({
      subtype: 'cost',
      model: 'model-' + i,
      oldCost: { input: 0.01, output: 0.02, cache_read: 0.005 },
      newCost: { input: 0.02, output: 0.04, cache_read: 0.01 }
    });
  }
  const chunks = delivery.buildModelChangeChunks(rows, []);
  assert.strictEqual(chunks.length, 3, '25 rows at 10/page => 3 chunks');
  for (const c of chunks) {
    assert.ok(c.length <= 1900, 'chunk exceeded 1900 chars: ' + c.length);
  }
});

test('model-change table renders old -> new with an arrow', () => {
  const rows = [
    {
      subtype: 'cost',
      model: 'hy3',
      oldCost: { input: 0.0175, output: 0.14 },
      newCost: { input: 0.14, output: 1.1 }
    }
  ];
  const body = delivery.buildModelChangeChunks(rows, []).join('\n');
  assert.ok(body.includes('0.0175'), 'old input cost missing: ' + body);
  assert.ok(body.includes('0.14'), 'new input cost missing: ' + body);
  assert.ok(body.includes('→'), 'arrow missing: ' + body);
});

test('added/removed/tiers lines are included in the table body', () => {
  const lines = [
    { subtype: 'added', model: 'nova', cost: { input: 0.01, output: 0.02 } },
    { subtype: 'removed', model: 'legacy' },
    { subtype: 'tiers', model: 'mid' }
  ];
  const body = delivery.buildModelChangeChunks([], lines).join('\n');
  assert.ok(body.includes('ADDED'), body);
  assert.ok(body.includes('REMOVED'), body);
  assert.ok(body.includes('TIERS'), body);
});

test('discord-digest chunkText honors the 1900-char cap', () => {
  const long = 'x'.repeat(5000);
  const chunks = discordDigest.chunkText(long, 1900);
  assert.ok(chunks.length >= 3, 'expected >=3 chunks, got ' + chunks.length);
  for (const c of chunks) {
    assert.ok(c.length <= 1900, 'chunk exceeded 1900 chars: ' + c.length);
  }
});

test('deliverRawContent keeps content short (no content/embed duplication)', async () => {
  const captured = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    captured.push(JSON.parse(opts.body));
    return { ok: true };
  };
  try {
    delivery.setSubscribers([
      { name: 's', levels: ['digest'], webhookUrl: 'https://discord.com/api/webhooks/123/abc' }
    ]);
    const full = '**Monitor** 🔴 2 changes · next reset tomorrow\n' +
      '**What changed**\n' +
      '• hy3 cost 0.0175→0.14 — model_change\n' +
      '• Quota monthly warning: 83% used (latest, 2 repeats) — warning';
    await delivery.sendToSubscribers('digest', full);
    assert.strictEqual(captured.length, 1, 'one webhook request');
    const payload = captured[0];
    assert.ok(payload.content.length > 0, 'content must be non-empty');
    assert.ok(payload.content.length <= 1900, 'content within Discord cap');
    assert.strictEqual(payload.embeds[0].description, full, 'embed carries the full content');
    assert.notStrictEqual(payload.content, payload.embeds[0].description, 'content must not duplicate the full body');
    assert.ok(payload.content.length < payload.embeds[0].description.length, 'content should be shorter than description');
    // The short content fallback is the first line only.
    assert.strictEqual(payload.content, '**Monitor** 🔴 2 changes · next reset tomorrow');
  } finally {
    global.fetch = origFetch;
    delivery.setSubscribers([]);
  }
});
