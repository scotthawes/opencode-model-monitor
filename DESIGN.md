# Design

The system has five components. The central insight is that **the only thing
that changes model selection is the operator** — this service observes and
reports, it never rewrites a request. Two boxes below
(`budget-guard` plugin and `model-select` policy) are shown only as
**FUTURE / DEFERRED**: they are not implemented now and may never be.

```
┌──────────────────────────────────────────────────────────────┐
│  price-watch.js  ──►  price history  ──►  alerts (bus)        │
│  budget.json     (allowance definition, user-specific)        │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  budget-service (MONITORING daemon)                            │
│   • aggregates spend from opencode.db (read-only)             │
│   • computes OK/WARNING/CRITICAL/EXHAUSTED per window         │
│   • publishes STATE to bus  ◄── single source of truth         │
│   • reports / alerts — no reservations, no control             │
└──────────────────────────────────────────────────────────────┘
        │ (report only — NO check)       │ (report only — NO pick)
        ▼                                ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│ budget-guard plugin  │   │ model-select policy               │
│ ★ FUTURE / DEFERRED │   │ ★ FUTURE / DEFERRED               │
│  (model.request hook)│   │  (tier × budget → model)          │
│  • was: downgrade    │   │  + override allowlist             │
│    to hy3 / free     │   │  was consulted by orchestrator    │
│  • NOT active now    │   │  before every delegation          │
│    — monitoring only │   │  • NOT active now — monitoring     │
└──────────────────────┘   └──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ config-audit (REPORT-ONLY) ──► flags pins that cost more       │
│ npm run budget ──► dashboard (spend vs caps, per-model $/1M)  │
└──────────────────────────────────────────────────────────────┘
```

**Nothing in this system rewrites model selection.** The `budget-guard` plugin
and `model-select` policy are displayed only to mark where a future control
phase *could* attach; they are currently inert.

## 1. Source of truth

- **`price-watch.js`** — fetches `https://models.opencode.ai/api.json`, extracts
  the `opencode-go.models.*.cost` subtree (input/output/cache_read/cache_write +
  context-window `tiers`), writes a dated snapshot to
  `~/.config/opencode/price-history/`, diffs vs the previous snapshot, and alerts
  via `bus.js` on any price change / new / removed model.
- **`budget.json`** (new, user-specific) — declares the plan and caps per window
  (e.g. `$12/5h`, `$30/week`, `$60/month` for the Go plan — confirm actual
  numbers) plus the free-tier fallback models, plus optional expected caps for
  cross-checking the usage API. The actual enforced caps now come from the
  /zen/go/v1/usage API (see FEEDS.md #5), so this file is policy, not the
  source of truth for limits.

## 2. Monitoring meter → `budget-service` daemon

A long-running **monitoring** service (not a per-request script) that:

- **Authoritative quota from the usage API** — polls
  `GET https://opencode.ai/zen/go/v1/usage` (Bearer key from `auth.json`,
  cached ~5 min) for the server-enforced Go quota per window
  (`rolling` / `weekly` / `monthly` `percent` + `resetsAt`). This is
  cross-device and matches what opencode.ai actually enforces — the local DB
  cannot see other machines' spend (see FEEDS.md #5). This is read-only
  observation; the service never acts on the quota.
- **Supplementary detail from `opencode.db`**
  (`~/.local/share/opencode/opencode.db`, `session` table) for per-model /
  per-agent cost breakdown and history on this machine.
- Reads **only** — it never holds reservations, never approves/denies, never
  rewrites anything. There are no in-flight reservations (the concurrency
  blind spot, GAPS #1, is *deferred* to the future control phase rather than
  solved here).
- Computes state per window for **reporting**: `OK → WARNING (>80%) →
  CRITICAL (>95%) → EXHAUSTED (≥100%)`, preferring the API `percent` when
  available and falling back to locally-aggregated spend otherwise.
- **Publishes state to the bus** so dashboards, logs, and alerts observe one
  truth (no racing copies).
- **Reports / alerts** — emits bus events and log lines when thresholds are
  crossed. It does *not* expose a hook check or take any action on the
  session.

Rationale for a daemon vs a script: polling the usage API and aggregating
`opencode.db` on a schedule (cached ~5 min) keeps the dashboard and alerts
cheap, and avoids repeatedly hitting the API / sqlite from the user's shell.
The service is purely a cache + publisher.

## 3. Enforcement — `budget-guard` plugin ( ★ FUTURE / DEFERRED ★ )

> **Not implemented. This service is monitoring-only and does not intervene in
> any running session.** The box is documented only to mark where a future
> control phase *could* attach.

OpenCode v2 exposes a `model.request` session hook (same surface `caveman` /
`ponytail` use). A future enforcement plugin would intercept model requests and
rewrite based on budget state:

- `CRITICAL` → downgrade the requested model to `hy3`.
- `EXHAUSTED` → rewrite to a **free-tier** model, switching the *provider
  prefix* to `opencode` (Zen) and verifying usability (GAPS #2).
- Log every override to the bus for explainability (GAPS #12).

This is deferred — for now the service only *reports* that a session is
CRITICAL/EXHAUSTED; it never changes what model a session uses.

## 4. Smart selection ( ★ FUTURE / DEFERRED ★ )

> **Not implemented. Routing/selection is out of scope for the monitoring phase.**

- **Routing policy (`model-select`)** — a future tier→model table (reusing the
  existing `cost-tracker` tiers: budget / coding / reasoning / premium) keyed
  by budget state. Default cheap (`hy3`); escalate to `qwen3.7-max` /
  `deepseek-v4-pro` / `minimax-m3` only when the task needs it **and** budget
  allows. Would be consulted by the orchestrator before every delegation
  (GAPS #3).
- **Override allowlist** — so a future guard doesn't fight deliberate premium
  use: an explicit `@premium` flag or per-task allowlist bypasses downgrade
  (GAPS #4).
- **Config audit (REPORT-ONLY — active)** — scans every
  `.opencode/opencode.json`, lists each agent's pinned model with its $/1M
  and multiplier vs `hy3`, and **flags** pins that are expensive (e.g.
  `graphics-programmer → qwen3.7-plus`). This is the *reporting* layer only:
  it surfaces information and suggestions; it does **not** auto-PR fixes or
  change any pin. (See GAPS.md — control gaps #1–#4 are deferred; #5–#12 still
  matter for monitoring accuracy.)

## 5. Visibility & alerts

- **Alerts on model change.** Whenever a model changes — price change, new model
  added, model removed, or a tier/context-window price change — an alert is sent
  (bus event + log; surfaced on the dashboard). Driven by `price-watch` diffing
  `api.json`, cross-checked against the GitHub `go.mdx` / `zen.mdx` Atom feeds.
- **Report all allowances / quotas.** The service surfaces *every* allowance and
  quota dimension it can observe, not just one: Go-plan `rolling` / `weekly` /
  `monthly` quota (`percent`, `status`, `resetsAt` from `/zen/go/v1/usage`);
  per-model and per-agent spend (local `opencode.db`); config pins with
  USD-per-1M cost and multiplier vs `hy3` (report-only); free-tier model
  availability; and a pricing-catalog snapshot. Nothing is hidden behind a control
  action.
- `npm run budget` — dashboard: spend vs caps (5h/week/month), per-model USD-per-1M,
  top-cost agents, recommended actions.
- `bus.js` alerts on: WARNING / CRITICAL / EXHAUSTED (quota reporting only),
  model changes, expensive config pins.

## Key design decision carried from gap analysis

The original "script + hook" enforcement shape was reframed into a
**`budget-service` monitoring daemon** as the backbone. The daemon's job is to
poll the usage API + `opencode.db`, publish state to the bus, and report/alert.
The control pieces that the original design attached to it — in-flight
reservations (#1), free-tier provider switch (#2), where selection fires (#3),
override allowlist (#4) — are **deferred** to a future phase, if ever.

The monitoring daemon still benefits from correct window semantics (#5),
context-tier awareness (#6), cache pricing (#7), multi-DB handling (#8), and a
cheap cached poll instead of a per-request query (#9). Components 1 (`price-watch`)
and 5 (visibility/alerts) are the core active pieces; component 4 (`config-audit`)
is active but **report-only**.
