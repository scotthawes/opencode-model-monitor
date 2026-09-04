'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

// Default retention window for the persistent changelog (7 days). Entries older
// than this are pruned so the report only shows recent, recallable changes.
let changelogRetentionMs = 7 * 24 * 60 * 60 * 1000;

// Fixed 7-day window used for quota-movement and projection math. Intentionally
// hardcoded (not config) to match changelogRetentionDays' default semantics.
const SEVEN_DAY_MS = 7 * 24 * 3600 * 1000;
// Small grace so a sample sitting right on the 7-day boundary (e.g. captured
// exactly 7 days ago) is still counted as "within 7 days" despite clock drift
// between when `now` is sampled and when the report is generated.
const WINDOW_GRACE_MS = 60000;

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

// Seed the changelog from historical alerts.log on first run, so a fresh
// install starts with recallable history instead of an empty log. Runs at most
// once per state dir (guarded by a .changelog-backfilled marker); skipped if
// the changelog already has entries. Only entries within the retention window
// and at a "real change" level (not lifecycle heartbeats) are carried over.
function backfillFromAlertsLog(base) {
  if (!base) return;
  const marker = path.join(base, '.changelog-backfilled');
  if (fs.existsSync(marker)) return;

  const clPath = path.join(base, 'changelog.json');
  let existing = [];
  try {
    const p = JSON.parse(fs.readFileSync(clPath, 'utf8'));
    if (Array.isArray(p)) existing = p;
  } catch (_) {}
  if (existing.length) {
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch (_) {}
    return;
  }

  const logPath = path.join(base, 'alerts.log');
  let lines = [];
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n');
  } catch (_) {
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch (_) {}
    return;
  }

  const cutoff = Date.now() - changelogRetentionMs;
  const seen = new Set();
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^\[([^\]]+)\]\s+(\w+)\s+\|\s+(.*?)\s+\|\s+(.*)$/);
    if (!m) continue;
    const ts = m[1];
    const level = m[2].toLowerCase();
    const title = m[3];
    const message = m[4];
    if (!['model_change', 'warning', 'critical', 'info'].includes(level)) continue;
    if (level === 'info' && (title.startsWith('Monitor cycle') || title === 'Monitor running (continuous)')) continue;
    const t = Date.parse(ts);
    if (isNaN(t) || t < cutoff) continue;
    const key = ts + '|' + title + '|' + message;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ ts, level, title, message });
  }

  let arr = entries.filter((e) => (e.ts ? Date.parse(e.ts) : 0) >= cutoff);
  if (arr.length > 500) arr = arr.slice(arr.length - 500);
  try {
    if (arr.length) {
      fs.writeFileSync(clPath, JSON.stringify(arr, null, 2));
      const logBlob =
        arr.map((e) => `[${e.ts}] ${e.level.toUpperCase()} | ${e.title} | ${e.message}`).join('\n') + '\n';
      fs.appendFileSync(path.join(base, 'changelog.log'), logBlob);
    }
  } catch (_) {}
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch (_) {}
}

// Initialize the persistent dedup store. Called by monitor at the start of
// each cycle (or once before a single run) with the state directory and opts.
function init(stateDir, opts) {
  if (stateDir) {
    DEDUP_DIR = stateDir;
    STATE_DIR = stateDir;
  }
  if (opts && typeof opts.dedupTtlMs === 'number') dedupTtlMs = opts.dedupTtlMs;
  if (opts && typeof opts.changelogRetentionMs === 'number') changelogRetentionMs = opts.changelogRetentionMs;
  loadDedup();
  loadSubscribers();
  backfillFromAlertsLog(stateDir || STATE_DIR);
}

// --- Persistent subscriber fan-out ----------------------------------------
//
// subscribers.json (repo root) is a best-effort, gitignored list of endpoints
// that should each receive alerts when their `levels` filter includes the alert
// level. Each entry is one of:
//   { name, webhookUrl, levels: ["model_change","warning","critical"] }
//   { name, webhookEnv: "SOME_ENV_VAR", levels: [...] }   // secret via env
// When the file is absent or invalid, SUBSCRIBERS stays empty and the monitor
// behaves exactly as before (no fan-out). The single CONFIG.webhook path is
// unaffected, so the legacy MODEL_MONITOR_WEBHOOK flow still works.

// Default per-subscriber POST timeout (10s) so a hung endpoint can't stall
// the tracked delivery promise indefinitely.
const SUBSCRIBER_TIMEOUT_MS = 10000;

// Discord's incoming-webhook API uses { content: "..." } (max 2000 chars), not
// the Slack-shaped { text: "..." }. Slack/custom endpoints keep { text }.
const DISCORD_WEBHOOK_RE = /discord\.com\/api\/webhooks/i;
const DISCORD_CONTENT_MAX = 2000;
const DISCORD_USERNAME = 'model-monitor';

// Append `key=value` to a URL, choosing ? or & based on existing query string.
function appendQuery(url, key, value) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + key + '=' + encodeURIComponent(value);
}

// Build the per-subscriber delivery payload + final URL.
// - Discord (url matches discord.com/api/webhooks): send { content: "[LEVEL]
//   title — message" } truncated to 2000 chars + a username; Slack/custom keep
//   { text: "..." } so existing subscribers are unaffected.
// - Discord FORUM channels need ?thread_name= (new post) or ?thread_id= (reply)
//   on the webhook URL. The URL is used verbatim, so any query string the user
//   already included is preserved untouched. Subscriber fields `threadName` /
//   `threadId` optionally append the matching param when not already present.
// Returns { url, payload }. `url` is always a string (a valid http(s) URL or
// the raw value the caller passed); this function never throws.
function buildSubscriberDelivery(sub, url, level, title, message) {
  const text = `[${String(level).toUpperCase()}] ${title} — ${message}`;
  const isDiscord = DISCORD_WEBHOOK_RE.test(url || '');
  let payload;
  if (isDiscord) {
    payload = {
      content: text.length > DISCORD_CONTENT_MAX ? text.slice(0, DISCORD_CONTENT_MAX) : text,
      username: DISCORD_USERNAME
    };
  } else {
    payload = { text };
  }
  if (isDiscord && sub) {
    const hasThreadName = /[?&]thread_name=/i.test(url);
    const hasThreadId = /[?&]thread_id=/i.test(url);
    if (!hasThreadName && !hasThreadId) {
      if (sub.threadId) url = appendQuery(url, 'thread_id', sub.threadId);
      else if (sub.threadName) url = appendQuery(url, 'thread_name', sub.threadName);
    }
  }
  return { url, payload };
}

let SUBSCRIBERS = [];

function subscribersPath() {
  // Mirror config.json placement: repo root (parent of src/).
  return path.join(__dirname, '..', 'subscribers.json');
}

// Best-effort load of subscribers.json. Never throws; on any failure the
// subscriber list is left empty so the monitor continues normally.
function loadSubscribers() {
  const p = subscribersPath();
  try {
    if (!fs.existsSync(p)) {
      SUBSCRIBERS = [];
      return;
    }
    const raw = fs.readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    SUBSCRIBERS = Array.isArray(arr) ? arr : [];
  } catch (e) {
    SUBSCRIBERS = [];
    try {
      fs.appendFileSync(
        path.join(STATE_DIR, 'alerts.log'),
        `[${ts()}] WARNING | Subscriber config invalid — fan-out disabled | ${e && e.message ? e.message : e}\n`
      );
    } catch (_) {}
  }
}

// Deliver a single payload to one subscriber endpoint. Best-effort: any failure
// is logged to alerts.log as a WARNING; this function never rejects.
async function deliverToSubscriber(sub, url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBSCRIBER_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (e) {
    try {
      const name = (sub && sub.name) || 'unknown';
      fs.appendFileSync(
        path.join(STATE_DIR, 'alerts.log'),
        `[${ts()}] WARNING | Subscriber delivery failed (${name}) | ${e && e.message ? e.message : e}\n`
      );
    } catch (_) {}
  } finally {
    clearTimeout(timer);
  }
}

// Wait for all in-flight delivery promises to settle. Safe to call multiple
// times; resolves once nothing is pending.
async function flush() {
  await Promise.allSettled([...inFlight]);
}

// --- Desktop notification helpers -----------------------------------------
//
// Best-effort, never throw. We must NEVER let a desktop backend hang or be
// silently swallowed: any failure is logged to alerts.log as a WARNING so the
// gap is visible, and a 3s timeout guard bounds node-notifier on platforms
// where its bundled binary can dangle (e.g. terminal-notifier on macOS 26).

// Escape a string for embedding inside an AppleScript double-quoted literal:
// backslash first, then double-quote, and truncate to keep the payload sane.
function escapeAppleScript(str) {
  return String(str)
    .slice(0, 500)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

// Native macOS notifications via osascript (no bundled binary). Resolves with
// null on success or an Error on failure — never rejects.
function notifyViaOsascript(notifyTitle, notifyMessage, subtitle) {
  return new Promise((resolve) => {
    const script =
      `display notification "${escapeAppleScript(notifyMessage)}` +
      `" with title "${escapeAppleScript(notifyTitle)}` +
      `" subtitle "${escapeAppleScript(subtitle)}"`;
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => {
      resolve(err || null);
    });
  });
}

// node-notifier path with callback + 3s timeout race. The earlier silent
// implementation called notify() without a callback, so a backend that never
// invokes the callback (terminal-notifier hang) left the promise unsettled
// forever. We now always race against a timeout and report the outcome.
function notifyViaNotifier(notifyTitle, notifyMessage) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err || null);
    };
    const timer = setTimeout(() => finish(new Error('timeout after 3000ms')), 3000);
    let notifier;
    try {
      notifier = require('node-notifier');
    } catch (e) {
      return finish(e);
    }
    try {
      notifier.notify({ title: notifyTitle, message: notifyMessage }, (err) => {
        finish(err || null);
      });
    } catch (e) {
      finish(e);
    }
  });
}

// Best-effort WARNING line to alerts.log so desktop delivery gaps are visible.
function logDesktopWarning(detail) {
  try {
    fs.appendFileSync(
      path.join(STATE_DIR, 'alerts.log'),
      `[${ts()}] WARNING | Desktop delivery failed (${detail})\n`
    );
  } catch (_) {
    // best effort
  }
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
  // Best-effort: a missing/invalid subscribers.json simply means no fan-out.
  loadSubscribers();
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
      const cutoff = Date.now() - changelogRetentionMs;
      arr = arr.filter((e) => (e.ts ? Date.parse(e.ts) : 0) >= cutoff);
      if (arr.length > 500) arr = arr.slice(arr.length - 500);
      fs.writeFileSync(path.join(STATE_DIR, 'changelog.json'), JSON.stringify(arr, null, 2));
    } catch (_) {
      // best effort
    }
  }

  if (CONFIG.desktop) {
    // Tracked in inFlight so flush() awaits it. Best-effort, never throws.
    track(
      (async () => {
        const notifyTitle = `OpenCode Monitor — ${level}`;
        const notifyMessage = `${title}\n${message}`;
        if (process.platform === 'darwin') {
          // Prefer native osascript on macOS: no bundled/unsigned binary, and
          // avoids the terminal-notifier 1.7.2 hang on macOS 26 (callback never
          // fires, child dangles — used to be silently swallowed). Fall back to
          // node-notifier only if osascript fails.
          const osaErr = await notifyViaOsascript(notifyTitle, notifyMessage, title);
          if (osaErr) {
            logDesktopWarning(`osascript failed: ${osaErr.message || osaErr}`);
            const nnErr = await notifyViaNotifier(notifyTitle, notifyMessage);
            if (nnErr) {
              logDesktopWarning(`node-notifier fallback failed: ${nnErr.message || nnErr}`);
            }
          }
        } else {
          // Linux/other: node-notifier with a callback + timeout guard so a
          // hung backend can never block delivery (or the process) silently.
          const nnErr = await notifyViaNotifier(notifyTitle, notifyMessage);
          if (nnErr) {
            logDesktopWarning(`node-notifier failed: ${nnErr.message || nnErr}`);
          }
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

  // Persistent subscriber fan-out. For every subscriber whose `levels` filter
  // includes this alert's level, POST an alert to its webhook URL (resolved
  // directly, or via a webhookEnv env var so the secret never lives in
  // subscribers.json). Discord webhooks receive { content: "..." } (truncated to
  // 2000 chars); Slack/custom endpoints receive the original { text: "..." }.
  // Forum-channel thread params (?thread_name=/?thread_id=) pass through
  // verbatim. Fully best-effort: timeouts and other failures are logged as
  // WARNING and never thrown, and a malformed entry is skipped so one bad
  // subscriber can't break alert delivery.
  for (const sub of SUBSCRIBERS) {
    try {
      if (!sub || !Array.isArray(sub.levels) || !sub.levels.includes(level)) continue;
      let url = sub.webhookUrl;
      if (!url && sub.webhookEnv) url = process.env[sub.webhookEnv];
      if (!url) continue; // nothing resolvable to deliver to
      const { url: finalUrl, payload } = buildSubscriberDelivery(sub, url, level, title, message);
      track(deliverToSubscriber(sub, finalUrl, payload));
    } catch (_) {
      // A structurally broken entry must not crash the alert path.
    }
  }
}

// Best-effort read of the usage time-series from STATE_DIR. Returns the array of
// samples (or [] if missing/corrupt). Never throws.
function readUsageHistory() {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'usage-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

// Compute 7-day quota movement for a single window from the time-series.
// Picks the oldest sample still inside the 7-day window (falling back to the
// oldest sample overall when none is within the window / has a value). Returns
// { current, oldest, delta, oldestTs, daysElapsed } or null when the window has
// no usable current value.
function windowInfo(history, win, now) {
  now = now || Date.now();
  if (!history.length) return null;
  const latest = history[history.length - 1];
  const current = typeof latest[win] === 'number' ? latest[win] : null;
  if (current == null) return null;

  // Oldest sample within the 7-day window that has a numeric value for this win.
  let oldestInWindow = null;
  for (const s of history) {
    if (now - s.ts <= SEVEN_DAY_MS + WINDOW_GRACE_MS && typeof s[win] === 'number') {
      if (oldestInWindow == null || s.ts < oldestInWindow.ts) oldestInWindow = s;
    }
  }

  let oldestSample = null;
  let oldestTs = null;
  if (oldestInWindow) {
    oldestSample = oldestInWindow[win];
    oldestTs = oldestInWindow.ts;
  } else {
    // None in window (or none with a value) — use the oldest sample overall.
    for (const s of history) {
      if (typeof s[win] === 'number') {
        if (oldestSample == null || s.ts < oldestTs) {
          oldestSample = s[win];
          oldestTs = s.ts;
        }
      }
    }
  }
  if (oldestSample == null || oldestTs == null) return null;

  const daysElapsed = (now - oldestTs) / 864e5;
  return { current, oldest: oldestSample, delta: current - oldestSample, oldestTs, daysElapsed };
}

function renderMarkdown(report) {
  const lines = [];
  const now = Date.now();
  const history = readUsageHistory();
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
  // Resolve the per-window quota object robustly: the real report nests it under
  // `usage.usage`, while a direct mock may pass the windows flat under `usage`.
  const usageWin = u.usage ? u.usage : u;
  if (u.status === 'unknown') {
    lines.push(`Status: unknown${u.error ? ' — ' + u.error : ''}`);
  } else if (usageWin && (usageWin.rolling || usageWin.weekly || usageWin.monthly)) {
    for (const win of ['rolling', 'weekly', 'monthly']) {
      const w = usageWin[win];
      if (!w) continue;
      const pct = w.percent != null ? w.percent + '%' : '?';
      const resets = w.resetsAt ? ` (resets ${w.resetsAt})` : '';
      const wi = windowInfo(history, win, now);
      let deltaStr = '';
      if (wi && wi.delta != null) {
        const sign = wi.delta > 0 ? '+' : '';
        deltaStr = ` (Δ ${sign}${wi.delta}pts / 7d)`;
      } else if (w.delta != null) {
        deltaStr = ` (Δ ${w.delta}pts vs prev)`;
      }
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

  // Changes — last 7 days (quota movement + discrete events)
  lines.push('## Changes — last 7 days');
  lines.push('');
  lines.push('**Quota movement (7d)**:');
  lines.push('');
  for (const win of ['rolling', 'weekly', 'monthly']) {
    const wi = windowInfo(history, win, now);
    if (wi && wi.current != null && wi.delta != null) {
      const sign = wi.delta > 0 ? '+' : '';
      lines.push(`- Quota ${win}: ${wi.current}% (Δ ${sign}${wi.delta}pts / 7d)`);
    } else {
      lines.push(`- Quota ${win}: n/a`);
    }
  }
  lines.push('');
  lines.push('**Events**:');
  lines.push('');
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'changelog.json'), 'utf8');
    const arr = JSON.parse(raw);
    const cutoff = now - changelogRetentionMs;
    const within = Array.isArray(arr)
      ? arr.filter((e) => (e.ts ? Date.parse(e.ts) : 0) >= cutoff)
      : [];
    if (within.length) {
      // Show most-recent first (stored oldest→newest, so reverse the last N).
      const recent = within.slice(-20).reverse();
      for (const e of recent) {
        lines.push(
          `- [${e.ts}] ${String(e.level || '?').toUpperCase()} | ${e.title || ''} | ${e.message || ''}`
        );
      }
    } else {
      lines.push('- No discrete changes recorded.');
    }
  } catch (_) {
    lines.push('- No discrete changes recorded.');
  }
  lines.push('');

  // Upcoming (resets + projected threshold crossings)
  lines.push('## Upcoming');
  lines.push('');
  lines.push('**Quota resets**:');
  lines.push('');
  const upcomingUsage = report.usage && report.usage.usage ? report.usage.usage : report.usage || {};
  let anyReset = false;
  for (const win of ['rolling', 'weekly', 'monthly']) {
    const w = upcomingUsage[win];
    if (w && w.resetsAt) {
      lines.push(`- ${win} resets: ${w.resetsAt}`);
      anyReset = true;
    }
  }
  if (!anyReset) lines.push('- No upcoming resets.');
  lines.push('');
  lines.push('**Projected threshold crossings**:');
  lines.push('');
  for (const win of ['rolling', 'weekly', 'monthly']) {
    const wi = windowInfo(history, win, now);
    if (!history.length || !wi) {
      lines.push(`- ${win} projection: n/a`);
      continue;
    }
    const { current, delta, daysElapsed } = wi;
    const rate = daysElapsed > 0 ? delta / daysElapsed : 0;
    if (rate <= 0) {
      lines.push(`- ${win} projection: stable (no increase detected)`);
    } else if (current >= 80) {
      lines.push(`- ${win}: already at/above warn threshold`);
    } else {
      const daysToWarn = (80 - current) / rate;
      const daysToCrit = (95 - current) / rate;
      const warnDate = new Date(now + daysToWarn * 864e5).toISOString().slice(0, 10);
      const critDate = new Date(now + daysToCrit * 864e5).toISOString().slice(0, 10);
      lines.push(
        `- ${win} projection: ~80% warn on ${warnDate}, ~95% crit on ${critDate}`
      );
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

module.exports = {
  configure,
  alert,
  flush,
  writeReport,
  renderMarkdown,
  init,
  setKnownModelIds,
  loadSubscribers,
  deliverToSubscriber,
  buildSubscriberDelivery
};
