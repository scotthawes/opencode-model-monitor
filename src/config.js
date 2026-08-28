'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  thresholds: { warning: 80, critical: 95 },
  cadenceMs: {
    usage: 300000,
    pricing: 1800000,
    atom: 1800000,
    db: 600000,
    releases: 86400000
  },
  delivery: {
    logFile: true,
    reportFile: true,
    stdout: false,
    desktop: false,
    webhook: null
  },
  scanRoots: [process.cwd()],
  authJsonPath: path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
};

// Loads config.json (if present) merged over built-in defaults.
// Always returns a fully-populated config object; never throws.
function loadConfig(configPath) {
  configPath = configPath || path.join(__dirname, '..', 'config.json');
  let userConfig = {};
  try {
    if (fs.existsSync(configPath)) {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    }
  } catch (e) {
    // Defensive: bad config must not crash the monitor.
    try {
      console.warn('[config] could not read config.json, using defaults:', e.message);
    } catch (_) {}
  }

  const delivery = Object.assign({}, DEFAULTS.delivery, userConfig.delivery || {});
  if (userConfig.webhook != null) delivery.webhook = userConfig.webhook;
  if (userConfig.delivery && userConfig.delivery.webhook !== undefined) {
    delivery.webhook = userConfig.delivery.webhook;
  }

  const scanRoots =
    Array.isArray(userConfig.scanRoots) && userConfig.scanRoots.length
      ? userConfig.scanRoots.map((p) => path.resolve(p))
      : DEFAULTS.scanRoots;

  return {
    thresholds: Object.assign({}, DEFAULTS.thresholds, userConfig.thresholds || {}),
    cadenceMs: Object.assign({}, DEFAULTS.cadenceMs, userConfig.cadenceMs || {}),
    delivery,
    scanRoots,
    authJsonPath: userConfig.authJsonPath
      ? path.resolve(userConfig.authJsonPath)
      : DEFAULTS.authJsonPath
  };
}

module.exports = { DEFAULTS, loadConfig };
