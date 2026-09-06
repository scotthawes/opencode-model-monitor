'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  thresholds: { warning: 80, critical: 95, quotaDeltaPct: 5 },
  changelogRetentionDays: 7,
  cadenceMs: {
    usage: 300000,
    pricing: 1800000,
    atom: 1800000,
    db: 600000,
    releases: 86400000,
    tracker: 21600000
  },
  delivery: {
    logFile: true,
    reportFile: true,
    stdout: false,
    desktop: false,
    webhook: null
  },
  scanRoots: [process.cwd()],
  authJsonPath: path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
  feeds: {
    goPricing: 'https://github.com/anomalyco/opencode/commits/dev/packages/web/src/content/docs/go.mdx.atom',
    zenPricing: 'https://github.com/anomalyco/opencode/commits/dev/packages/web/src/content/docs/zen.mdx.atom',
    releases: 'https://github.com/anomalyco/opencode/releases.atom',
    tracker: 'https://github.com/all-the-rest/ocgo-price-tracker/commits/main.atom'
  }
};

// Loads config.json (if present) merged over built-in defaults.
// Always returns a fully-populated config object; never throws.
// v0.20.0 (#112): unknown top-level keys warn (typos no longer silent);
// numeric thresholds/cadences are clamped to sane ranges; `~` in
// authJsonPath/scanRoots is expanded to the home directory.
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

  // v0.20.0 (#112): unknown-key validation — warn on typos instead of ignoring.
  try {
    const known = new Set(Object.keys(DEFAULTS));
    for (const k of Object.keys(userConfig)) {
      if (!known.has(k) && k !== 'webhook') {
        try { console.warn(`[config] unknown key "${k}" ignored (check spelling)`); } catch (_) {}
      }
    }
  } catch (_) {}

  // v0.20.0 (#112): clamp numeric knobs to sane ranges.
  function clampNum(v, lo, hi, fallback) {
    return typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  }

  // v0.20.0 (#112): expand a leading `~` to the home directory.
  function expandHome(p) {
    if (typeof p !== 'string') return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
  }

  // Environment overrides win over config.json (and defaults).
  if (
    process.env.MODEL_MONITOR_DESKTOP === '1' ||
    process.env.MODEL_MONITOR_DESKTOP === 'true'
  ) {
    delivery.desktop = true;
  }
  if (process.env.MODEL_MONITOR_WEBHOOK) {
    delivery.webhook = process.env.MODEL_MONITOR_WEBHOOK;
  }

  const scanRoots =
    Array.isArray(userConfig.scanRoots) && userConfig.scanRoots.length
      ? userConfig.scanRoots.map((p) => path.resolve(expandHome(p)))
      : DEFAULTS.scanRoots;

  const rawThresholds = Object.assign({}, DEFAULTS.thresholds, userConfig.thresholds || {});
  const thresholds = {
    warning: clampNum(rawThresholds.warning, 1, 99, DEFAULTS.thresholds.warning),
    critical: clampNum(rawThresholds.critical, 1, 100, DEFAULTS.thresholds.critical),
    quotaDeltaPct: clampNum(rawThresholds.quotaDeltaPct, 0, 100, DEFAULTS.thresholds.quotaDeltaPct)
  };
  if (thresholds.critical <= thresholds.warning) thresholds.critical = Math.min(100, thresholds.warning + 1);

  const rawCadence = Object.assign({}, DEFAULTS.cadenceMs, userConfig.cadenceMs || {});
  const cadenceMs = {};
  for (const k of Object.keys(DEFAULTS.cadenceMs)) {
    // Clamp intervals to [10s, 7d] so a typo (0, negative, absurd) can't
    // tight-loop the daemon or stall it for months.
    cadenceMs[k] = clampNum(rawCadence[k], 10000, 7 * 24 * 3600 * 1000, DEFAULTS.cadenceMs[k]);
  }

  return {
    thresholds,
    cadenceMs,
    delivery,
    scanRoots,
    authJsonPath: userConfig.authJsonPath
      ? path.resolve(expandHome(userConfig.authJsonPath))
      : DEFAULTS.authJsonPath,
    feeds: Object.assign({}, DEFAULTS.feeds, userConfig.feeds || {})
  };
}

module.exports = { DEFAULTS, loadConfig };
