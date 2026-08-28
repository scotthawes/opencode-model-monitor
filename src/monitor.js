'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const delivery = require('./delivery');
const { runPriceWatch } = require('./price-watch');
const { runUsage } = require('./usage');
const { runConfigScan } = require('./config-scan');

async function main() {
  const config = loadConfig();
  const stateDir = path.join(__dirname, '..', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  delivery.configure(config.delivery, stateDir);

  const once = process.argv.includes('--once') || process.argv.includes('-1');

  // Latest models map, refreshed by price-watch, used by config-scan.
  let latestModels = {};

  async function cycle() {
    delivery.alert('info', 'Monitor cycle started', new Date().toISOString());

    const pricing = await runPriceWatch(stateDir).catch((e) => ({
      status: 'unknown',
      error: String(e && e.message ? e.message : e),
      models: {}
    }));
    const modelsMap = (pricing && pricing.models) || {};
    latestModels = modelsMap;

    const usage = await runUsage(config.authJsonPath, config.thresholds).catch((e) => ({
      status: 'unknown',
      error: String(e && e.message ? e.message : e)
    }));

    let pins = [];
    try {
      pins = runConfigScan(config.scanRoots, latestModels);
    } catch (e) {
      delivery.alert('warning', 'config-scan failed', String(e && e.message ? e.message : e));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      pricing,
      usage,
      pins
    };
    delivery.writeReport(report);
    delivery.alert('info', 'Monitor cycle complete', new Date().toISOString());
    return report;
  }

  await cycle();

  if (once) {
    process.exit(0);
  }

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
    runUsage(config.authJsonPath, config.thresholds).catch((e) =>
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

  // NOTE: atom/releases feeds are deferred to a later phase; cadence entries
  // remain configurable but are intentionally not polled yet.
  delivery.alert(
    'info',
    'Monitor running (continuous)',
    `usage every ${c.usage}ms, pricing every ${c.pricing}ms, config-scan every ${c.db}ms`
  );
}

main().catch((e) => {
  try {
    console.error('Fatal:', e);
  } catch (_) {}
  process.exit(1);
});
