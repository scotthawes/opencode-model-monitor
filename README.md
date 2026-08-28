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

Design / planning. Implementation not yet started. See:

- [`DESIGN.md`](DESIGN.md) — system architecture
- [`PRICING.md`](PRICING.md) — where model pricing comes from
- [`GAPS.md`](GAPS.md) — gap analysis & design adjustments
- [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — task breakdown
- [`FEEDS.md`](FEEDS.md) — data feed sources for every input

## Scope

- **Standalone tool — no dependency on opencode-platform; usable by any OpenCode
  user.** It reads only stock OpenCode data (`api.json`/`catalog.json`, the
  `/zen/go/v1/usage` + `auth.json` APIs, `~/.local/share/opencode/opencode.db`,
  and project `.opencode/opencode.json` files). It does not rely on the
  platform's `bus.js`, `npm run budget`, or `cost-tracker.js`.
- Provider of interest: `opencode-go` (base URL `https://opencode.ai/zen/go/v1`).
- Targets OpenCode v2 (the beta that exposes the `model.request` session hook).
- Platform-agnostic: lives in `~/.config/opencode/scripts` and as a plugin
  alongside the existing `caveman` / `ponytail` plugins.

## Usage

A standalone Node.js CLI (CommonJS). It has **no dependency on opencode-platform**
and works for any OpenCode user. It only reads stock OpenCode data
(`api.json`, the `/zen/go/v1/usage` API, `auth.json`, and project
`.opencode/opencode.json` files) and never rewrites or blocks a model request.

### Install

```bash
git clone <repo> && cd model-budget-guard
# Optional: desktop notifications (macOS/Windows/Linux)
npm i node-notifier
```

The default run path uses only Node.js built-ins (global `fetch`, `fs`, `path`,
`os`), so it works with **no** `npm install` and no external packages. Desktop
notifications are lazily required inside a `try/catch`, so they're silently
skipped unless `node-notifier` is installed **and** `delivery.desktop` is enabled.

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

### Config knobs

Create a `config.json` in the repo root to override any default. Merged over
built-in defaults; missing keys keep their default value.

```jsonc
{
  "thresholds": { "warning": 80, "critical": 95 },          // usage % levels
  "cadenceMs": {
    "usage": 300000,     // usage/quota poll (5 min)
    "pricing": 1800000,  // pricing catalog poll (30 min)
    "atom": 1800000,     // (reserved)
    "db": 600000,        // config-scan poll (10 min)
    "releases": 86400000 // (reserved, daily)
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
