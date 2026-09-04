'use strict';

// Interactive webhook onboarding for opencode-model-monitor.
//
// Guides any user through adding their own ping channel to the gitignored
// subscribers.json (mode 600). It validates the URL, auto-detects the platform
// (Discord / Slack / generic HTTPS), merges the new subscriber without
// duplicating names, and finally sends a LIVE test POST through the exact same
// delivery path the monitor uses (buildSubscriberDelivery + deliverToSubscriber
// from src/delivery.js) so the payload shape matches production. The user
// confirms receipt; on a miss they can re-enter the URL.
//
// No secrets are ever committed: subscribers.json is gitignored and webhook
// secrets may instead be supplied via an env var name (webhookEnv).

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Reuse the monitor's real delivery path so the test POST is byte-identical to
// what an alert would send (Discord { content } vs Slack { text }, truncation,
// forum ?thread_name/?thread_id handling, timeouts).
const delivery = require('../src/delivery.js');

const SUBSCRIBERS_PATH = path.join(__dirname, '..', 'subscribers.json');
const ALLOWED_LEVELS = ['model_change', 'warning', 'critical', 'info', 'digest'];
const DEFAULT_LEVELS = ['model_change', 'warning', 'critical', 'digest'];

// --- input helpers ---------------------------------------------------------
//
// A line queue fed by readline's 'line' events. Unlike rl.question(), this does
// NOT race with piped stdin (where all input can arrive before the first
// question's listener is attached) — every line is buffered and handed out in
// order. Works for both interactive TTY and non-interactive pipes.

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: !!process.stdin.isTTY
});

const _lineQueue = [];
let _lineWait = null;
let _eof = false;
rl.on('line', (l) => {
  if (_lineWait) {
    const w = _lineWait;
    _lineWait = null;
    w(l);
  } else {
    _lineQueue.push(l);
  }
});
rl.on('close', () => {
  _eof = true;
  if (_lineWait) {
    const w = _lineWait;
    _lineWait = null;
    w('');
  }
});

function nextLine() {
  if (_lineQueue.length) return Promise.resolve(_lineQueue.shift());
  if (_eof) return Promise.resolve('');
  return new Promise((res) => {
    _lineWait = res;
  });
}

function ask(question, def) {
  process.stdout.write(def != null ? `${question} [${def}]: ` : `${question} `);
  return nextLine().then((ans) => {
    const t = String(ans == null ? '' : ans).trim();
    return t.length ? t : def != null ? def : '';
  });
}

function confirm(question) {
  return ask(`${question} (y/n)`).then((ans) => /^y(es)?$/i.test(ans));
}

// --- validation / shaping --------------------------------------------------

// Detect the platform purely from the URL — mirrors delivery.js detection.
function detectPlatform(url) {
  if (/discord\.com\/api\/webhooks/i.test(url)) return 'Discord';
  if (/hooks\.slack\.com/i.test(url)) return 'Slack';
  return 'generic HTTPS webhook';
}

// Validate: must be a syntactically valid https URL. Known hosts (discord /
// slack) are explicitly accepted; any other https host is accepted as generic.
function validateUrl(url) {
  if (!/^https:\/\//i.test(url || '')) {
    return { ok: false, reason: 'URL must start with https:// (no plaintext http).' };
  }
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return { ok: false, reason: 'Not a valid URL.' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'URL must use the https scheme.' };
  }
  const kind = /discord\.com\/api\/webhooks/i.test(url)
    ? 'discord'
    : /hooks\.slack\.com/i.test(url)
      ? 'slack'
      : 'generic';
  return { ok: true, kind };
}

function parseLevels(input) {
  const tokens = String(input || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const bad = tokens.filter((t) => !ALLOWED_LEVELS.includes(t));
  if (bad.length) {
    return { ok: false, bad, levels: null };
  }
  // De-dupe while preserving order; info and digest both enable digests, keep
  // both if the user listed them.
  const seen = new Set();
  const levels = tokens.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return { ok: true, bad: [], levels };
}

function loadExisting() {
  try {
    if (!fs.existsSync(SUBSCRIBERS_PATH)) return [];
    const arr = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function writeSubscribers(list) {
  const tmp = SUBSCRIBERS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(tmp, SUBSCRIBERS_PATH);
  // Keep the secret file private (gitignored already); mode 600.
  try {
    fs.chmodSync(SUBSCRIBERS_PATH, 0o600);
  } catch (_) {
    // best effort — some platforms ignore chmod; file stays gitignored
  }
}

// Send the live test POST through the monitor's real delivery path.
async function sendTestPost(sub, url) {
  const level = 'info';
  const title = 'Webhook onboarding test';
  const message = 'If you can read this, your ping channel is connected. ✅';
  const { url: finalUrl, payload } = delivery.buildSubscriberDelivery(sub, url, level, title, message);
  const start = Date.now();
  await delivery.deliverToSubscriber(sub, finalUrl, payload);
  return { finalUrl, payload, ms: Date.now() - start };
}

// --- main flow -------------------------------------------------------------

async function main() {
  console.log('\n=== opencode-model-monitor webhook onboarding ===\n');

  const existing = loadExisting();
  if (existing.length) {
    console.log(`Loaded ${existing.length} existing subscriber(s) from subscribers.json (will be preserved).`);
  }

  // 1) name
  let name = await ask('Subscriber name', 'my-discord');

  // 2) resolve duplicates: prompt overwrite, or let them rename
  while (existing.some((s) => s.name === name)) {
    console.log(`A subscriber named "${name}" already exists.`);
    const overwrite = await confirm('Overwrite it?');
    if (overwrite) break;
    name = await ask('Enter a different subscriber name', 'my-discord-2');
  }

  // 3) URL or env var — retry loop so a failed test post can re-enter the URL
  let sub;
  let urlRetries = 0;
  for (;;) {
    if (urlRetries >= 5) {
      console.log('Too many attempts. Aborting without changes.');
      rl.close();
      return;
    }
    urlRetries++;
    const raw = await ask("Paste webhook URL, or type 'env' to supply an env var name");
    let url = null;
    let webhookEnv = null;

    if (raw.toLowerCase() === 'env') {
      webhookEnv = await ask('Environment variable name (e.g. MODEL_MONITOR_DISCORD_WEBHOOK)');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(webhookEnv || '')) {
        console.log('Invalid env var name. Try again.\n');
        continue;
      }
      url = process.env[webhookEnv] || null;
      if (!url) {
        console.log(
          `WARN: $${webhookEnv} is not set in this shell. The subscriber will be saved but the test POST is skipped until the var is exported.`
        );
      }
    } else {
      const v = validateUrl(raw);
      if (!v.ok) {
        console.log(`Invalid URL: ${v.reason} Try again.\n`);
        continue;
      }
      url = raw;
    }

    // 4) levels
    const levelsInput = await ask(
      `Alert levels (comma-separated: ${ALLOWED_LEVELS.join(', ')})`,
      DEFAULT_LEVELS.join(',')
    );
    const parsed = parseLevels(levelsInput);
    if (!parsed.ok) {
      console.log(`Invalid level(s): ${parsed.bad.join(', ')}. Allowed: ${ALLOWED_LEVELS.join(', ')}. Try again.\n`);
      continue;
    }

    sub = webhookEnv
      ? { name, webhookEnv, levels: parsed.levels }
      : { name, webhookUrl: url, levels: parsed.levels };

    // 5) live test POST (only if we can resolve a URL right now)
    if (url) {
      const platform = detectPlatform(url);
      console.log(`\nDetected platform: ${platform}`);
      console.log('Sending live test POST through the monitor delivery path...');
      try {
        const res = await sendTestPost(sub, url);
        console.log(`Test POST sent in ${res.ms}ms to: ${res.finalUrl}`);
        console.log(`Payload shape: ${JSON.stringify(res.payload).slice(0, 200)}`);
      } catch (e) {
        console.log(`Test POST errored: ${e && e.message ? e.message : e}`);
      }
      const seen = await confirm('Did you see the test message in your channel?');
      if (seen) {
        console.log('Great — channel confirmed.');
        break;
      }
      console.log('Not received. Re-enter the webhook URL (or type env).\n');
      continue;
    } else {
      // env var not set in this shell — skip the live test, just save.
      break;
    }
  }

  // Write / merge
  const idx = existing.findIndex((s) => s.name === sub.name);
  if (idx >= 0) {
    existing[idx] = sub;
    console.log(`Updated existing subscriber "${sub.name}".`);
  } else {
    existing.push(sub);
    console.log(`Added subscriber "${sub.name}".`);
  }
  writeSubscribers(existing);
  console.log(`Wrote ${SUBSCRIBERS_PATH} (mode 0600, gitignored).`);
  console.log('Done. The monitor will fan alerts out to this channel on the next cycle.\n');
  rl.close();
}

// --- usage / help -----------------------------------------------------------
//
// Print usage and exit 0 when --help / -h is the first argument. This must run
// BEFORE main() so we never prompt or write when the user only asked for help.

function printUsage() {
  console.log(`opencode-model-monitor webhook onboarding

Add your own ping channel to the gitignored subscribers.json (mode 0600).
No secrets are committed: a webhook URL may also be supplied via an env var.

USAGE
  npm run add-webhook [--help | -h]
  node scripts/add-webhook.js [--help | -h]

URL vs ENV
  When prompted for the webhook, either:
    - paste a full https URL (https:// only; Discord, Slack, or generic https)
    - type 'env' and name an environment variable holding the URL, e.g.
      MODEL_MONITOR_DISCORD_WEBHOOK (the secret stays in your environment /
      service unit, never in the repo)

ALERT LEVELS (comma-separated)
  ${ALLOWED_LEVELS.join(', ')}
  Default: ${DEFAULT_LEVELS.join(', ')}

EXAMPLES
  # Interactive: paste a Discord webhook URL, confirm the live test post
  npm run add-webhook

  # Non-interactive: URL via env var (no test POST until the var is exported)
  export MODEL_MONITOR_DISCORD_WEBHOOK="https://discord.com/api/webhooks/..."
  npm run add-webhook

  # Show this help
  npm run add-webhook --help
`);
}

const _firstArg = process.argv.slice(2)[0];
if (_firstArg === '--help' || _firstArg === '-h') {
  printUsage();
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('Onboarding failed:', e && e.stack ? e.stack : e);
  rl.close();
  process.exit(1);
});
