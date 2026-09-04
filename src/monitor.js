'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const delivery = require('./delivery');
const { runPriceWatch } = require('./price-watch');
const { runUsage } = require('./usage');
const { runConfigScan } = require('./config-scan');
const { runAtomWatch } = require('./atom-watch');
const discordDigest = require('./discord-digest');

// Post the periodic Discord digest on this cadence while running continuously.
const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;

// --- Singleton lockfile ----------------------------------------------------
//
// We must never run two monitors against the same state dir at once: they would
// race on pricing-snapshot.json / usage-history.json and double-post alerts.
// State dir is fixed at <repo>/state, so the lock lives at state/.monitor.lock
// holding { pid, ts }. On start: if an alive PID owns the lock → exit (unless
// --force). A dead-PID lock is stale and auto-cleared (WARNING when >10min old).
// Removed on clean exit. gitignored (under state/), so never committed.
const LOCK_PATH = path.join(__dirname, '..', 'state', '.monitor.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we lack signal permission → still alive.
    return e && e.code === 'EPERM';
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeLock() {
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch (_) {}
}

function removeLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
}

// Returns true if WE now own the lock (wrote it). On a live-PID conflict it
// prints a refusal message and process.exit(2) — it never returns false to the
// caller in that case. `--force` overrides any existing lock (alive or stale).
function acquireLock(force) {
  const lock = readLock();
  if (!lock) {
    writeLock();
    return true;
  }
  if (isPidAlive(lock.pid)) {
    if (force) {
      removeLock();
      writeLock();
      return true;
    }
    console.error(
      `[lock] Another monitor instance is already running (PID ${lock.pid}). ` +
        `Refusing to start. Use --force to override.`
    );
    process.exit(2);
    return false;
  }
  // Dead PID → the lock is stale. Clear it (WARNING when it was old) and take it.
  const age = Date.now() - (lock.ts || 0);
  if (age > LOCK_STALE_MS) {
    delivery.alert(
      'warning',
      'Stale monitor lock cleared',
      `removed lock from dead PID ${lock.pid} (age >10min)`
    );
  }
  removeLock();
  writeLock();
  return true;
}

// --- alerts.log rotation ----------------------------------------------------
// Cap alerts.log at ~1MB; when exceeded, rename it to alerts.log.1 (overwriting
// the previous rotation) on start/cycle. Best-effort, never throws.
const ALERTS_LOG_MAX_BYTES = 1_000_000;
function maybeRotateAlertsLog(stateDir) {
  try {
    const logPath = path.join(stateDir, 'alerts.log');
    if (!fs.existsSync(logPath)) return;
    const { size } = fs.statSync(logPath);
    if (size <= ALERTS_LOG_MAX_BYTES) return;
    fs.renameSync(logPath, path.join(stateDir, 'alerts.log.1'));
  } catch (_) {}
}


// Build a demo model-change table from the last real hy3 numbers: take hy3's
// current cost as the "new" values and derive the "old" by dividing by 8 (the
// real 8x jump hy3 took). Returns one-or-more Discord-safe content chunks.
function buildDemoModelTable(stateDir) {
  let cost = null;
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(stateDir, 'pricing-snapshot.json'), 'utf8'));
    cost = snap && snap['hy3'] && snap['hy3'].cost;
  } catch (_) {
    cost = null;
  }
  if (!cost || !cost.input) {
    cost = { input: 0.14, output: 0.58, cache_read: 0.035 };
  }
  const oldCost = {};
  for (const k of Object.keys(cost)) oldCost[k] = cost[k] / 8;
  return delivery.buildModelChangeChunks(
    [{ subtype: 'cost', model: 'hy3', oldCost, newCost: cost }],
    []
  );
}

async function main() {
  const config = loadConfig();
  const stateDir = path.join(__dirname, '..', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  delivery.configure(config.delivery, stateDir);
  // Rotate alerts.log at process start (in addition to each cycle) so a long-lived
  // continuous process never grows it past the cap between cycles.
  maybeRotateAlertsLog(stateDir);

  const once = process.argv.includes('--once') || process.argv.includes('-1');
  const digestOnce = process.argv.includes('--digest-once');
  const demoTable = process.argv.includes('--demo-model-table');
  const force = process.argv.includes('--force');

  // Latest models map, refreshed by price-watch, used by config-scan.
  let latestModels = {};

  // One-shot demo: post the new aggregated model-change table to Discord using
  // the last real hy3 change (current cost -> 8x older) as the example, labeled
  // DEMO. Never logs webhook URLs. Exits after delivery.
  if (demoTable) {
    delivery.init(stateDir, {
      dedupTtlMs: 86400000,
      changelogRetentionMs: (config.changelogRetentionDays || 7) * 24 * 60 * 60 * 1000
    });
    const chunks = buildDemoModelTable(stateDir);
    let first = true;
    for (const c of chunks) {
      await delivery.sendToSubscribers('model_change', (first ? '**DEMO** · ' : '') + c);
      first = false;
    }
    await delivery.alert(
      'info',
      'Demo model table posted',
      `DEMO — ${chunks.length} chunk(s) sent to model_change subscribers`,
      { noChangelog: true }
    );
    await shutdown(0);
  }

  async function cycle() {
    delivery.init(stateDir, {
      dedupTtlMs: 86400000,
      changelogRetentionMs: (config.changelogRetentionDays || 7) * 24 * 60 * 60 * 1000
    });
    // Rotate alerts.log at the top of every cycle so a continuous run caps it
    // even if the process is never restarted.
    maybeRotateAlertsLog(stateDir);
    await delivery.alert('info', 'Monitor cycle started', new Date().toISOString(), { noChangelog: true });

    const pricing = await runPriceWatch(stateDir).catch((e) => ({
      status: 'unknown',
      error: String(e && e.message ? e.message : e),
      models: {}
    }));
    const modelsMap = (pricing && pricing.models) || {};
    latestModels = modelsMap;
    delivery.setKnownModelIds(new Set(Object.keys(modelsMap)));

    const usage = await runUsage(config.authJsonPath, config.thresholds, stateDir).catch((e) => ({
      status: 'unknown',
      error: String(e && e.message ? e.message : e)
    }));

    let pins = [];
    try {
      pins = runConfigScan(config.scanRoots, latestModels);
    } catch (e) {
      await delivery.alert('warning', 'config-scan failed', String(e && e.message ? e.message : e));
    }

    const feedUpdates = [];
    try {
      const feeds = config.feeds || {};
      const results = await Promise.all([
        runAtomWatch(stateDir, 'goPricing', feeds.goPricing),
        runAtomWatch(stateDir, 'zenPricing', feeds.zenPricing),
        runAtomWatch(stateDir, 'releases', feeds.releases)
      ]);
      for (const r of results) feedUpdates.push(r);
    } catch (e) {
      await delivery.alert('warning', 'atom-watch failed', String(e && e.message ? e.message : e));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      pricing,
      usage,
      pins,
      feedUpdates
    };
    delivery.writeReport(report);
    await delivery.alert('info', 'Monitor cycle complete', new Date().toISOString(), { noChangelog: true });
    return report;
  }

  // Flush any signals before exiting so async delivery (webhook/desktop) that
  // was kicked off during the cycle is not dropped by a premature process.exit.
  async function shutdown(code) {
    try {
      await delivery.flush();
    } catch (_) {
      // best effort
    }
    // Release the singleton lock on any clean exit (--once, --digest-once,
    // signals, --demo-model-table). Best-effort, never throws.
    removeLock();
    process.exit(code);
  }

  // Acquire the singleton lock. Exits (code 2) if another live instance holds
  // it, unless --force. --once and continuous BOTH respect the lock; only
  // --force overrides. Skipped for --demo-model-table (quick post, no cycle).
  if (!demoTable) acquireLock(force);

  await cycle();

  // Manual one-shot digest: post the current 7-day summary and exit. This is
  // the command used to push a live baseline into Discord on demand. It does
  // NOT run on the plain `--once` path (which is purely a monitor check).
  if (digestOnce) {
    const chunks = await discordDigest.postDigest({ stateDir });
    await delivery.alert(
      'info',
      'Discord digest posted',
      `${chunks.length} chunk(s) sent to digest subscribers`,
      { noChangelog: true }
    );
    await shutdown(0);
  }

  if (once) {
    await shutdown(0);
  }

  // Continuous mode: flush pending deliveries before exiting on a signal.
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // Continuous mode: schedule each feed with its own interval.
  const c = config.cadenceMs;

  setInterval(() => {
    runPriceWatch(stateDir)
      .then((p) => {
        if (p && p.models) latestModels = p.models;
      })
      .catch((e) =>
        delivery.alert('warning', 'price-watch failed', String(e && e.message ? e.message : e))
      );
  }, c.pricing);

  setInterval(() => {
    runUsage(config.authJsonPath, config.thresholds, stateDir).catch((e) =>
      delivery.alert('warning', 'usage failed', String(e && e.message ? e.message : e))
    );
  }, c.usage);

  setInterval(() => {
    try {
      runConfigScan(config.scanRoots, latestModels);
    } catch (e) {
      delivery.alert('warning', 'config-scan failed', String(e && e.message ? e.message : e));
    }
  }, c.db);

  // Atom feeds: Go + Zen pricing docs commits on the atom cadence, releases on
  // the (slower) releases cadence. Each call is idempotent via persisted seenIds.
  setInterval(() => {
    runAtomWatch(stateDir, 'goPricing', config.feeds.goPricing).catch((e) =>
      delivery.alert('warning', 'atom-watch failed: goPricing', String(e && e.message ? e.message : e))
    );
  }, c.atom);

  setInterval(() => {
    runAtomWatch(stateDir, 'zenPricing', config.feeds.zenPricing).catch((e) =>
      delivery.alert('warning', 'atom-watch failed: zenPricing', String(e && e.message ? e.message : e))
    );
  }, c.atom);

  setInterval(() => {
    runAtomWatch(stateDir, 'releases', config.feeds.releases).catch((e) =>
      delivery.alert('warning', 'atom-watch failed: releases', String(e && e.message ? e.message : e))
    );
  }, c.releases);

  // Periodic Discord digest: post the human-readable 7-day summary once a day
  // so the Discord channel becomes the alert + report hub (not just alerts).
  setInterval(() => {
    discordDigest
      .postDigest({ stateDir })
      .catch((e) =>
        delivery.alert('warning', 'discord digest failed', String(e && e.message ? e.message : e))
      );
  }, DIGEST_INTERVAL_MS);

  await delivery.alert(
    'info',
    'Monitor running (continuous)',
    `usage every ${c.usage}ms, pricing every ${c.pricing}ms, config-scan every ${c.db}ms, ` +
      `atom feeds every ${c.atom}ms, releases every ${c.releases}ms`,
    { noChangelog: true }
  );
}

main().catch((e) => {
  try {
    console.error('Fatal:', e);
  } catch (_) {}
  process.exit(1);
});
