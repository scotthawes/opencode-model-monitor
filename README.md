# opencode-model-monitor

A **passive monitoring microservice** for OpenCode hosted models — the
`opencode-go` ("Go") provider on `opencode.ai`. It observes and reports; it
does **not** intercept, rewrite, downgrade, or block any model request.

## Goal

**Monitor** OpenCode hosted models (pricing, quota/usage, config pins, spend)
and surface **alerts/reports** — observation only, no control. The service:

1. Polls the documented data feeds (see `FEEDS.md`) for model pricing and price
   changes, usage/quota via the `/zen/go/v1/usage` API, agent model pins across
   project `.opencode/opencode.json` files, and local spend from `opencode.db`.
 2. Reports and alerts via a log file (always on), stdout, optional desktop
    notification (cross-platform, e.g. `node-notifier`), and/or a webhook
    (Slack/Discord/custom URL) — plus a local report file (JSON/Markdown) read by
    the bundled `npm run report` command — including an alert whenever a model
    changes (price, addition, removal, or tier change).
3. **Does not** intercept or rewrite model requests, downgrade/block models, or
   enforce any routing policy on the orchestrator or subagents. All control
   behavior is deferred to a future phase (if ever).

## Why this exists

- Project-level `.opencode/opencode.json` files can pin agents to models the
  operator may not realize are active. Example found in the wild:
  `graphics-programmer → opencode-go/qwen3.7-plus`, which is **~22x the cost**
  of the `hy3` default on output tokens (`$1.60` vs `$0.0725` per 1M).
- The hosted provider enforces usage caps; blowing them halts all work, so it is
  useful to *see* headroom approaching.
- Model pricing changes over time and is published by OpenCode — we want to
  track it and report on it, so the operator can notice drift.

## Status

**Implemented (Phases 1–3).** A working, standalone monitoring microservice —
**no configuration required** to start getting alerts.

## Quick start (zero config)

Clone and run; alerts start immediately for any OpenCode Go-plan user. No
`config.json` is needed.

```bash
git clone https://github.com/scotthawes/opencode-model-monitor
cd opencode-model-monitor
node src/monitor.js --once   # single check, then exit
node src/monitor.js          # continuous; writes alerts to state/alerts.log + state/report.md
```

> `npm run monitor:once` / `npm run monitor` work too, but they require `npm`
> on PATH. The `node` commands above only need Node itself.

> **`--once` lock note:** if another monitor run still holds the state lock,
> `--once` exits `2`. Re-run with `node src/monitor.js --once --force` to
> override the stale lock.

`npm install` (optional) enables desktop notifications via `node-notifier`:

You'll get alerts (in `state/alerts.log` and `state/report.md`) when:

- a model's price changes, is added, or removed (`api.json` + Go/Zen docs Atom
  feeds),
- your Go quota (rolling / weekly / monthly) crosses 80% / 95%
  (`/zen/go/v1/usage`),
- a new OpenCode release/model ships (`releases.atom`).

`config.json` is **optional** — see *Config knobs* /
[`config.example.json`](config.example.json) only if you also want project
pin-scanning, desktop popups, or a webhook.

## Scope

- **Standalone tool — no dependency on opencode-platform; usable by any OpenCode
  user.** It reads only stock OpenCode data (`api.json`/`catalog.json`, the
  `/zen/go/v1/usage` + `auth.json` APIs, `~/.local/share/opencode/opencode.db`,
  and project `.opencode/opencode.json` files). It does not hook into any
  platform-internal module or cost CLI — it is purely observational: pricing
  comes from the model catalog and the Go/Zen docs Atom feeds, usage/quota from
  the `/zen/go/v1/usage` API, and local spend from `opencode.db`. There is no
  cost-enforcement, routing, or billing subsystem — it only reports what it sees.
- Provider of interest: `opencode-go` (base URL `https://opencode.ai/zen/go/v1`).
- Targets OpenCode v2 (reads the hosted `opencode-go` model/usage data; no
  session hooks required).
- Platform-agnostic: a standalone Node CLI you run yourself (or as a
  launchd/systemd service). It does not install into `~/.config/opencode` or
  hook into OpenCode.

## Usage

A standalone Node.js CLI (CommonJS). It has **no dependency on opencode-platform**
and works for any OpenCode user. It only reads stock OpenCode data
(`api.json`, the `/zen/go/v1/usage` API, `auth.json`, and project
`.opencode/opencode.json` files) and never rewrites or blocks a model request.
Pricing/announcement changes may also surface via the Go/Zen docs Atom feeds
(`go.mdx.atom` / `zen.mdx.atom`) and `releases.atom`, which the monitor watches
(idempotently, via ETag + seen-entry tracking).

### Install

```bash
git clone https://github.com/scotthawes/opencode-model-monitor && cd opencode-model-monitor
npm install          # installs dependencies, including node-notifier for desktop notifications
```

The default run path uses only Node.js built-ins (global `fetch`, `fs`, `path`,
`os`), so it works with **no** `npm install` and no external packages. Desktop
notifications are lazily required inside a `try/catch`, so they're silently
skipped unless `node-notifier` is installed **and** `delivery.desktop` is enabled.
`node-notifier` is listed in `package.json` as a dependency, so a single
`npm install` brings it in — you do **not** need to install it separately.

### Run

```bash
npm run monitor:once   # single check, then exit (good first run / cron)
npm run monitor        # continuous: polls on the configured cadence
npm run report         # print the latest report from state/report.md
```

Or directly:

```bash
node src/monitor.js --once
node src/monitor.js
node src/report-cli.js
```

### Where output goes

All output is written into the `state/` folder inside the repo (configurable via
`stateDir`):

- `state/alerts.log` — append-only line-per-alert log (always on by default).
- `state/report.json` — full structured report (always on by default).
- `state/report.md` — human-readable rendering of the report.
- `state/pricing-snapshot.json` — last seen pricing catalog (diff source).
- `state/.etag-pricing` — cached ETag for cheap conditional GETs.

### Price history (`state/history.json`)

Every successful price-watch appends one dated sample to `state/history.json`,
persisting the pricing catalog over time so drops and catalog changes can be
trended and audited (the catalog is also the diff source for price alerts).

Schema — a JSON array of samples, oldest→newest:

```json
[
  {
    "ts": "2026-09-05T10:12:00.000Z",
    "models": {
      "hy3": { "cost": { "input": 0.14, "output": 0.58, "cache_read": 0.035 }, "tiers": null }
    }
  }
]
```

- Appended only on a successful, non-empty price fetch (HTTP 200 with a populated
  catalog). A `304 Not Modified` or fetch failure does **not** append, to avoid
  padding the series with duplicates.
- Pruned to the last 90 days and capped at 500 samples (atomic tmp+rename write).
- Best-effort: a write failure never throws or blocks alerts. A corrupt or missing
  file is recovered by the next successful append.
- `state/` is gitignored, so `history.json` is never committed.

Show the recent series:

```bash
npm run report:history          # last 10 samples
node src/report-cli.js --history 3
```
- `state/history.json` — append-only pricing time-series (one dated sample per
  successful price-watch; schema below).

### Config knobs

Create a `config.json` in the repo root to override any default. Merged over
built-in defaults; missing keys keep their default value.

```jsonc
{
  "thresholds": { "warning": 80, "critical": 95 },          // usage % levels
  "cadenceMs": {
    "usage": 300000,     // usage/quota poll (5 min)
    "pricing": 1800000,  // pricing catalog poll (30 min)
    "atom": 1800000,     // Go/Zen pricing docs Atom feeds
    "db": 600000,        // config-scan poll (10 min)
    "releases": 86400000 // releases.atom (daily)
  },
  "delivery": {
    "logFile": true,     // write state/alerts.log
    "reportFile": true,  // write state/report.json + report.md
    "stdout": false,     // also console.log alerts
    "desktop": false,    // node-notifier desktop popups (needs install)
    "webhook": null      // POST JSON alerts to a URL (Slack/Discord/custom)
  },
  "scanRoots": ["."],    // absolute or relative paths scanned for .opencode/opencode.json
  "authJsonPath": "~/.local/share/opencode/auth.json"  // opencode-go key source
}
```

## Notifications

Alerts are always written to `state/alerts.log` and the local report files. You
can optionally enable richer delivery channels:

- **Desktop notifications** — pop a native OS notification on each alert.
  1. Install the dependency: `npm install` (pulls `node-notifier`).
  2. Enable via `config.json`:
     ```json
     { "delivery": { "desktop": true } }
     ```
     …or via environment variable (no config edit needed):
     ```bash
     MODEL_MONITOR_DESKTOP=1 npm run monitor
     ```
  The channel is best-effort: if `node-notifier` is missing it is silently
  skipped, and a failed notification never breaks the monitor.

  > **Make macOS alerts prominent.** By default macOS *banners* auto-dismiss
  > after a few seconds and only linger in Notification Center — easy to miss.
  > The monitor now addresses this two ways:
  > - **Sound:** every desktop alert plays a sound so it's audible even if you
  >   glance away — `Glass` for `info`/`model_change`, `Ping` for `warning`, and
  >   the louder `Sosumi` for `critical`.
  > - **Glanceable subtitle:** `warning` / `critical` / `model_change` alerts put
  >   the `LEVEL · <timestamp>` in the subtitle so they stand out when grouped in
  >   Notification Center.
  >
  > **Sticky (no auto-dismiss):** Alert *style* is a per-app OS choice the
  > monitor can't set itself. To make popups persist until you dismiss them:
  > open **System Settings → Notifications → Terminal** (the app running the
  > monitor; use **Script Editor** if you invoke `osascript` directly), then set
  > **Style: Alerts** (stays on screen until dismissed), enable **Play sound**,
  > and turn on **Show on Lock Screen**. Combined with the `sound name` above,
  > you get a persistent, audible popup. (We deliberately avoid `display dialog`
  > modal alerts — they would block the monitor.)

- **Webhook** — `POST` a JSON alert to any URL (Slack/Discord/custom). Payload:
  ```json
  { "level": "info|warning|critical|model_change",
    "title": "...", "message": "...",
    "ts": "2026-01-01T00:00:00.000Z" }
  ```
  Enable via `config.json`:
  ```json
  { "delivery": { "webhook": "https://hooks.slack.com/services/XXX/YYY/ZZZ" } }
  ```
  …or via environment variable:
  ```bash
  MODEL_MONITOR_WEBHOOK="https://hooks.slack.com/services/XXX/YYY/ZZZ" npm run monitor
  ```
  A failing `POST` is caught and logged as a best-effort miss — it never throws.

### Subscribers (multiple destinations + per-subscriber filtering)

The single `webhook` channel above is one destination. To fan **every** alert
out to multiple endpoints — each receiving only the levels it cares about —
create a gitignored `subscribers.json` (copy [`subscribers.example.json`](subscribers.example.json))
next to `config.json`:

```json
[
  { "name": "team-slack",
    "webhookUrl": "https://hooks.slack.com/services/XXX/YYY/ZZZ",
    "levels": ["model_change", "warning", "critical"] },
  { "name": "team-discord",
    "webhookEnv": "MODEL_MONITOR_DISCORD_WEBHOOK",
    "levels": ["model_change", "warning", "critical"] }
]
```

- `name` — free-text label used in failure logs.
- `webhookUrl` **or** `webhookEnv` — the destination. Use `webhookEnv` to point
  at an environment variable (e.g. `MODEL_MONITOR_DISCORD_WEBHOOK`) so the
  secret never lives in the file. The file is gitignored regardless.
- `levels` — subset of `info | model_change | warning | critical | digest`. An
  alert is delivered to a subscriber only if its level is in this list (so `info`
  heartbeat cycles are excluded unless you opt in). The `digest` level (and
  `info`, for convenience) additionally receives the periodic human-readable
  summary — see [Discord digest](#discord-digest-periodic-summaries) below.

On each alert the monitor `POST`s a JSON body to every matching subscriber.
**Slack / custom** endpoints receive the Slack-shaped
`{ "text": "[MODEL_CHANGE] title — message" }` (level uppercased). **Discord**
endpoints (detected by a `discord.com/api/webhooks` URL) instead receive
`{ "content": "[MODEL_CHANGE] title — message", "username": "model-monitor" }`
— Discord requires `content`, not `text`, and silently 400s (`Cannot send an
empty message`) otherwise. `content` is truncated to Discord's 2000-char limit.

Delivery is fully best-effort: a ~10s per-subscriber timeout, failures are
logged to `state/alerts.log` as `WARNING | Subscriber delivery failed (name)`,
and a bad subscriber never throws or stops the monitor. The legacy
`MODEL_MONITOR_WEBHOOK` single-path still works exactly as before when no
`subscribers.json` is present.

**Discord FORUM channels:** a forum webhook needs a thread target. Append
`?thread_name=<name>` (create a new post) or `?thread_id=<id>` (reply to an
existing post) to the webhook URL — the query string is passed through
verbatim, so just put it on the URL. You can also leave it off the URL and set
it per-subscriber with `"threadName": "Budget alerts"` / `"threadId": "1234"`
(which appends `?thread_name=`/`?thread_id=` automatically). See the commented
forum example in `subscribers.example.json`.

**Add a subscriber (Slack or Discord):**
1. Copy `subscribers.example.json` → `subscribers.json`.
2. Add `{ "name": "...", "webhookUrl": "<Slack/Discord incoming-webhook URL>", "levels": ["model_change","warning","critical"] }` (or use `webhookEnv` to read the URL from an env var). For a Discord forum channel, include `?thread_name=`/`?thread_id=` on the URL (or use the `threadName`/`threadId` fields).
3. Test instantly with a one-shot run: `MODEL_MONITOR_WEBHOOK= URL node src/monitor.js --once` — or just watch `state/alerts.log` for your subscriber name on the next alert.

A ready-to-edit template lives at [`config.example.json`](config.example.json).

#### Discord digest (periodic summaries)

Alerts tell you *something happened*; the digest tells you *what changed and
what's coming* — a human-readable summary for the Discord channel to become the
alert **and** report hub. Each digest contains:

- a header (auto-posted) with the generated timestamp,
- **Pricing** — models tracked + any changes,
- **Changes — last 7 days** — quota movement (rolling/weekly/monthly Δ/7d) and
  recent events from the changelog,
- **Upcoming** — next quota resets and projected warn/critical threshold dates.

Opt in by adding `"digest"` to a subscriber's `levels` (a subscriber with
`"info"` also receives it). The monitor posts the digest:

- **every 24h** while running continuously (`setInterval` alongside the other
  feed loops), and
- **on demand** with `node src/monitor.js --digest-once` (posts the current
  `state/report.json` summary once, then exits — no monitor cycle is scheduled).

```bash
node src/monitor.js --digest-once   # push the current 7-day summary to Discord now
```

Long reports are split into multiple sequential Discord posts, each chunked on
newlines and capped at **1900 chars** (well under Discord's 2000-char `content`
limit) so a post is never dropped. The digest reuses the same Discord
`{ content, username }` shape and forum-`?thread_name=`/`?thread_id=` handling
as single alerts.

## Run continuously

For background operation, run the monitor detached or install it as a service:

```bash
# Simple background job (dies with the shell unless nohup/disown used):
npm run monitor &

# macOS — launchd LaunchAgent (starts on login, auto-restarts):
bash scripts/install-macos.sh
# Manual alternative:
#   cp deploy/opencode-model-monitor.plist ~/Library/LaunchAgents/com.opencode.model-monitor.plist
#   # edit the placeholder /PATH/TO/opencode-model-monitor to the real repo path
#   launchctl load ~/Library/LaunchAgents/com.opencode.model-monitor.plist

# Linux — systemd user service (starts on login, auto-restarts):
#   mkdir -p ~/.config/systemd/user
#   # edit deploy/opencode-model-monitor.service: replace
#   #   /PATH/TO/opencode-model-monitor with the real repo path
#   cp deploy/opencode-model-monitor.service ~/.config/systemd/user/
#   systemctl --user enable --now opencode-model-monitor.service
```

The `deploy/` templates use a `/PATH/TO/opencode-model-monitor` placeholder —
substitute the real absolute repo path. `scripts/install-macos.sh` does this for
you automatically.

What it watches (Phase 1):

1. **Pricing** — polls `https://models.opencode.ai/api.json` with an
   `If-None-Match` ETag; alerts (`model_change`) on any model added, removed, or
   whose `cost`/`tiers` changed.
2. **Usage / quota** — polls `https://opencode.ai/zen/go/v1/usage` with the
   `opencode-go` bearer key; alerts `warning`/`critical` when a rolling/weekly/
   monthly window crosses the thresholds.
3. **Config pins** — scans every `.opencode/opencode.json` under `scanRoots` for
   agents pinned to `opencode-go/<id>`; flags (`info`) pins whose output cost is
   more than ~2x `hy3` (report-only — never changes the pin).

> This is the **monitoring-only** phase. It never intervenes in a running
> session, never downgrades a model, and never enforces a budget.

## Production

Everything above is zero-config. For a real deployment, the only setup is
pointing the monitor at **your** ping channel.

### Onboarding — add your own webhook in 5 steps

```bash
npm run add-webhook
```

The CLI walks you through it:

1. **Name** — a label for logs (default `my-discord`).
2. **Destination** — paste your Discord/Slack *incoming-webhook* URL, **or** type
   `env` and give an environment-variable name (the secret stays in your shell /
   service env, never in the file).
3. **Levels** — which alerts to receive. Comma-separated; default
   `model_change,warning,critical,digest` (also allowed: `info`).
4. **Validation + detection** — the URL is checked (must be `https://`;
   `discord.com/api/webhooks`, `hooks.slack.com`, or any generic `https` host),
   and the platform is auto-detected so the right payload shape is used.
5. **Live test** — the monitor sends a real test POST through its own delivery
   path and asks *"Did you see it? (y/n)"*. Say `n` and it lets you re-enter the
   URL. Say `y` and you're done.

The entry is merged into the gitignored `subscribers.json` (file mode `0600`,
existing subscribers preserved, names never duplicated — an existing name
prompts to overwrite). Multiple subscribers with different level filters are
fine.

### Secrets

- `subscribers.json` is **gitignored** — never commit it. Put the webhook secret
  in the URL *or*, preferably, use the `env` option and export the variable in
  your service environment (see the install scripts / Docker `--env`).
- `config.json` (if used) is also gitignored.
- No state (`state/`) is committed either.

### Log rotation

The monitor appends to `state/alerts.log` and `state/changelog.log` forever.
Rotate them (they are plain text) with `logrotate`, e.g.:

```
/PATH/TO/opencode-model-monitor/state/*.log {
    weekly
    missingok
    notifempty
    copytruncate
}
```

(`copytruncate` avoids signalling the monitor; it never reopens the file on its
own. On Linux the equivalent path is `~/.local/share/...` or wherever you cloned.)

### Health check

A healthy monitor exits `0` on a single cycle:

```bash
node src/monitor.js --once   # exit code 0 == healthy
echo $?
```

Use that as a liveness probe (cron, Docker `HEALTHCHECK`, or a watchloop).

### Docker

```bash
docker build -t opencode-model-monitor .
docker run -d --restart=unless-stopped \
  -v "$PWD/subscribers.json:/app/subscribers.json:ro" \
  -v "$PWD/state:/app/state" \
  --name opencode-model-monitor \
  opencode-model-monitor
```

Mount your `subscribers.json` and `state/` from the host (both are gitignored).
The image runs `node src/monitor.js` (continuous mode) by default.

### Linux (systemd user service)

```bash
bash scripts/install-linux.sh
# edits deploy/opencode-model-monitor.service in place, then:
systemctl --user enable --now opencode-model-monitor.service
```

### macOS (launchd LaunchAgent)

```bash
bash scripts/install-macos.sh
```
