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

test('Discord payload uses { content }, Slack uses { text }', () => {
  const d = delivery.buildSubscriberDelivery(SUB, DISCORD_URL, 'warning', 'Title', 'Msg');
  assert.deepStrictEqual(d.payload, { content: '[WARNING] Title — Msg', username: 'model-monitor' });

  const s = delivery.buildSubscriberDelivery(SUB, SLACK_URL, 'warning', 'Title', 'Msg');
  assert.deepStrictEqual(s.payload, { text: '[WARNING] Title — Msg' });
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
