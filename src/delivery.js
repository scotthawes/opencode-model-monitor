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
async function alert(level, title, message) {
  ensureConfig();
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
      lines.push(`- ${win}: ${pct} — ${w.status || '?'}${resets}`);
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

module.exports = { configure, alert, flush, writeReport, renderMarkdown };
