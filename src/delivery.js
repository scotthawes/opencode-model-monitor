'use strict';

const fs = require('fs');
const path = require('path');

// Delivery channels. Configured once at startup with the user's delivery
// options + the state directory. All functions are best-effort and never throw.

// Set of in-flight delivery promises (webhook fetch / desktop notify).
// These are fire-and-forget from the caller's perspective, but we track them
// so flush() can await them all before the process exits — otherwise an
// async alert() whose promise the caller never awaited would be cut short by
// process.exit(), dropping webhook/desktop notifications.
const inFlight = new Set();

function track(p) {
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
  return p;
}

// --- Cross-source model_change dedup ---------------------------------------
//
// price-watch (api.json diff) and atom-watch (Go/Zen docs feeds + releases)
// can both emit a `model_change` alert for the SAME underlying event (e.g.
// "Added model: qwen3.8-flash" and "docs(go): add Qwen3.8 Flash (#45836)").
// We collapse them to a single alert within a TTL window by deriving a stable
// dedup key from the known model id referenced in the alert text.

// Set of known model ids (from the price-watch catalog), populated via
// setKnownModelIds(). Used to recognize which model a given alert is about.
let knownModelIds = new Set();

// In-memory dedup store: key -> timestamp (ms). Persisted to dedup.json.
let dedupStore = new Map();

// Default TTL for suppressing duplicate model_change alerts (24h).
let dedupTtlMs = 86400000;

// Directory the dedup store is persisted to (defaults to STATE_DIR at call time).
let DEDUP_DIR = null;

function setKnownModelIds(set) {
  knownModelIds = set instanceof Set ? set : new Set(Array.isArray(set) ? set : []);
}

// Normalize text for matching: lowercase + strip everything except alnum.
function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Compute a dedup key for a model_change alert. Returns null when the alert
// does not reference a known model id (no dedup in that case).
function computeDedupKey(title, message) {
  if (!knownModelIds.size) return null;
  const text = normalize(`${title || ''} ${message || ''}`);
  if (!text) return null;
  // Prefer the longest known id whose normalized form appears in the text,
  // so e.g. "qwen3.8-flash" wins over a shorter ambiguous prefix.
  let bestId = null;
  let bestNorm = '';
  for (const id of knownModelIds) {
    const n = normalize(id);
    if (!n) continue;
    if (text.includes(n) && n.length > bestNorm.length) {
      bestId = id;
      bestNorm = n;
    }
  }
  return bestId ? 'model:' + bestNorm : null;
}

function dedupPath() {
  return path.join(DEDUP_DIR || STATE_DIR || path.join(__dirname, '..', 'state'), 'dedup.json');
}

function loadDedup() {
  try {
    const raw = fs.readFileSync(dedupPath(), 'utf8');
    const obj = JSON.parse(raw) || {};
    dedupStore = new Map(Object.entries(obj));
  } catch (_) {
    // Missing/corrupt store is fine — start empty.
    dedupStore = new Map();
  }
}

function saveDedup() {
  try {
    fs.writeFileSync(dedupPath(), JSON.stringify(Object.fromEntries(dedupStore), null, 2));
  } catch (_) {
    // best effort
  }
}

// Initialize the persistent dedup store. Called by monitor at the start of
// each cycle (or once before a single run) with the state directory and opts.
function init(stateDir, opts) {
  if (stateDir) DEDUP_DIR = stateDir;
  if (opts && typeof opts.dedupTtlMs === 'number') dedupTtlMs = opts.dedupTtlMs;
  loadDedup();
}

// Wait for all in-flight delivery promises to settle. Safe to call multiple
// times; resolves once nothing is pending.
async function flush() {
  await Promise.allSettled([...inFlight]);
}

let CONFIG = null;
let STATE_DIR = path.join(__dirname, '..', 'state');

function configure(deliveryOptions, stateDir) {
  CONFIG = deliveryOptions || {
    logFile: true,
    reportFile: true,
    stdout: false,
    desktop: false,
    webhook: null
  };
  if (stateDir) STATE_DIR = stateDir;
}

function ensureConfig() {
  if (!CONFIG) {
    CONFIG = {
      logFile: true,
      reportFile: true,
      stdout: false,
      desktop: false,
      webhook: null
    };
  }
}

function ts() {
  return new Date().toISOString();
}

// level: info | model_change | warning | critical
// opts.noChangelog (bool) — when true, the alert is delivered (log file /
// stdout / desktop / webhook) but NOT recorded to the persistent changelog.
// Used by monitor lifecycle heartbeats so the changelog stays focused on real
// changes rather than every 5-minute cycle tick.
async function alert(level, title, message, opts) {
  ensureConfig();

  // Dedup cross-source model_change alerts within the TTL window. Other
  // levels (info/config pins, warning, critical) are delivered as-is.
  if (level === 'model_change') {
    const key = computeDedupKey(title, message);
    if (key) {
      const now = Date.now();
      const prev = dedupStore.get(key);
      if (prev != null && now - prev < dedupTtlMs) {
        return; // suppressed — already alerted for this model within TTL
      }
      dedupStore.set(key, now);
      saveDedup();
    }
  }

  const line = `[${ts()}] ${String(level).toUpperCase()} | ${title} | ${message}`;

  if (CONFIG.stdout) {
    try { console.log(line); } catch (_) {}
  }

  if (CONFIG.logFile) {
    try {
      const logPath = path.join(STATE_DIR, 'alerts.log');
      fs.appendFileSync(logPath, line + '\n');
    } catch (_) {
      // best effort
    }
  }

  // Persistent changelog: append to the text log and maintain a capped JSON
  // array. Only fires for alerts that passed the dedup early-return above, so
  // suppressed/duplicate model_change alerts are NOT recorded. Best-effort.
  // Lifecycle heartbeats pass opts.noChangelog to stay out of the changelog.
  if (!(opts && opts.noChangelog)) {
    try {
      fs.appendFileSync(path.join(STATE_DIR, 'changelog.log'), line + '\n');
    } catch (_) {
      // best effort
    }
    try {
      let arr = [];
      try {
        const raw = fs.readFileSync(path.join(STATE_DIR, 'changelog.json'), 'utf8');
        arr = JSON.parse(raw);
        if (!Array.isArray(arr)) arr = [];
      } catch (_) {
        arr = [];
      }
      arr.push({ ts: ts(), level, title, message });
      if (arr.length > 500) arr = arr.slice(arr.length - 500);
      fs.writeFileSync(path.join(STATE_DIR, 'changelog.json'), JSON.stringify(arr, null, 2));
    } catch (_) {
      // best effort
    }
  }

  if (CONFIG.desktop) {
    // Tracked in inFlight so flush() awaits it. Wrapped in a promise even
    // though node-notifier is synchronous, to keep the tracking uniform.
    track(
      (async () => {
        try {
          // Lazy-required so the default run works without node-notifier installed.
          const notifier = require('node-notifier');
          notifier.notify({
            title: `OpenCode Monitor — ${level}`,
            message: `${title}\n${message}`
          });
        } catch (_) {
          // node-notifier not installed or failed; ignore.
        }
      })()
    );
  }

  if (CONFIG.webhook) {
    track(
      (async () => {
        try {
          await fetch(CONFIG.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level, title, message, ts: ts() })
          });
        } catch (_) {
          // best effort
        }
      })()
    );
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# OpenCode Model Monitor — Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt || 'unknown'}`);
  lines.push('');

  // Pricing
  lines.push('## Pricing (opencode-go)');
  lines.push('');
  const p = report.pricing || {};
  if (p.status === 'unknown') {
    lines.push(`Status: unknown${p.error ? ' — ' + p.error : ''}`);
  } else if (p.status === 'unchanged') {
    lines.push('No pricing changes since last check (304 Not Modified).');
  } else {
    lines.push(`Status: ok — ${p.modelCount != null ? p.modelCount : '?'} models tracked.`);
  }
  if (Array.isArray(p.changes) && p.changes.length) {
    lines.push('');
    lines.push('Changes detected:');
    for (const c of p.changes) lines.push(`- ${c}`);
  }
  if (p.modelCount != null) {
    lines.push('');
    lines.push(`Models tracked: ${p.modelCount}`);
  }
  lines.push('');

  // Usage
  lines.push('## Usage / Quota');
  lines.push('');
  const u = report.usage || {};
  if (u.status === 'unknown') {
    lines.push(`Status: unknown${u.error ? ' — ' + u.error : ''}`);
  } else if (u.usage) {
    for (const win of ['rolling', 'weekly', 'monthly']) {
      const w = u.usage[win];
      if (!w) continue;
      const pct = w.percent != null ? w.percent + '%' : '?';
      const resets = w.resetsAt ? ` (resets ${w.resetsAt})` : '';
      const deltaStr = w.delta != null ? ` (Δ ${w.delta}pts vs prev)` : '';
      lines.push(`- ${win}: ${pct} — ${w.status || '?'}${resets}${deltaStr}`);
    }
  } else {
    lines.push('No usage data.');
  }
  lines.push('');

  // Pins
  lines.push('## Agent Config Pins');
  lines.push('');
  const pins = Array.isArray(report.pins) ? report.pins : [];
  if (!pins.length) {
    lines.push('No `opencode-go/<id>` agent pins found in scanned configs.');
  } else {
    for (const pin of pins) {
      const mult = pin.multiplier != null ? ` (~${pin.multiplier.toFixed(1)}x hy3 output cost)` : '';
      lines.push(`- agent \`${pin.agent}\` in \`${pin.file}\` → opencode-go/${pin.model}${mult}`);
    }
  }
  lines.push('');

  // Feed updates (Atom: Go/Zen pricing docs + releases)
  lines.push('## Feed updates');
  lines.push('');
  const feeds = Array.isArray(report.feedUpdates) ? report.feedUpdates : [];
  if (!feeds.length) {
    lines.push('No feed checks performed.');
  } else {
    for (const f of feeds) {
      const key = f.key || '?';
      const entries = Array.isArray(f.newEntries) ? f.newEntries : [];
      if (!entries.length) {
        lines.push(`- **${key}**: no updates`);
      } else {
        // Most recent entry by its `updated` timestamp.
        let latest = entries[0];
        for (const e of entries) {
          if ((e.updated || '') > (latest.updated || '')) latest = e;
        }
        const when = latest.updated ? ` (${latest.updated})` : '';
        lines.push(`- **${key}**: ${latest.title}${when}`);
      }
    }
  }
  lines.push('');

  // Recent changes (persistent changelog)
  lines.push('## Recent changes');
  lines.push('');
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'changelog.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) {
      const last = arr.slice(-10);
      for (const e of last) {
        lines.push(
          `- [${e.ts}] ${String(e.level || '?').toUpperCase()} | ${e.title || ''} | ${e.message || ''}`
        );
      }
    } else {
      lines.push('No changes recorded yet.');
    }
  } catch (_) {
    lines.push('No changes recorded yet.');
  }
  lines.push('');

  return lines.join('\n');
}

function writeReport(report) {
  ensureConfig();
  if (!CONFIG.reportFile) return;
  try {
    const jsonPath = path.join(STATE_DIR, 'report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    const mdPath = path.join(STATE_DIR, 'report.md');
    fs.writeFileSync(mdPath, renderMarkdown(report));
  } catch (_) {
    // best effort
  }
}

module.exports = {
  configure,
  alert,
  flush,
  writeReport,
  renderMarkdown,
  init,
  setKnownModelIds
};
