'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const usageTable = require('./usage-table');
const events = require('./events'); // v0.8.0: event-sourced history (JSONL, #73)
const changeMetric = require('./change-metric'); // shared Δ% / × / $ formatting

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

// Max entries kept in the persisted changelog JSON (oldest dropped first).
const CHANGELOG_MAX_ENTRIES = 500;

// --- Per-cycle changelog batching (v0.16.0, #103) ---------------------------
//
// alert() used to do a full read-modify-write of changelog.json per alert, so
// a 5-model-change cycle paid 5 synchronous rewrites. In batch mode the JSON
// entries are collected in memory and persisted with a SINGLE read-modify-write
// at the end of the cycle (endChangelogBatch, called before writeReport so the
// report still sees this cycle's entries). The append-only changelog.log line
// stays immediate (cheap append, no read). Cap semantics are unchanged: the
// same 7-day prune + 500-entry cap apply to the merged array, and entry order
// + per-alert timestamps are preserved (captured at alert time).
// Outside a batch (one-shot scripts, continuous intervals) alert() writes
// through immediately, exactly as before.
let changelogBatch = null; // null = immediate mode; array = collecting

function beginChangelogBatch() {
  changelogBatch = [];
}

// Single read-modify-write of changelog.json appending `entries` (in order).
// No-op when entries is empty (an unchanged cycle performs zero rewrites).
// Best-effort, never throws.
function writeChangelogEntries(entries) {
  if (!entries || !entries.length) return;
  try {
    let arr = [];
    try {
      const raw = fs.readFileSync(path.join(STATE_DIR, 'changelog.json'), 'utf8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch (_) {
      arr = [];
    }
    for (const e of entries) arr.push(e);
    const cutoff = Date.now() - changelogRetentionMs;
    arr = arr.filter((e) => (e.ts ? Date.parse(e.ts) : 0) >= cutoff);
    if (arr.length > CHANGELOG_MAX_ENTRIES) arr = arr.slice(arr.length - CHANGELOG_MAX_ENTRIES);
    fs.writeFileSync(path.join(STATE_DIR, 'changelog.json'), JSON.stringify(arr, null, 2));
    invalidateCycleCache();
  } catch (_) {
    // best effort
  }
}

function appendChangelog(entry) {
  if (changelogBatch) {
    changelogBatch.push(entry);
    return;
  }
  writeChangelogEntries([entry]);
}

// Flush a pending batch with a single rewrite. Returns the number of entries
// persisted. Safe to call with no active batch (no-op). Never throws.
function endChangelogBatch() {
  const pending = changelogBatch || [];
  changelogBatch = null;
  writeChangelogEntries(pending);
  return pending.length;
}

// Fixed 7-day window used for quota-movement and projection math. Intentionally
// hardcoded (not config) to match changelogRetentionDays' default semantics.
// v0.16.0 (#103): single window constant lives in change-metric.js; this alias
// keeps existing references working.
const SEVEN_DAY_MS = changeMetric.QUOTA_WINDOW_MS;
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
// does not reference a recognizable model id (no dedup in that case).
//
// Fix (b): a brand-new model may not yet be in knownModelIds when its first
// alert fires (e.g. a Go/Zen docs feed "Added model: X" arriving before
// price-watch refreshes the catalog, or a commit title referencing the id by a
// slightly different spelling). We therefore ALSO derive the key from model ids
// parsed directly out of the message text, so the SAME underlying event emitted
// by two different sources (api diff vs feed) collapses within the TTL.
function computeDedupKey(title, message) {
  const text = normalize(`${title || ''} ${message || ''}`);
  if (!text) return null;
  // Prefer the longest known id whose normalized form appears in the text,
  // so e.g. "qwen3.8-flash" wins over a shorter ambiguous prefix.
  let bestId = null;
  let bestNorm = '';
  if (knownModelIds.size) {
    for (const id of knownModelIds) {
      const n = normalize(id);
      if (!n) continue;
      if (text.includes(n) && n.length > bestNorm.length) {
        bestId = id;
        bestNorm = n;
      }
    }
  }
  if (bestId) return 'model:' + bestNorm;

  // Fallback: parse candidate model ids straight from the message text.
  // 1) Explicit structured references we ourselves emit (covers both the api
  //    diff and the feed phrasing): "Added model: X", "Removed model: X",
  //    "Cost changed for X: ...", "Tiers changed for X", "Free model ...: X".
  //    The model id may sit between the phrase and the trailing colon
  //    (e.g. "Cost changed for beta: ..."), so the colon is optional and the id
  //    is captured as the first token after the phrase. This lets pure-letter ids
  //    ("beta", "gpt") collapse to a real key instead of falling through to the
  //    generic scan (BUG #85: letter-id dedup). The capture class already admits
  //    pure letters, so no further change is needed there.
  const explicit = String(message || '').match(
    /(?:added model|removed model|cost changed for|tiers changed for|free model (?:available|changed|removed))\s*:?\s*([a-z0-9][a-z0-9\-\.]*)/i
  );
  if (explicit) return 'model:' + normalize(explicit[1]);
  // (regex above is intentionally case-INSENSITIVE — the `i` flag from the original
  // is required so capitalized phrasing "Added model"/"Removed model" parses.)
  // Case-INSENSITIVE: the `i` flag (carried over from the original) so capitalized
  // phrasing ("Added model", "Removed model") still parses. The capture class already
  // admits pure letters, so "beta"/"gpt" collapse to a real key here instead of
  // falling through to the generic scan (BUG #85: letter-id dedup).
  if (explicit) return 'model:' + normalize(explicit[1]);
  // 2) Generic token scan using the requested model-id shape
  //    /([a-z0-9][a-z0-9\-\.]*)/i. A model id token carries at least one letter
  //    AND a digit/hyphen (e.g. "hy3", "qwen3.8-flash", "claude-4"), which
  //    excludes pure words ("model") and bare numbers ("0175", "45836") that
  //    would otherwise be mistaken for an id. Longest match wins. We scan a
  //    space-preserving lowercase copy (NOT the aggressively-normalized `text`,
  //    which strips spaces and would collapse the whole message into one token).
  const textLc = (String(title || '') + ' ' + String(message || '')).toLowerCase();
  const tokens = textLc.match(/[a-z0-9][a-z0-9\-\.]*/g) || [];
  // Prefer an id that carries a letter AND a digit/hyphen (e.g. "hy3",
  // "qwen3.8-flash", "claude-4"). Only if no such token exists do we fall back to
  // a pure-letter token of length >= 3 (e.g. "beta", "gpt"), which legitimately name
  // models but carry no digit/hyphen. This relaxes the old rule that required a
  // digit/hyphen unconditionally and left pure-letter ids returning null, so they
  // never deduplicated (BUG #85: letter-id dedup). Two-pass selection keeps real ids
  // from being shadowed by common words ("model", "changed") when a digit-bearing id
  // is present; the explicit-message regex above (step 1) is always preferred for our
  // own structured phrasing.
  let bestTok = '';
  let bestLetterOnly = '';
  for (const t of tokens) {
    if (/[a-z]/.test(t) && /[\d\-]/.test(t)) {
      if (t.length > bestTok.length) bestTok = t;
    } else if (/^[a-z]+$/.test(t) && t.length >= 3) {
      if (t.length > bestLetterOnly.length) bestLetterOnly = t;
    }
  }
  const chosen = bestTok || bestLetterOnly;
  return chosen ? 'model:' + normalize(chosen) : null;
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
  // A leftover batch from a previous cycle (e.g. a crashed run that never
  // flushed) is persisted first so no collected entry is silently dropped.
  try {
    endChangelogBatch();
  } catch (_) {}
  clearCycleCache();
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

// --- Discord embed shaping -------------------------------------------------
//
// For model_change / warning / critical / digest we send a Discord EMBED (rich
// card) instead of a bare code block where beneficial — it reads better in
// chat and groups related metrics into `fields`. Discord requires a non-empty
// `content` string on every webhook message, so we ALSO keep a short fallback
// text (the legacy "[LEVEL] title — message" line) so the post is always valid
// even on embed-incapable clients. Slack/custom endpoints keep { text }.
//
// Hard limits enforced: content <= 1900 chars, each embed description <= 4096,
// at most 5 fields, and the whole JSON envelope <= 6000 chars. Never throws.
const EMBED_COLORS = {
  model_change: 0x2ecc71, // green
  warning: 0xf1c40f, // amber
  critical: 0xe74c3c, // red
  digest: 0x3498db, // blue
  info: 0x95a5a6 // grey fallback
};
const EMBED_LEVELS = { model_change: true, warning: true, critical: true, digest: true };

// Build a Discord webhook payload with an embed. `fallback` is the required
// non-empty content string; `opts` may carry { title, description, color,
// fields }. Returns { content, username, embeds } sized within Discord limits.
function buildDiscordPayload(level, fallback, opts) {
  opts = opts || {};
  const color =
    typeof opts.color === 'number'
      ? opts.color
      : EMBED_COLORS[level] != null
        ? EMBED_COLORS[level]
        : EMBED_COLORS.info;
  const fb = String(fallback == null ? '' : fallback);
  const description = String(opts.description != null ? opts.description : fb);
  const fields = Array.isArray(opts.fields)
    ? opts.fields
        .slice(0, 5)
        .map((f) => ({
          name: String(f && f.name != null ? f.name : '').slice(0, 256),
          value: String(f && f.value != null ? f.value : '').slice(0, 1024),
          inline: !!(f && f.inline)
        }))
    : [];
  const embeds = [
    {
      title: String(opts.title != null ? opts.title : String(level).toUpperCase()).slice(0, 256),
      description: description.slice(0, 4096),
      color,
      fields,
      timestamp: new Date().toISOString()
    }
  ];
  // Ensure a non-empty content fallback (Discord requires it).
  let content = fb.length ? fb : String(level).toUpperCase();
  content = content.length > DISCORD_CONTENT_MAX ? content.slice(0, DISCORD_CONTENT_MAX) : content;
  // Keep the whole envelope <= 6000 chars by trimming the description last.
  while (JSON.stringify(embeds).length + content.length > 6000 && embeds[0].description.length > 0) {
    embeds[0].description = embeds[0].description.slice(0, embeds[0].description.length - 100);
  }
  return { content, username: DISCORD_USERNAME, embeds };
}

// Build the per-subscriber delivery payload + final URL.
// - Discord (url matches discord.com/api/webhooks): for embed-eligible levels
//   (model_change / warning / critical / digest) send a rich embed with a
//   non-empty content fallback; other levels send { content: "[LEVEL] title —
//   message" } truncated to 2000 chars + a username. Slack/custom keep
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
  if (isDiscord && EMBED_LEVELS[level]) {
    // Rich embed with a non-empty content fallback (Discord requires content).
    payload = buildDiscordPayload(level, text, { title: title, description: message || title });
  } else if (isDiscord) {
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

// Deliver a raw, pre-formatted message body to one subscriber, choosing the
// Discord { content } vs Slack/custom { text } shape based on the URL (mirrors
// buildSubscriberDelivery). When `level` is 'digest' and the endpoint is
// Discord, the chunk is sent as a rich embed (with the text as a non-empty
// content fallback) instead of a bare code block. Used by the periodic digest,
// which posts full report chunks rather than single alerts.
async function deliverRawContent(sub, content, level) {
  let url = sub.webhookUrl;
  if (!url && sub.webhookEnv) url = process.env[sub.webhookEnv];
  if (!url) return;
  const isDiscord = DISCORD_WEBHOOK_RE.test(url || '');
  let payload;
  if (isDiscord && level && EMBED_LEVELS[level]) {
    // Rich embed: the FULL content goes in the embed description, while the
    // required (Discord-mandatory) non-empty `content` fallback is kept SHORT
    // — just the first line — so the same text is not duplicated in both
    // fields. We fall back to "See embed" when the body is blank.
    const titleFor = level === 'digest' ? 'Digest' : level === 'model_change' ? 'Model change' : String(level);
    const firstLine = String(content).split('\n')[0].trim();
    const shortFallback = firstLine.length ? firstLine : 'See embed';
    payload = buildDiscordPayload(level, shortFallback, { title: titleFor, description: content });
  } else if (isDiscord) {
    payload = {
      content: content.length > DISCORD_CONTENT_MAX ? content.slice(0, DISCORD_CONTENT_MAX) : content,
      username: DISCORD_USERNAME
    };
  } else {
    payload = { text: content };
  }
  if (isDiscord && sub) {
    const hasThreadName = /[?&]thread_name=/i.test(url);
    const hasThreadId = /[?&]thread_id=/i.test(url);
    if (!hasThreadName && !hasThreadId) {
      if (sub.threadId) url = appendQuery(url, 'thread_id', sub.threadId);
      else if (sub.threadName) url = appendQuery(url, 'thread_name', sub.threadName);
    }
  }
  await deliverToSubscriber(sub, url, payload);
}

// Whether a subscriber should receive a message of `level`. The periodic digest
// (`level === 'digest'`) is also delivered to subscribers that opted into
// `info`, so a single opt-in covers both human-readable summaries and the
// (separate) lifecycle `info` heartbeats. Everything else matches exactly.
function subscriberWants(sub, level) {
  if (!sub || !Array.isArray(sub.levels)) return false;
  if (sub.levels.includes(level)) return true;
  if (level === 'digest' && sub.levels.includes('info')) return true;
  return false;
}

// Fan a raw, pre-formatted message out to every subscriber whose filter wants
// `level`. Tracked in inFlight so flush() awaits delivery before exit.
// `subscribersOverride` lets callers (tests) supply their own list instead of
// the module-level SUBSCRIBERS loaded from subscribers.json.
async function sendToSubscribers(level, content, subscribersOverride) {
  const list = Array.isArray(subscribersOverride) ? subscribersOverride : SUBSCRIBERS;
  for (const sub of list) {
    try {
      if (!subscriberWants(sub, level)) continue;
      track(deliverRawContent(sub, content, level));
    } catch (_) {
      // A structurally broken entry must not stop the fan-out.
    }
  }
}

// Test/override hook for the subscriber list (otherwise loaded from
// subscribers.json). Kept small and explicit; production never calls this.
function setSubscribers(arr) {
  SUBSCRIBERS = Array.isArray(arr) ? arr : [];
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

// POST a JSON payload to a single webhook URL with a 10s AbortController timeout
// (matching the subscriber path at SUBSCRIBER_TIMEOUT_MS) so a hung endpoint can
// never stall delivery. Best-effort: any failure is logged to alerts.log as a
// WARNING and never thrown. Reused by the legacy CONFIG.webhook alert path and
// the digest fan-out to the same endpoint.
async function postToWebhook(url, payload) {
  if (!url) return;
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
      fs.appendFileSync(
        path.join(STATE_DIR, 'alerts.log'),
        `[${ts()}] WARNING | Webhook delivery failed | ${e && e.message ? e.message : e}\n`
      );
    } catch (_) {}
  } finally {
    clearTimeout(timer);
  }
}
// Wait for all in-flight delivery promises to settle. Safe to call multiple
// times; resolves once nothing is pending.
async function flush() {
  // Persist any batched changelog entries first so a shutdown never drops them.
  try {
    endChangelogBatch();
  } catch (_) {}
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
// null on success or an Error on failure — never rejects. `soundName` (optional)
// plays an alert sound so popups are audible even when the banner auto-dismisses
// (the user can make them sticky via System Settings — see README).
function notifyViaOsascript(notifyTitle, notifyMessage, subtitle, soundName) {
  return new Promise((resolve) => {
    let script =
      `display notification "${escapeAppleScript(notifyMessage)}` +
      `" with title "${escapeAppleScript(notifyTitle)}` +
      `" subtitle "${escapeAppleScript(subtitle)}"`;
    if (soundName) {
      // Sound names are a fixed macOS vocabulary (constants we control, not
      // user input) but escape defensively anyway.
      script += ` sound name "${escapeAppleScript(soundName)}"`;
    }
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => {
      resolve(err || null);
    });
  });
}

// Guaranteed audible fallback using afplay (macOS only). We cannot trust
// osascript's `sound name "Ping"`: it exits 0 even for bogus names and when
// banners are suppressed (Focus / Do Not Disturb / previews locked). So a
// warning/critical notification can be completely silent while osascript
// reports success. afplay plays the AIFF directly through the audio device;
// it was verified audible by the user. Best-effort: 5s timeout, any error is
// logged at most as a WARNING, and this promise never rejects/throws.
function notifyViaAfplay(soundName) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !soundName) return resolve(null);
    const file = `/System/Library/Sounds/${soundName}.aiff`;
    execFile('afplay', [file], { timeout: 5000 }, (err) => {
      if (err) {
        logDesktopWarning(`afplay failed: ${err.message || err}`);
      }
      resolve(null);
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

// Best-effort DEBUG line (rate-limited to at most one per hour) so desktop
// delivery gaps are still visible without flooding the log under launchd, where
// a misconfigured/headless environment can emit a failure on every cycle.
let lastDesktopWarnTs = 0;
function logDesktopWarning(detail) {
  const now = Date.now();
  if (now - lastDesktopWarnTs < 3600000) return; // at most one DEBUG per hour
  lastDesktopWarnTs = now;
  debug(`Desktop delivery failed (${detail})`);
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

// Allow callers (e.g. the Discord digest builder) to point delivery's
// module-level STATE_DIR at a specific state dir so windowing/projection math
// (which reads usage-history.json from STATE_DIR) uses the right location.
function setStateDir(dir) {
  if (dir) STATE_DIR = dir;
  return STATE_DIR;
}

function getStateDir() {
  return STATE_DIR;
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

// --- Debug-only logging ----------------------------------------------------
//
// Low-signal lifecycle/heartbeat lines (monitor cycle ticks, repeated
// same-status quota blips) go here instead of alerts.log so the operational log
// stays focused on actionable signal. Best-effort, never throws, non-blocking.
function debug(message) {
  try {
    const line = `[${ts()}] DEBUG | ${message}`;
    fs.appendFileSync(path.join(STATE_DIR, 'debug.log'), line + '\n');
  } catch (_) {
    // best effort
  }
}

// Humanize a reset timestamp into a scannable relative phrase:
//   "in 3d 4h"  (>= 2 days out)
//   "tomorrow"   (the next UTC calendar day)
//   "today"      (later the same UTC calendar day)
//   "overdue"    (already in the past)
//   "?"          (unparseable input)
// Used by report.md + the Discord digest TL;DR so users see "next reset in Xd Yh"
// instead of a raw ISO string. Never throws.
function humanizeReset(iso, now) {
  const t = Date.parse(iso);
  if (isNaN(t)) return '?';
  const nowMs = now != null ? now : Date.now();
  const diff = t - nowMs;
  if (diff < 0) return 'overdue';
  const DAY = 864e5;
  const dNow = new Date(nowMs).toISOString().slice(0, 10);
  const dTs = new Date(t).toISOString().slice(0, 10);
  if (dNow === dTs) return 'today';
  const dTomorrow = new Date(nowMs + DAY).toISOString().slice(0, 10);
  if (dTs === dTomorrow) return 'tomorrow';
  const days = Math.floor(diff / DAY);
  const hours = Math.floor((diff - days * DAY) / 3600000);
  return `in ${days}d ${hours}h`;
}

// level: info | model_change | warning | critical
// opts.noChangelog (bool) — when true, the alert is delivered (log file /
// stdout / desktop / webhook) but NOT recorded to the persistent changelog.
// Used by monitor lifecycle heartbeats so the changelog stays focused on real
// changes rather than every 5-minute cycle tick.
async function alert(level, title, message, opts) {
  ensureConfig();

  // DEBUG-only mode: low-signal lines (monitor heartbeats, repeated same-status
  // quota blips) go to the debug log and NOTHING else — no alerts.log, no
  // changelog, no subscribers, no webhook, no desktop. Never throws.
  if (opts && opts.debugOnly) {
    debug(`${String(level).toUpperCase()} | ${title} | ${message}`);
    return { delivered: true, debugOnly: true };
  }

  // Dedup cross-source model_change alerts within the TTL window. Other
  // levels (info/config pins, warning, critical) are delivered as-is unless the
  // caller opts a specific alert into dedup via opts.dedupKey (used by the
  // recurring "Usage data missing" degradation warning so it fires at most once
  // per TTL instead of every cycle).
  if (level === 'model_change') {
    const key = computeDedupKey(title, message);
    if (key) {
      const now = Date.now();
      const prev = dedupStore.get(key);
      if (prev != null && now - prev < (opts && typeof opts.dedupTtlMs === 'number' ? opts.dedupTtlMs : dedupTtlMs)) {
        return { delivered: false }; // suppressed — already alerted for this model within TTL
      }
      dedupStore.set(key, now);
      saveDedup();
    }
  } else if (opts && opts.dedupKey) {
    const key = 'reserved:' + opts.dedupKey;
    const now = Date.now();
    const prev = dedupStore.get(key);
    if (prev != null && now - prev < dedupTtlMs) {
      return { delivered: false }; // suppressed — same degradation already alerted within TTL
    }
    dedupStore.set(key, now);
    saveDedup();
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
  // v0.16.0 (#103): the JSON array is batched per-cycle (single rewrite) while
  // the log line stays an immediate append.
  if (!(opts && opts.noChangelog)) {
    try {
      fs.appendFileSync(path.join(STATE_DIR, 'changelog.log'), line + '\n');
    } catch (_) {
      // best effort
    }
    appendChangelog({ ts: ts(), level, title, message });
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
          //
          // Prominence: play a sound (louder per severity) so banners that
          // auto-dismiss are still audible, and for the important levels put the
          // level + timestamp in the subtitle so they stand out when grouped in
          // Notification Center. To make them STICKY (Alert style, no
          // auto-dismiss) the user sets System Settings → Notifications →
          // Terminal (or Script Editor) → Style: Alerts + Allow sound + Show on
          // Lock Screen (see README). The monitor cannot set the style itself.
          const soundByLevel = {
            info: 'Glass',
            model_change: 'Glass',
            warning: 'Ping',
            critical: 'Sosumi'
          };
          // Default subtitle = alert title (info). For the levels worth
          // noticing, lead the subtitle with the LEVEL + time so it groups
          // prominently in Notification Center and is glanceable.
          let notifySubtitle = title;
          if (level === 'warning' || level === 'critical' || level === 'model_change') {
            notifySubtitle = `${String(level).toUpperCase()} · ${new Date().toLocaleString()}`;
          }
          const soundName = soundByLevel[level] || 'Glass';
          const osaErr = await notifyViaOsascript(notifyTitle, notifyMessage, notifySubtitle, soundName);
          if (osaErr) {
            logDesktopWarning(`osascript failed: ${osaErr.message || osaErr}`);
          }
          // Guaranteed audible fallback. osascript's `sound name` is unreliable
          // (silent success), so for warning/critical we ALWAYS play the mapped
          // sound via afplay to guarantee the user hears it even when the banner
          // is missed/suppressed. For info/model_change we only afplay when
          // osascript failed (a healthy banner then needs no extra sound).
          // Never throws — failures are logged at most as a WARNING above.
          const alwaysAudible = level === 'warning' || level === 'critical';
          if (alwaysAudible || osaErr) {
            await notifyViaAfplay(soundName);
          }
          if (osaErr) {
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
    track(postToWebhook(CONFIG.webhook, { level, title, message, ts: ts() }));
  }

  // Persistent subscriber fan-out. For every subscriber whose `levels` filter
  // includes this alert's level, POST an alert to its webhook URL (resolved
  // directly, or via a webhookEnv env var so the secret never lives in
  // subscribers.json). Discord webhooks receive a rich embed (model_change /
  // warning / critical) or { content: "..." } (truncated to 2000 chars);
  // Slack/custom endpoints receive the original { text: "..." }. Forum-channel
  // thread params (?thread_name=/?thread_id=) pass through verbatim. Fully
  // best-effort: timeouts and other failures are logged as WARNING and never
  // thrown, and a malformed entry is skipped so one bad subscriber can't break
  // alert delivery. Skipped entirely when opts.noSubscribers is set (used by
  // monitor heartbeats, which must stay DEBUG-only and never reach Discord).
  if (!(opts && opts.noSubscribers)) {
    for (const sub of SUBSCRIBERS) {
      try {
        if (!sub || !Array.isArray(sub.levels) || !sub.levels.includes(level)) continue;
        let url = sub.webhookUrl;
        if (!url && sub.webhookEnv) url = process.env[sub.webhookEnv];
        if (!url) continue; // nothing resolvable to deliver to
        // When the table path handles Discord presentation, skip only Discord-shaped
        // endpoints and still deliver the plain line to non-Discord (Slack) ones.
        if (opts && opts.skipDiscord && DISCORD_WEBHOOK_RE.test(url || '')) continue;
        const { url: finalUrl, payload } = buildSubscriberDelivery(sub, url, level, title, message);
        track(deliverToSubscriber(sub, finalUrl, payload));
      } catch (_) {
        // A structurally broken entry must not crash the alert path.
      }
    }
  }

  return { delivered: true };
}

// --- Per-cycle parse cache (v0.16.0, #103) -----------------------------------
//
// renderMarkdown + reportSummary + the digest each re-parsed usage-history.json,
// history.json and changelog.json several times per cycle (4x + 1x + 3x). These
// readers now cache the parsed array, validated by file mtime+size so any write
// (including our own batched changelog flush) transparently re-parses on the
// next read. init() starts a fresh cache each cycle. Outputs are identical: the
// same parse result is simply reused instead of re-read from disk.
let cycleCache = null; // null = parse-through (legacy); object = enabled

function beginCycleCache() {
  cycleCache = {};
}

function clearCycleCache() {
  cycleCache = null;
}

function invalidateCycleCache() {
  if (cycleCache) cycleCache = {};
}

// Best-effort cached parse of a JSON-array state file. Returns the array (or
// [] when missing/corrupt/non-array — exactly the legacy semantics). Never throws.
function cachedJsonArray(fileName) {
  const file = path.join(STATE_DIR, fileName);
  if (cycleCache) {
    try {
      const st = fs.statSync(file);
      const hit = cycleCache[fileName];
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      const data = Array.isArray(parsed) ? parsed : [];
      cycleCache[fileName] = { mtimeMs: st.mtimeMs, size: st.size, data };
      return data;
    } catch (_) {
      // Missing/corrupt file (or stat race): fall through to legacy behavior.
    }
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// Best-effort read of the usage time-series from STATE_DIR. Returns the array of
// samples (or [] if missing/corrupt). Never throws.
function readUsageHistory() {
  return cachedJsonArray('usage-history.json');
}

// Best-effort read of the persisted pricing time-series (history.json) from
// STATE_DIR. Returns the array of samples (or [] if missing/corrupt). Never throws.
function readPriceHistory() {
  return cachedJsonArray('history.json');
}

// Best-effort read of the persisted changelog array from STATE_DIR. Returns the
// array of events (or [] if missing/corrupt). Never throws.
function readChangelog() {
  return cachedJsonArray('changelog.json');
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

// Build the 4-line human summary prepended to report.md (fix d): a status
// emoji, the biggest current risk, the next reset (humanized), and the number
// of models tracked. Best-effort: any missing data degrades to a calm default.
function reportSummary(report) {
  const rep = report || {};
  const pricing = rep.pricing || {};
  const models = pricing.models || {};
  const modelCount = pricing.modelCount != null ? pricing.modelCount : Object.keys(models).length;
  const usage = rep.usage || {};
  const usageWin = usage.usage ? usage.usage : usage;
  const wins = ['rolling', 'weekly', 'monthly'].filter((w) => usageWin[w]);

  let events = [];
  try {
    const arr = readChangelog();
    const cutoff = Date.now() - changelogRetentionMs;
    if (Array.isArray(arr)) events = arr.filter((e) => (e.ts ? Date.parse(e.ts) : 0) >= cutoff);
  } catch (_) {}
  const quiet = events.length === 0;
  const statusEmoji = quiet ? '🟢' : '🔴';
  const statusText = quiet ? 'All quiet' : `${events.length} change(s)`;

  // Biggest risk: the most severe window at/above a threshold, else a fast
  // upward 7-day trend that would hit warn within a week, else "nominal".
  let risk = 'none — all windows nominal';
  let worst = null;
  for (const w of wins) {
    const wi = usageWin[w];
    if (!wi || typeof wi.percent !== 'number') continue;
    const pct = wi.percent;
    const lvl = pct >= 95 ? 'critical' : pct >= 80 ? 'warning' : null;
    if (
      lvl &&
      (!worst ||
        (lvl === 'critical' && worst.level !== 'critical') ||
        (lvl === worst.level && pct > worst.pct))
    ) {
      worst = { win: w, pct, level: lvl };
    }
  }
  if (worst) {
    risk = `${worst.win} at ${worst.pct}% (${worst.level})`;
  } else if (wins.length) {
    const history = readUsageHistory();
    const now = Date.now();
    for (const w of wins) {
      const wi = windowInfo(history, w, now);
      if (wi && wi.delta != null && wi.delta > 0 && wi.current < 80) {
        const rate = wi.daysElapsed > 0 ? wi.delta / wi.daysElapsed : 0;
        if (rate > 0) {
          const daysToWarn = (80 - wi.current) / rate;
          if (daysToWarn <= 7) {
            risk = `${w} trending up (Δ +${wi.delta}/7d, ~${Math.round(daysToWarn)}d to warn)`;
            break;
          }
        }
      }
    }
  }

  const headlineWin = wins.includes('monthly') ? 'monthly' : wins[wins.length - 1];
  let nextResetIso =
    headlineWin && usageWin[headlineWin] && usageWin[headlineWin].resetsAt
      ? usageWin[headlineWin].resetsAt
      : null;
  if (!nextResetIso) {
    let soonest = null;
    for (const w of wins) {
      const r = usageWin[w] && usageWin[w].resetsAt;
      if (r) {
        const t = Date.parse(r);
        if (!isNaN(t) && (!soonest || t < soonest)) soonest = t;
      }
    }
    nextResetIso = soonest ? new Date(soonest).toISOString() : null;
  }
  const resetStr = nextResetIso
    ? humanizeReset(nextResetIso) + (headlineWin ? ` (${headlineWin})` : '')
    : 'n/a';

  return [
    `${statusEmoji} ${statusText}`,
    `⚠️ Biggest risk: ${risk}`,
    `🔄 Next reset: ${resetStr}`,
    `📊 Models tracked: ${modelCount}`
  ];
}

function renderMarkdown(report) {
  const lines = [];
  const now = Date.now();
  const history = readUsageHistory();
  // Fix d: prepend a 4-line human summary so the report opens with the status,
  // biggest risk, next reset (humanized), and model count at a glance.
  const summary = reportSummary(report);
  for (const s of summary) lines.push(s);
  lines.push('');
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
  // Per-model metadata for the changed models (P0-2). Purely additive to the
  // diff report; degrades to nothing when a model carries no metadata.
  if (Array.isArray(p.modelChanges) && p.modelChanges.length) {
    const withMeta = p.modelChanges.filter(
      (c) => c.meta && (c.meta.contextWindow || c.meta.capabilities || c.meta.provider)
    );
    if (withMeta.length) {
      lines.push('');
      lines.push('Model metadata (changed):');
      for (const c of withMeta) lines.push(`- ${c.model}: ${metaShort(c.meta)}`);
    }
    // Effective price (after the $60 credit multiplier) for cost-changed models.
    // Computed at render time (list x 60/usage-cap) so the raw snapshot stays
    // unchanged; unknown caps fall back to the default $60 (1x). Additive.
    const costChanges = p.modelChanges.filter((c) => c.subtype === 'cost');
    if (costChanges.length) {
      lines.push('');
      lines.push('Effective price (after $60 credit multiplier):');
      lines.push('');
      lines.push('Effective = list x (60 / usage-cap). Unknown caps default to $60 (1x).');
      for (const c of costChanges) {
        const mult = usageTable.effectiveMultiplier(c.model);
        const eff = usageTable.effectiveCost(c.newCost, c.model);
        const order = ['input', 'output', 'cache_read', 'cache_write'];
        const parts = order
          .filter((k) => eff && Object.prototype.hasOwnProperty.call(eff, k))
          .map((k) => `${k} ${fmtModelCost(eff[k])}`);
        // PR page spec #4: surface the output $/1M change metric on the report.md
        // cost line so the magnitude (Δ% / × / $) is stated, not just old→new.
        const outMetric = changeMetric.fmtChangeMetric(c.oldCost && c.oldCost.output, c.newCost && c.newCost.output);
        const outTail = outMetric ? `  [output ${outMetric}]` : '';
        lines.push(`- ${c.model}: ${parts.join(' / ')}  (list x${fmtMult(mult)})${outTail}`);
        // P1-3, #52: a tiered model (standard + large-context) also shows the
        // effective cost of each context tier. Single-tier models yield nothing.
        const tiers = usageTable.effectiveTierCosts(c.newCost, c.model);
        if (tiers.length) {
          lines.push(`  - ${tierLineStr(c.model, tiers)}`);
        }
      }
    }
  }
  if (p.modelCount != null) {
    lines.push('');
    lines.push(`Models tracked: ${p.modelCount}`);
  }
  // Always surface the persisted time-series length so trends stay visible even
  // on the common 304 Not Modified cycle (which carries no modelCount).
  {
    const ph = readPriceHistory().length;
    lines.push(`Price history: ${ph} sample${ph === 1 ? '' : 's'}`);
  }
  // Free models (Zen / *-free) — P1-2, #51. Additive section: announces zero-cost
  // Zen models separately from the billable diff so cost is never overstated.
  lines.push('');
  lines.push('## Free models (Zen / *-free)');
  lines.push('');
  const freeIds = Array.isArray(p.freeModels) ? p.freeModels : [];
  if (!freeIds.length) {
    lines.push('No free (`*-free` / zero-cost) Zen models detected.');
  } else {
    lines.push(`${freeIds.length} free model(s) available:`);
    for (const id of freeIds) lines.push(`- 🆓 ${id}`);
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
      const resets = w.resetsAt ? ` (resets ${humanizeReset(w.resetsAt)})` : '';
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
    const arr = readChangelog();
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
      lines.push(`- ${win} resets: ${humanizeReset(w.resetsAt)}`);
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
    const proj = changeMetric.projectThresholds(wi, now);
    if (!proj) {
      lines.push(`- ${win} projection: stable (no increase detected)`);
    } else if (proj.daysToWarn === 0) {
      lines.push(`- ${win}: already at/above warn threshold`);
    } else {
      const warnDate = changeMetric.thresholdDateIso(now, proj.daysToWarn);
      const critDate = changeMetric.thresholdDateIso(now, proj.daysToCrit);
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

// --- Model-change table delivery -----------------------------------------
//
// price-watch emits per-model changes (added / removed / cost / tiers). The
// plain `Cost changed for hy3: {...} -> {...}` line is hard to scan in Discord,
// so we ALSO build an aggregated, Discord-friendly table of those changes and
// deliver it as ONE post (chunked if large) to Discord subscribers. alerts.log
// keeps the original human-readable single lines; the table only enhances the
// Discord presentation. Dedup still applies per-model via alert()'s TTL check,
// so a model re-alerted within the window is skipped entirely (table included).
//
// ch shape (one of):
//   { subtype: 'cost',    model, oldCost, newCost }
//   { subtype: 'added',   model, cost }
//   { subtype: 'removed', model }
//   { subtype: 'tiers',   model }

const MODEL_TABLE_MAX = 1900; // Discord content cap w/ headroom (hard limit 2000)
const MODEL_TABLE_MAX_ROWS = 10; // rows per post before a "+N more" tail

// Format a cost metric for the table: up to 6 sig figs, trailing zeros dropped
// (e.g. 0.004375, 0.14, 2.5). Missing/NaN becomes an em-dash.
function fmtModelCost(x) {
  if (x == null) return '—';
  const n = Number(x);
  if (isNaN(n)) return '—';
  return String(parseFloat(n.toPrecision(6)));
}

function truncateModelId(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Compact metadata summary for a model-change entry's `meta` (from price-watch's
// extractModelMeta). Returns an em-dash when no metadata is available so the
// table/lines stay readable. Never throws.
function metaShort(meta) {
  if (!meta || typeof meta !== 'object') return '—';
  const parts = [];
  if (meta.contextWindow) parts.push('ctx ' + fmtCtx(meta.contextWindow));
  if (meta.capabilities && typeof meta.capabilities === 'object') {
    const c = meta.capabilities;
    const tags = [];
    if (c.tool_call) tags.push('tool');
    if (c.reasoning) tags.push('rsn');
    if (c.attachment) tags.push('att');
    if (c.structured_output) tags.push('so');
    const inp = (c.modalities && c.modalities.input) || [];
    if (Array.isArray(inp)) {
      if (inp.includes('image')) tags.push('img');
      if (inp.includes('audio')) tags.push('aud');
    }
    if (tags.length) parts.push(tags.join('+'));
  }
  if (meta.provider) parts.push(providerShort(meta.provider));
  return parts.length ? parts.join(' · ') : '—';
}

// Format a context-window size into a short human token: 1048576 -> "1M",
// 256000 -> "256k", 2000 -> "2000".
function fmtCtx(n) {
  const num = Number(n);
  if (isNaN(num)) return '—';
  if (num >= 1e6) {
    const m = num / 1e6;
    return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
  }
  if (num >= 1e3) return Math.round(num / 1e3) + 'k';
  return String(num);
}

// Shorten a provider id like "@ai-sdk/anthropic" -> "anthropic" for the table.
function providerShort(p) {
  const s = String(p == null ? '' : p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Pretty-print a model id as a title-cased name: split on -_.: and capitalize
// each part. "hy3-alpha" -> "Hy3 Alpha", "ox.alpha.free" -> "Ox Alpha Free".
function prettyId(id) {
  const s = String(id == null ? '' : id);
  return s
    .split(/[-_.:]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Junk / boilerplate detection for a model description. A description is junk
// when it is duplicated across models (dupCount > 1), too short (<30 chars), or
// "meme-case" (random internal casing / leetspeak). Junk descriptions must never
// be printed verbatim — the caller falls back to the pretty id and appends a
// "desc-unverified" marker instead.
function isJunkDesc(desc, dupCount) {
  if (!desc || typeof desc !== 'string') return false;
  const t = desc.trim();
  if (!t) return false;
  if (dupCount != null && dupCount > 1) return true;
  if (t.length < 30) return true;
  // meme-case: an inner lowercase letter followed by an uppercase (camel/meme),
  // or a capital sandwiched between lowercase (mEmE). Pure all-caps short shouts
  // also count. (Legitimate ids like "hy3" keep their digit — we do NOT treat a
  // digit adjacent to a letter as leetspeak, or normal names would false-flag.)
  if (/[a-z][A-Z]/.test(t)) return true;
  if (/[A-Z][a-z][A-Z]/.test(t)) return true;
  if (t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && t.length < 14) return true;
  return false;
}

// Resolve the display name for a model. Prefers meta.name when it is present and
// not junk; otherwise falls back to a pretty title-cased id. Returns { name, junk }
// so the caller can append a "desc-unverified" marker when the description was
// junk. `dupCount` lets the caller mark a description reused across models.
function modelDisplayName(model, meta, dupCount) {
  const raw = meta && typeof meta === 'object' && typeof meta.name === 'string' ? meta.name.trim() : '';
  const junk = raw ? isJunkDesc(raw, dupCount) : false;
  const name = junk || !raw ? prettyId(model) : raw;
  return { name, junk };
}

// Capability tags (tool/rsn/att/so/...) from a meta.capabilities block, joined
// by '+'. Absent/empty capabilities -> em-dash so the line stays readable.
function capTags(meta) {
  const c = meta && meta.capabilities;
  if (!c || typeof c !== 'object') return '—';
  const tags = [];
  if (c.tool_call) tags.push('tool');
  if (c.reasoning) tags.push('rsn');
  if (c.attachment) tags.push('att');
  if (c.structured_output) tags.push('so');
  if (c.temperature) tags.push('temp');
  if (c.interleaved) tags.push('iv');
  const inp = c.modalities && c.modalities.input;
  if (Array.isArray(inp)) {
    if (inp.includes('image')) tags.push('img');
    if (inp.includes('audio')) tags.push('aud');
  }
  return tags.length ? tags.join('+') : '—';
}

// A single, human-scannable cost-change line used by the changelog, the report's
// "Changes detected" list, and the digest — ONE format on every surface:
//   "🔴 <Name> (<id>) output $A→$B (+P%, Nx, +$D) · in $C→$E · Eff Nx"
// Prefers the output metric (the page headline); falls back to input when output
// is absent. cache_read is dropped unless it actually moved. Never throws.
function costChangeHumanText(model, oldCost, newCost, opts) {
  opts = opts || {};
  const meta = opts.meta;
  const dn = modelDisplayName(model, meta);
  const o = oldCost && typeof oldCost === 'object' ? oldCost : {};
  const n = newCost && typeof newCost === 'object' ? newCost : {};

  const useOutput = typeof o.output === 'number' || typeof n.output === 'number';
  const primaryKey = useOutput ? 'output' : 'input';
  const pa = o[primaryKey];
  const pb = n[primaryKey];
  const primaryMetric = changeMetric.fmtChangeMetric(
    typeof pa === 'number' ? pa : null,
    typeof pb === 'number' ? pb : null
  );
  const primary = `${primaryKey} $${fmtModelCost(pa)}→$${fmtModelCost(pb)}` + (primaryMetric ? ` ${primaryMetric}` : '');

  let secondary = '';
  if (useOutput) {
    const ia = o.input;
    const ib = n.input;
    const inMetric = changeMetric.fmtChangeMetric(
      typeof ia === 'number' ? ia : null,
      typeof ib === 'number' ? ib : null
    );
    secondary = ` · in $${fmtModelCost(ia)}→$${fmtModelCost(ib)}` + (inMetric ? ` ${inMetric}` : '');
  }

  let eff = '';
  try {
    const mult = usageTable.effectiveMultiplier(model);
    eff = ` · Eff ${fmtMult(mult)}`;
  } catch (_) {
    eff = '';
  }

  return `🔴 ${dn.name} (${model}) ${primary}${secondary}${eff}`;
}

// Map a privacy/training descriptor to plain words (never raw JSON / null):
//   training true  -> "trains", false -> "no-train", absent -> "unknown"
//   zdrValidUntil   -> "ZDR until <date>"   (otherwise omitted)
function formatPrivacyWords(p) {
  if (!p || typeof p !== 'object') return 'unknown';
  const t = p.training;
  let word;
  if (t === true || t === 'trains' || t === 'train') word = 'trains';
  else if (t === false || t === 'no-train' || t === 'no_train') word = 'no-train';
  else word = 'unknown';
  const parts = ['privacy: ' + word];
  if (p.zdrValidUntil != null && String(p.zdrValidUntil).trim()) {
    parts.push('ZDR until ' + String(p.zdrValidUntil).trim());
  }
  return parts.join(' · ');
}

// Compact capability + provenance summary for a model-change line. Family /
// provider / knowledge are ALWAYS shown (a '?' marker when missing) so gaps in
// the catalog are never silently swallowed. Never throws.
function metaShort(meta) {
  if (!meta || typeof meta !== 'object') return '—';
  const parts = [];
  if (meta.contextWindow) parts.push('ctx ' + fmtCtx(meta.contextWindow));
  const caps = capTags(meta);
  if (caps !== '—') parts.push(caps);
  parts.push(meta.family ? 'family:' + meta.family : 'family?');
  parts.push(meta.provider ? 'provider:' + providerShort(meta.provider) : 'provider?');
  parts.push(meta.knowledge != null ? 'knowledge:' + meta.knowledge : 'knowledge?');
  if (meta.deprecated) parts.push('⚠️ deprecated');
  return parts.length ? parts.join(' · ') : '—';
}

// --- Tier-label helpers (Fix 3, #88) --------------------------------------
//
// A tier is described by its `type` (e.g. "standard", "large-context") and a
// `size`. The changelog line carries old→new labels plus any bound that moved.

// Short label for a single tier entry (accepts {type,size} or {label,...}).
function tierType(t) {
  if (typeof t === 'string') return t;
  if (!t || typeof t !== 'object') return null;
  if (typeof t.type === 'string') return t.type;
  if (typeof t.label === 'string') return t.label;
  return null;
}

function tierLabels(tiers) {
  const arr = Array.isArray(tiers) ? tiers : [];
  const labels = arr.map(tierType).filter(Boolean);
  return labels.length ? labels.join('+') : '';
}

// The moved bound between old/new tiers: a tier type present in both whose size
// changed ("large-context ctx 256k→1M"), a newly-added tier ("large-context ctx
// →1M"), or a dropped tier ("large-context ctx 256k→"). Empty when nothing moved.
function movedTierBound(oldTiers, newTiers) {
  const a = Array.isArray(oldTiers) ? oldTiers : [];
  const b = Array.isArray(newTiers) ? newTiers : [];
  const oldByType = {};
  for (const t of a) {
    const ty = tierType(t);
    if (ty && typeof t.size === 'number') oldByType[ty] = t.size;
  }
  const newByType = {};
  for (const t of b) {
    const ty = tierType(t);
    if (ty && typeof t.size === 'number') newByType[ty] = t.size;
  }
  // Prefer a tier whose size actually changed.
  for (const ty of Object.keys(newByType)) {
    if (oldByType[ty] != null && oldByType[ty] !== newByType[ty]) {
      return `${ty} ctx ${fmtCtx(oldByType[ty])}→${fmtCtx(newByType[ty])}`;
    }
  }
  // Newly-added bound.
  for (const ty of Object.keys(newByType)) {
    if (oldByType[ty] == null) return `${ty} ctx →${fmtCtx(newByType[ty])}`;
  }
  // Dropped bound.
  for (const ty of Object.keys(oldByType)) {
    if (newByType[ty] == null) return `${ty} ctx ${fmtCtx(oldByType[ty])}→`;
  }
  return '';
}

// Format the effective-price multiplier (MONTHLY_CREDIT / usage-cap) for chat:
// 4 -> "4x", 1 -> "1x", 0.6 -> "0.6x". Missing/NaN becomes an em-dash.
function fmtMult(m) {
  const n = Number(m);
  if (!isFinite(n)) return '—';
  return parseFloat(n.toFixed(2)).toString() + 'x';
}

// Short metric keys for the compact tier line (input/output/cache_read/cache_write
// -> i/o/cr/cw) so the second Discord line stays well under the 1900 cap.
const TIER_SHORT = { input: 'i', output: 'o', cache_read: 'cr', cache_write: 'cw' };
const TIER_ORDER = ['input', 'output', 'cache_read', 'cache_write'];

// Render a compact "model tiers: standard iX oY crZ / large-context iX' oY' crZ'"
// line from the effective cost of each context tier. Used as the Discord table's
// second line and in report.md (P1-3, #52). Never throws.
function tierLineStr(model, tiers) {
  const fmtTier = (t) => {
    const e = t.effective || {};
    const m = TIER_ORDER.filter((k) => e[k] != null).map((k) => TIER_SHORT[k] + fmtModelCost(e[k]));
    return t.label + ' ' + m.join(' ');
  };
  return `${truncateModelId(model, 22)} tiers: ` + (tiers || []).map(fmtTier).join(' / ');
}

// One cost-change table row: "hy3 | 0.0175→0.14 | 0.0725→0.58 +700% (8x, +$0.5075) | 0.004375→0.035 | 1x | ctx 1M · tool+rsn"
// The Eff× column is the effective-price multiplier after the $60 credit (list
// x 60/usage-cap); computed at render so the raw snapshot stays unchanged.
// The output cell ALSO carries the change metric (Δ% / × / $) so every Discord
// cost line states the magnitude of the move, not just old→new (PR page spec #4).
function modelChangeRowStr(r) {
  const cell = (k) => `${fmtModelCost(r.oldCost && r.oldCost[k])}→${fmtModelCost(r.newCost && r.newCost[k])}`;
  const outMetric = changeMetric.fmtChangeMetric(r.oldCost && r.oldCost.output, r.newCost && r.newCost.output);
  const outCell = outMetric ? `${cell('output')} ${outMetric}` : cell('output');
  const mult = usageTable.effectiveMultiplier(r.model);
  return `${truncateModelId(r.model, 22)} | ${cell('input')} | ${outCell} | ${cell('cache_read')} | ${fmtMult(mult)} | ${metaShort(r.meta)}`;
}

function modelChangeLineStr(l) {
  if (l.subtype === 'added') {
    // Fix 1 (#88): "🟢 <Name> (<id>) ADDED — in/out $X/$Y per 1M · ctx N · caps+ · cap $C"
    // display name = meta.name, else a pretty title-cased id; junk descriptions
    // get the "⚠️ desc-unverified" marker and are never printed verbatim.
    const dn = modelDisplayName(l.model, l.meta);
    const c = l.cost || {};
    let cap = '—';
    try {
      cap = '$' + fmtModelCost(usageTable.getUsageCap(l.model, usageTable.silentLog));
    } catch (_) {
      cap = '—';
    }
    const ctx = l.meta && l.meta.contextWindow ? fmtCtx(l.meta.contextWindow) : '—';
    let line =
      `🟢 ${dn.name} (${l.model}) ADDED — in/out $${fmtModelCost(c.input)}/$${fmtModelCost(c.output)} per 1M` +
      ` · ctx ${ctx} · ${capTags(l.meta)} · cap ${cap}`;
    if (dn.junk) line += ' · ⚠️ desc-unverified';
    if (l.meta && l.meta.deprecated) line += ' · ⚠️ deprecated';
    return line;
  }
  if (l.subtype === 'removed') {
    const dn = modelDisplayName(l.model, l.meta);
    let cap = '—';
    try {
      cap = '$' + fmtModelCost(usageTable.getUsageCap(l.model, usageTable.silentLog));
    } catch (_) {
      cap = '—';
    }
    const ctx = l.meta && l.meta.contextWindow ? fmtCtx(l.meta.contextWindow) : '—';
    let line =
      `⚫ ${dn.name} (${l.model}) REMOVED — ctx ${ctx} · ${capTags(l.meta)} · cap ${cap}`;
    if (dn.junk) line += ' · ⚠️ desc-unverified';
    if (l.meta && l.meta.deprecated) line += ' · ⚠️ deprecated';
    return line;
  }
  if (l.subtype === 'tiers') {
    // Fix 3 (#88): tiers carry old→new labels + any moved bound.
    const dn = modelDisplayName(l.model, l.meta);
    const oldL = tierLabels(l.oldTiers);
    const newL = tierLabels(l.newTiers);
    const bound = movedTierBound(l.oldTiers, l.newTiers);
    let line = `⚪ ${dn.name} (${l.model}) TIERS ${oldL || '—'} → ${newL || '—'}` + (bound ? ` (${bound})` : '');
    if (dn.junk) line += ' · ⚠️ desc-unverified';
    return line;
  }
  if (l.subtype === 'deprecated') {
    // v0.12.0 (#90): catalog.json status/deprecated cross-check.
    const dn = modelDisplayName(l.model, l.meta);
    let line = `⚠️ ${dn.name} (${l.model}) DEPRECATED`;
    if (dn.junk) line += ' · ⚠️ desc-unverified';
    return line;
  }
  if (l.subtype === 'free') {
    // 🆓 announces a free Zen model; removal/change use distinct markers so the
    // Discord table stays scannable. Additive — never alters billable rows.
    const dn = modelDisplayName(l.model, l.meta);
    const tag = l.reason === 'removed' ? '⚫' : l.reason === 'changed' ? '🟡' : '🆓';
    const label =
      l.reason === 'removed' ? 'FREE REMOVED' : l.reason === 'changed' ? 'FREE CHANGED' : 'FREE available';
    let line = `${tag} ${dn.name} (${l.model}) ${label}`;
    if (dn.junk) line += ' · ⚠️ desc-unverified';
    if (l.meta && l.meta.deprecated) line += ' · ⚠️ deprecated';
    return line;
  }
  if (l.subtype === 'tier') {
    // P1-3, #52: second line of the model-change table showing the effective cost
    // of each context tier (standard / large-context). Rides in the first chunk.
    return `↳ ${tierLineStr(l.model, l.tiers)}`;
  }
  if (l.subtype === 'cap') {
    // v0.10.0, #77: quota/cap move. A downgrade is the user's top priority
    // ("models moving between caps = more expensive") so it carries ⚠️ and the
    // "Xx more expensive / cheaper" magnitude. Ranked top among model changes.
    const tag = l.direction === 'downgraded' ? '⚠️' : '🔼';
    const moreLess = l.direction === 'downgraded' ? 'more expensive' : 'cheaper';
    return `${tag} ${l.model} QUOTA ${l.oldCap}→${l.newCap} (${l.factor}x ${moreLess})  ·  ${metaShort(l.meta)}`;
  }
  return `• ${l.model} ${l.subtype || 'changed'}  ·  ${meta}`;
}

// Human-readable single line (matches price-watch's legacy string format so the
// changelog + discord-digest regex keep working) for the alerts.log entry.
function modelChangeHumanMessage(ch) {
  if (ch.subtype === 'cost') {
    // Fix 2 (#88): replace the raw JSON dump with the single metric-delta shape
    // shared by the changelog / report / digest. cache_read is dropped unless it
    // moved (handled inside costChangeHumanText); never emit raw JSON.
    return costChangeHumanText(ch.model, ch.oldCost, ch.newCost, { meta: ch.meta });
  }
  if (ch.subtype === 'added') return `Added model: ${ch.model}`;
  if (ch.subtype === 'removed') return `Removed model: ${ch.model}`;
  if (ch.subtype === 'deprecated') return `Model deprecated: ${ch.model}`;
  if (ch.subtype === 'tiers') return `Tiers changed for ${ch.model}`;
  if (ch.subtype === 'free') {
    if (ch.reason === 'removed') return `Free model removed: ${ch.model}`;
    if (ch.reason === 'changed') return `Free model changed: ${ch.model}`;
    return `Free model available: ${ch.model}`;
  }
  if (ch.subtype === 'cap') {
    const moreLess = ch.direction === 'downgraded' ? 'more expensive' : 'cheaper';
    return `Quota moved for ${ch.model}: $${ch.oldCap} -> $${ch.newCap} (${ch.factor}x ${moreLess})`;
  }
  return `Model changed: ${ch.model}`;
}

// Build one-or-more Discord content chunks (each <=1900 chars) from a batch of
// model changes. Cost changes become a fenced code-block table (paginated at 10
// rows with a "+N more" tail); added/removed/tiers become scannable lines in the
// first chunk. Never exceeds Discord's 2000-char hard limit (deliverRawContent
// caps as a final safety net).
function buildModelChangeChunks(rows, lines) {
  const head = (rowCount, lineCount) => {
    const total = (rowCount || 0) + (lineCount || 0);
    const emoji = rowCount ? '🔴' : '🔵';
    return `**Model change** ${emoji} ${total} model${total === 1 ? '' : 's'} updated`;
  };
  const chunks = [];
  if (!rows || !rows.length) {
    let body = head(0, (lines || []).length);
    for (const l of lines || []) body += '\n' + modelChangeLineStr(l);
    chunks.push(body.length > MODEL_TABLE_MAX ? body.slice(0, MODEL_TABLE_MAX) : body);
    return chunks;
  }
   const tableHeader = 'Model | Input | Output | Cache | Eff× | Meta';
  for (let i = 0; i < rows.length; i += MODEL_TABLE_MAX_ROWS) {
    const page = rows.slice(i, i + MODEL_TABLE_MAX_ROWS);
    let body = head(rows.length, lines ? lines.length : 0);
    const table = '```\n' + tableHeader + '\n' + page.map(modelChangeRowStr).join('\n') + '\n```';
    body += '\n' + table;
    // Added/removed/tiers lines ride along in the first chunk only.
    if (i === 0 && lines && lines.length) {
      for (const l of lines) body += '\n' + modelChangeLineStr(l);
    }
    if (i + MODEL_TABLE_MAX_ROWS < rows.length) {
      body += `\n… +${rows.length - i - MODEL_TABLE_MAX_ROWS} more model(s) — cost`;
    }
    chunks.push(body.length > MODEL_TABLE_MAX ? body.slice(0, MODEL_TABLE_MAX) : body);
  }
  return chunks;
}

// Deliver an aggregated model-change table to Discord targets. Returns the
// chunks that were posted (handy for tests / manual runs). `opts.send` injects a
// custom delivery fn (content) => Promise; otherwise the table is fanned out to
// Discord subscribers (model_change level) + a Discord-shaped CONFIG.webhook.
async function deliverModelChangeTable(changes, opts) {
  opts = opts || {};
  ensureConfig();
  // v0.8.0 (#73): dual-write every model change to the append-only JSONL event
  // log (source of truth), regardless of alert dedup. Best-effort; never throws
  // and never blocks the Discord/table delivery below.
  try {
    events.appendChanges(getStateDir(), changes);
  } catch (_) {
    // best effort
  }
  const rows = [];
  const lines = [];
  for (const ch of changes || []) {
    const msg = modelChangeHumanMessage(ch);
    // Log the human-readable single line (changelog + alerts.log), applying the
    // existing per-model dedup. skipDiscord keeps alert() from ALSO posting the
    // plain line to Discord — the table below is the single Discord view.
    const res = await alert('model_change', 'Model changed', msg, { skipDiscord: true });
    if (!(res && res.delivered)) continue; // suppressed by dedup
    if (ch.subtype === 'cost') {
      rows.push(ch);
      // P1-3, #52: a tiered model (standard + large-context pricing) gets a second
      // line showing the effective cost of each tier. Single-tier models yield []
      // so the alert is unchanged. Best-effort: never throws.
      try {
        const tiers = usageTable.effectiveTierCosts(ch.newCost, ch.model);
        if (tiers.length) lines.push({ subtype: 'tier', model: ch.model, tiers });
      } catch (_) {
        // Never let tier rendering break the main alert.
      }
    } else lines.push(ch);
  }
  if (!rows.length && !lines.length) return [];
  const chunks = buildModelChangeChunks(rows, lines);
  const send = opts.send || deliverModelChangeTableToDiscord;
  for (const c of chunks) await send(c);
  return chunks;
}

// Default Discord delivery for the model-change table: Discord-shaped subscriber
// URLs get a { content } payload (truncated to 2000); a Discord-shaped legacy
// CONFIG.webhook also receives it. Tracked so flush() awaits before exit.
async function deliverModelChangeTableToDiscord(content) {
  const finalContent =
    content.length > DISCORD_CONTENT_MAX ? content.slice(0, DISCORD_CONTENT_MAX) : content;
  for (const sub of SUBSCRIBERS) {
    try {
      if (!sub || !Array.isArray(sub.levels) || !sub.levels.includes('model_change')) continue;
      let url = sub.webhookUrl;
      if (!url && sub.webhookEnv) url = process.env[sub.webhookEnv];
      if (!url) continue;
      if (!DISCORD_WEBHOOK_RE.test(url)) continue; // non-Discord subscribers keep the plain line
      // Discord gets a rich embed; the table content doubles as the fallback.
      track(deliverRawContent(sub, finalContent, 'model_change'));
    } catch (_) {
      // best effort
    }
  }
  if (CONFIG && CONFIG.webhook && DISCORD_WEBHOOK_RE.test(CONFIG.webhook || '')) {
    // A Discord-shaped legacy webhook also receives the embed.
    track(
      deliverToSubscriber(
        { name: 'webhook' },
        CONFIG.webhook,
        buildDiscordPayload('model_change', finalContent, { title: 'Model change', description: finalContent })
      )
    );
  }
}

// Route a raw digest content chunk to the configured legacy webhook (if any), in
// addition to the subscriber fan-out — parity with the alert path. Tracked so
// flush() awaits before exit. Best-effort, never throws.
async function deliverDigestToWebhook(content) {
  if (!CONFIG || !CONFIG.webhook) return;
  const finalContent =
    content.length > DISCORD_CONTENT_MAX ? content.slice(0, DISCORD_CONTENT_MAX) : content;
  const payload = DISCORD_WEBHOOK_RE.test(CONFIG.webhook || '')
    ? buildDiscordPayload('digest', finalContent, { title: 'Digest', description: finalContent })
    : { text: finalContent };
  track(postToWebhook(CONFIG.webhook, payload));
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
  buildSubscriberDelivery,
  sendToSubscribers,
  setSubscribers,
  setStateDir,
  getStateDir,
  readUsageHistory,
  readPriceHistory,
  readChangelog,
  beginChangelogBatch,
  endChangelogBatch,
  beginCycleCache,
  clearCycleCache,
  windowInfo,
  deliverModelChangeTable,
  buildModelChangeChunks,
  deliverDigestToWebhook,
  computeDedupKey,
  humanizeReset,
  debug,
  buildDiscordPayload,
  costChangeHumanText,
  modelChangeHumanMessage,
  modelChangeLineStr,
  modelDisplayName,
  prettyId,
  isJunkDesc,
  formatPrivacyWords,
  capTags,
  metaShort,
  tierLabels,
  movedTierBound
};
