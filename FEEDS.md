# Feeds

Every piece of data the guardrail consumes, mapped to a concrete feed.
"Transport" is **poll** (we fetch on a schedule) or **subscribe** (a feed we
watch, e.g. Atom/RSS via a reader or cron). "Verified" means curl-tested live.

## External feeds (network)

| # | Data need | Feed | Transport | Format | Auth | Cadence | Verified |
|---|-----------|------|-----------|--------|------|---------|----------|
| 1 | Model pricing + catalog (`opencode-go` costs, tiers, cache) | `https://models.opencode.ai/api.json` | poll (ETag → 304) | JSON | none | 15–60 min | ✅ 200, ETag |
| 2 | Model metadata catalog | `https://models.opencode.ai/catalog.json` | poll (ETag → 304) | JSON | none | 15–60 min | ✅ 200, ETag |
| 3 | **Pricing-change notifications (Go plan)** | `https://github.com/anomalyco/opencode/commits/dev/packages/web/src/content/docs/go.mdx.atom` | subscribe (feed-poll) | Atom | none | 15–60 min | ✅ 200, ETag |
| 4 | **Pricing-change notifications (Zen plan)** | `https://github.com/anomalyco/opencode/commits/dev/packages/web/src/content/docs/zen.mdx.atom` | subscribe (feed-poll) | Atom | none | 15–60 min | ✅ 200, ETag |
| 5 | **Usage / quota / allowance (server-enforced, authoritative)** | `GET https://opencode.ai/zen/go/v1/usage` (header `Authorization: Bearer <opencode-go key>`) | poll | JSON | Bearer key (from `~/.local/share/opencode/auth.json`) | ~5 min (cache) | ✅ route live (401 unauth → 200 authed) |
| 6 | Model availability / liveness | `GET https://opencode.ai/zen/go/v1/models` | poll | JSON (model IDs) | none | 15–60 min | ✅ 200 |
| 7 | New-model / release announcements | `https://github.com/anomalyco/opencode/releases.atom` | subscribe (feed-poll) | Atom | none | daily | ✅ 200 |

### Notes on the key external feeds

- **#1 `api.json`** — the authoritative pricing source. Supports `If-None-Match`
  conditional GET → `304 Not Modified`, so polling is cheap. Cloudflare-cached.
  The `opencode-go` key matches our provider base URL.
- **#3 / #4 Atom feeds** — the de-facto "pricing changed" webhook. GitHub serves
  per-file commit Atom feeds with their own `ETag` (conditional GET → 304).
  These catch edits/discounts in the published tables.
- **#5 `/zen/go/v1/usage`** — **the most important new finding.** This is the
  server-side, cross-device quota source (the local SQLite DB only sees this
  machine). Confirmed live and auth-gated. Community-verified `200` payload:

  ```json
  {
    "usage": {
      "rolling":  { "status": "ok", "percent": 4, "resetsAt": "2026-08-13T16:27:38Z" },
      "weekly":   { "status": "ok", "percent": 3, "resetsAt": "2026-08-17T00:00:00Z" },
      "monthly":  { "status": "ok", "percent": 1, "resetsAt": "2026-09-13T06:06:01Z" }
    }
  }
  ```

  Returns per-window `percent` + `resetsAt` (rolling / weekly / monthly). The
  dollar-denominated variant (`usageDollars`/`limitDollars`) is a *proposal*, not
  confirmed deployed. **Not exposed via API:** credit balance (web console only)
  and historical usage from other machines — those still come from the local DB.
  Cache ~5 min. Key = the `opencode-go` entry in `~/.local/share/opencode/auth.json`.
- **#7 `releases.atom`** — machine-readable changelog; no separate blog/changelog
  RSS exists (`opencode.ai/changelog` is HTML only).

## Local feeds (filesystem / DB / monitor output)

| # | Data need | Feed | Transport | Format | Cadence | Verified |
|---|-----------|------|-----------|--------|---------|----------|
| 8 | Real spend / cost detail / history (this machine) | `~/.local/share/opencode/opencode.db` → `session` table (`cost`, `tokens_input/output/reasoning/cache_read/write`) | poll (sqlite query) | SQLite | 1–5 min | ✅ present (~9 GB) |
| 9 | Agent model pins (config) | all `.opencode/opencode.json` (global + every project) → `agent.<name>.model` | filesystem watch (fswatch/inotify) or scan | JSON | on change / 15 min | ✅ dirs exist |
| 10 | Budget policy / allowance definition | `~/.config/opencode/budget.json` (plan, caps, free-tier fallback, thresholds) | filesystem watch | JSON | on change | to be created |
| 11 | Usage API key | `~/.local/share/opencode/auth.json` → `opencode-go` | read at startup + watch | JSON | on change | ✅ present |
| 12 | Monitor output (alerts / reports) | log file (`~/.local/share/model-budget-guard/alerts.log`), desktop notification (`node-notifier`), and/or report file (`report.json` / `report.md`) | write | file / notification | realtime | bundled with project |

## Gaps / non-feeds

- **No service-status feed.** `status.opencode.ai` does not resolve;
  `opencode.statuspage.io` is Atlassian marketing, not a real board. Detect
  outages via API error codes (`401`/`429`/timeouts) and the Cloudflare-status
  proxy.
- **No SSE / webhooks / pricing RSS** from OpenCode. The two real subscribe
  mechanisms are: (a) `api.json`/`catalog.json` ETag conditional polling, and
  (b) the GitHub per-file commit Atom feeds.
- **Credit balance & cross-machine history** are not API-exposed — local DB only.

## How the system consumes these

```
api.json / catalog.json ──poll──► price-watch.js ──► price history + alerts
go.mdx / zen.mdx .atom ─subscribe► price-change alerts
releases.atom ──────────subscribe► announcement alerts

/zen/go/v1/usage ──poll(5m)──► budget-service  ◄── AUTHORITATIVE quota
opencode.db session ──poll────► budget-service  ◄── supplementary detail
budget.json / config pins ────► budget-service + config-audit

budget-service ──publish──► log / notifier / report file  ──► npm run report
```
