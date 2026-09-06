'use strict';

// Unit tests for the tracker repo Atom feed wiring (#94):
// src/config.js defaults, src/monitor.js cycle + continuous wiring, and
// src/atom-watch.js per-key isolation + failure dedup for the new feed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const delivery = require('../src/delivery');
const { DEFAULTS, loadConfig } = require('../src/config');
const { runAtomWatch } = require('../src/atom-watch');

const TRACKER_URL = 'https://github.com/all-the-rest/ocgo-price-tracker/commits/main.atom';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-tracker-'));
}

function setup(d, opts) {
  delivery.configure(
    { logFile: true, reportFile: false, stdout: false, desktop: false, webhook: null },
    d
  );
  delivery.setStateDir(d);
  delivery.setSubscribers([]);
  delivery.setKnownModelIds(new Set());
  delivery.init(
    d,
    Object.assign({ dedupTtlMs: 3600000, changelogRetentionMs: 7 * 24 * 3600 * 1000 }, opts || {})
  );
}

const origFetch = global.fetch;
function restoreFetch() {
  global.fetch = origFetch;
}

function atomXml(entries) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
    entries
      .map(
        (e) =>
          `<entry><title type="html">${e.title}</title><updated>${e.updated}</updated>` +
          `<id>${e.id}</id><link href="${e.link}"/></entry>`
      )
      .join('') +
    '</feed>'
  );
}

function mockFeed200(entries, etag) {
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: (k) => (k === 'etag' ? etag || '"tracker-etag-1"' : null) },
    text: async () => atomXml(entries)
  });
}

function alertsLog(d) {
  try {
    return fs.readFileSync(path.join(d, 'alerts.log'), 'utf8');
  } catch (_) {
    return '';
  }
}

// --- config defaults ---------------------------------------------------------

test('config defaults include the verified-live tracker feed + 6h cadence', () => {
  assert.strictEqual(DEFAULTS.feeds.tracker, TRACKER_URL);
  assert.strictEqual(DEFAULTS.cadenceMs.tracker, 21600000);
  const cfg = loadConfig(path.join(os.tmpdir(), 'mbg-nonexistent-config.json'));
  assert.strictEqual(cfg.feeds.tracker, TRACKER_URL);
  assert.strictEqual(cfg.cadenceMs.tracker, 21600000);
});

test('user config.json can override the tracker feed', () => {
  const d = tmpDir();
  try {
    const p = path.join(d, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ feeds: { tracker: 'https://example.com/custom.atom' } }));
    const cfg = loadConfig(p);
    assert.strictEqual(cfg.feeds.tracker, 'https://example.com/custom.atom');
    // Other feed defaults survive the merge.
    assert.ok(cfg.feeds.releases, 'releases feed default preserved');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- monitor.js wiring (source-level: cycle + continuous + banner) ------------

test('monitor.js wires tracker into cycle, continuous interval, and banner', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'monitor.js'), 'utf8');
  assert.ok(
    src.includes("runAtomWatch(stateDir, 'tracker', feeds.tracker)"),
    'cycle Promise.all must include the tracker feed'
  );
  assert.ok(
    src.includes("runAtomWatch(stateDir, 'tracker', config.feeds.tracker)"),
    'continuous mode must poll the tracker feed'
  );
  assert.ok(
    src.includes('c.tracker'),
    'continuous tracker poll must use its own cadence'
  );
  assert.ok(
    src.includes('dedupKey: \'monitor:atom:tracker\''),
    'continuous tracker failures must carry a dedupKey'
  );
  assert.ok(src.includes('tracker every'), 'startup banner must mention the tracker cadence');
});

// --- per-key isolation --------------------------------------------------------

test('tracker ETag/seenIds are isolated per key from other feeds', async () => {
  const d = tmpDir();
  try {
    setup(d);
    // Seed a *different* feed's store + etag; the tracker run must not touch them.
    fs.writeFileSync(
      path.join(d, 'feed-goPricing.json'),
      JSON.stringify({ etag: '"go-etag"', seenIds: ['go-id-1'] })
    );
    fs.writeFileSync(path.join(d, '.etag-goPricing'), '"go-etag"');
    mockFeed200(
      [{ title: 'tracker: free model added', updated: '2026-09-06T00:00:00Z', id: 'tracker-id-1', link: 'https://example.com/1' }],
      '"tracker-etag-9"'
    );
    const r = await runAtomWatch(d, 'tracker', TRACKER_URL);
    assert.strictEqual(r.key, 'tracker');
    assert.strictEqual(r.newEntries.length, 1);
    assert.strictEqual(r.newEntries[0].id, 'tracker-id-1');
    // Tracker store written under its own key…
    const store = JSON.parse(fs.readFileSync(path.join(d, 'feed-tracker.json'), 'utf8'));
    assert.deepStrictEqual(store.seenIds, ['tracker-id-1']);
    assert.strictEqual(store.etag, '"tracker-etag-9"');
    // …while the other feed's files are byte-identical.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, 'feed-goPricing.json'), 'utf8')), {
      etag: '"go-etag"',
      seenIds: ['go-id-1']
    });
    assert.strictEqual(fs.readFileSync(path.join(d, '.etag-goPricing'), 'utf8'), '"go-etag"');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('tracker sends If-None-Match from its own etag file', async () => {
  const d = tmpDir();
  try {
    setup(d);
    fs.writeFileSync(path.join(d, '.etag-tracker'), '"tracker-etag-9"');
    let sawNoneMatch = false;
    global.fetch = async (url, init) => {
      if (init && init.headers && init.headers['If-None-Match'] === '"tracker-etag-9"') {
        sawNoneMatch = true;
      }
      return { status: 304, ok: false, headers: { get: () => null } };
    };
    const r = await runAtomWatch(d, 'tracker', TRACKER_URL);
    assert.deepStrictEqual(r.newEntries, []);
    assert.ok(sawNoneMatch, 'expected per-key If-None-Match to be sent');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- new entries alert once, then quiet ---------------------------------------

test('new tracker entries alert model_change once, repeat run is quiet', async () => {
  const d = tmpDir();
  try {
    setup(d);
    mockFeed200(
      [{ title: 'docs: mark hy3 usage-moved', updated: '2026-09-06T00:00:00Z', id: 'tracker-id-7', link: 'https://example.com/7' }],
      '"tracker-etag-7"'
    );
    const r1 = await runAtomWatch(d, 'tracker', TRACKER_URL);
    assert.strictEqual(r1.newEntries.length, 1);
    assert.match(alertsLog(d), /MODEL_CHANGE \| Feed update: tracker/);
    const logAfterFirst = alertsLog(d);

    // Same payload again → 304-style quiet via seenIds (no new alert lines).
    mockFeed200(
      [{ title: 'docs: mark hy3 usage-moved', updated: '2026-09-06T00:00:00Z', id: 'tracker-id-7', link: 'https://example.com/7' }],
      '"tracker-etag-7"'
    );
    const r2 = await runAtomWatch(d, 'tracker', TRACKER_URL);
    assert.strictEqual(r2.newEntries.length, 0);
    assert.strictEqual(alertsLog(d), logAfterFirst, 'second run must add no alert lines');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- failures deduped ----------------------------------------------------------

test('tracker fetch failures warn once per TTL (dedupKey), HTTP errors too', async () => {
  const d = tmpDir();
  try {
    setup(d);
    global.fetch = async () => {
      throw new Error('network down');
    };
    await runAtomWatch(d, 'tracker', TRACKER_URL);
    await runAtomWatch(d, 'tracker', TRACKER_URL);
    const warnings = alertsLog(d)
      .split('\n')
      .filter((l) => l.includes('WARNING') && l.includes('Feed fetch failed: tracker'));
    assert.strictEqual(warnings.length, 1, 'throw-failures must dedup to one warning');

    // A different failure shape (HTTP 500) shares the same per-key dedup window.
    global.fetch = async () => ({ status: 500, ok: false, headers: { get: () => null } });
    await runAtomWatch(d, 'tracker', TRACKER_URL);
    const all = alertsLog(d)
      .split('\n')
      .filter((l) => l.includes('WARNING') && l.includes('tracker'));
    assert.strictEqual(all.length, 1, 'HTTP failure within TTL must stay suppressed');

    // And a *different* feed key is not suppressed by the tracker dedup.
    global.fetch = async () => {
      throw new Error('network down');
    };
    await runAtomWatch(d, 'releases', 'https://example.com/releases.atom');
    const releasesWarn = alertsLog(d)
      .split('\n')
      .filter((l) => l.includes('WARNING') && l.includes('Feed fetch failed: releases'));
    assert.strictEqual(releasesWarn.length, 1, 'other feed keys keep their own dedup slot');
  } finally {
    restoreFetch();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
