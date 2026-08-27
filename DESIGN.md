# Design

The system has five components. The central insight is that **enforcement must
happen at model-selection time via a `model.request` hook**, not just via static
config fixes — otherwise typos, project pins, and subagent spawns slip through.

```
┌──────────────────────────────────────────────────────────────┐
│  price-watch.js  ──►  price history  ──►  alerts (bus)        │
│  budget.json     (allowance definition, user-specific)        │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  budget-service (daemon)                                       │
│   • aggregates spend from opencode.db (+ reservations)         │
│   • computes OK/WARNING/CRITICAL/EXHAUSTED per window         │
│   • publishes state to bus  ◄── single source of truth         │
│   • handles in-flight reservations (concurrency)               │
└──────────────────────────────────────────────────────────────┘
        │ (thin check)                │ (smart pick at spawn)
        ▼                             ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│ budget-guard plugin  │   │ model-select policy               │
│ (model.request hook) │   │  (tier × budget → model)          │
│  • downgrade to hy3  │   │  + override allowlist             │
│  • switch to free    │   │  consulted by orchestrator        │
│    provider if broke │   │  before every delegation          │
└──────────────────────┘   └──────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ config-audit  ──► flags pins that violate policy              │
│ npm run budget ──► dashboard (spend vs caps, per-model $/1M)  │
└──────────────────────────────────────────────────────────────┘
```

## 1. Source of truth

- **`price-watch.js`** — fetches `https://models.opencode.ai/api.json`, extracts
  the `opencode-go.models.*.cost` subtree (input/output/cache_read/cache_write +
  context-window `tiers`), writes a dated snapshot to
  `~/.config/opencode/price-history/`, diffs vs the previous snapshot, and alerts
  via `bus.js` on any price change / new / removed model.
- **`budget.json`** (new, user-specific) — declares the plan and caps per window
  (e.g. `$12/5h`, `$30/week`, `$60/month` for the Go plan — confirm actual
  numbers) plus the free-tier fallback models. This is the only manually-set
  piece; everything else is derived.

## 2. Live budget meter → `budget-service` daemon

A long-running service (not a per-request script) that:

- Reads `opencode.db` (`~/.local/share/opencode/opencode.db`) for finalized
  session cost, aggregated over rolling windows (5h / week / month).
- Holds **in-flight reservations** so concurrent subagent spawns can't all see
  "budget OK" before any cost has landed (see GAPS #1).
- Computes state per window: `OK → WARNING (>80%) → CRITICAL (>95%) →
  EXHAUSTED (≥100%)`.
- **Publishes state to the bus** so every session observes one truth (no racing
  local copies).
- Exposes a fast local check (socket / file) for the thin hook to call.

Rationale for a daemon vs a script: calling sqlite on every `model.request`
adds latency to every model call, and a stateless script can't track in-flight
concurrency (GAPS #9, #1).

## 3. Enforcement — `budget-guard` plugin (`model.request` hook)

OpenCode v2 exposes a `model.request` session hook (same surface `caveman` /
`ponytail` use). The plugin intercepts **every** model request — main session and
all subagents — and rewrites it based on budget state:

- `CRITICAL` → downgrade the requested model to `hy3`.
- `EXHAUSTED` → rewrite to a **free-tier** model. Because free models
  (`hy3-free`, `mimo-v2.5-free`, `deepseek-v4-flash-free`) live on the separate
  `opencode` (Zen) provider, the rewrite must also switch the *provider prefix*,
  and the model must be verified usable (GAPS #2).
- Logs every override to the bus so the user knows *why* a model changed
  (explainability, GAPS #12).

This is what makes "stop us from using models that exhaust the allowance" real
and automatic.

## 4. Smart selection

- **Routing policy (`model-select`)** — a tier→model table (reusing the existing
  `cost-tracker` tiers: budget / coding / reasoning / premium) keyed also by
  budget state. Default cheap (`hy3`); escalate to `qwen3.7-max` /
  `deepseek-v4-pro` / `minimax-m3` only when the task needs it **and** budget
  allows. Selection must be **consulted by the orchestrator before every
  delegation** — the hook is only the backstop (GAPS #3).
- **Override allowlist** — so the guard doesn't fight deliberate premium use: an
  explicit `@premium` flag or per-task allowlist bypasses downgrade (GAPS #4).
- **Config audit** — scans every `.opencode/opencode.json`, lists each agent's
  pinned model with its $/1M and multiplier vs `hy3`, flags pins that violate
  policy (e.g. `graphics-programmer → qwen3.7-plus`), and can auto-suggest / PR
  fixes. This is the *preventive* layer; the hook is the *runtime* layer.

## 5. Visibility & alerts

- `npm run budget` — dashboard: spend vs caps (5h/week/month), per-model $/1M,
  top-cost agents, recommended actions.
- `bus.js` alerts on: WARNING / CRITICAL / EXHAUSTED, price changes,
  policy-violating pins.

## Key design decision carried from gap analysis

The original "script + hook" shape was upgraded to a **`budget-service` daemon**
as the backbone. This single change closes the concurrency blind spot (#1), the
free-tier provider switch (#2), window accuracy (#5), context-tier awareness
(#6), cache pricing (#7), the multi-DB question (#8), and the per-request
latency problem (#9).
