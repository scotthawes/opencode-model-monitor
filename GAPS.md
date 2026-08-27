# Gap analysis

Stress-test of the original "script + hook" design. Severity: **[CRIT]**
would break the core promise, **[MED]** degrades correctness/robustness,
**[LOW]** hardening.

## Critical

**1. In-flight / parallel spend is invisible to the guard [CRIT]**
The meter reads `opencode.db` only after sessions finalize. Heavy parallelism
(dozens of concurrent subagents) means many expensive spawns see "budget OK"
simultaneously before any cost lands, collectively blowing the cap mid-flight.
*Fix:* reserve budget per in-flight request before approving.

**2. Free-tier fallback requires a provider switch [CRIT]**
`*-free` models (`hy3-free`, `mimo-v2.5-free`) live on the `opencode` (Zen)
provider, not `opencode-go`. Routing to free on exhaustion must rewrite the
provider prefix and verify the model is usable (rate limits / lower context).
*Fix:* provider-switch logic in the hook.

**3. Where "smart selection" actually fires is unspecified [CRIT]**
The hook only downgrades when budget is already critical — a backstop. Real
smart selection must happen at spawn: the orchestrator consults a policy before
every delegation, choosing tier-by-task. Without a complexity→tier signal,
selection defaults to "hy3 unless pinned," wasting strong models on hard tasks.
*Fix:* mandatory `model-select` consult + complexity classifier.

**4. No override / allowlist [CRIT]**
Auto-downgrade fights the user when they deliberately want a premium model.
*Fix:* `@premium` flag / per-task allowlist bypass.

## Medium

**5. Window semantics undefined [MED]**
Rolling vs fixed windows; month/week boundaries and resets must be defined, and
real enforced caps confirmed server-side (plans can change).

**6. Context-window tiers ignored [MED]**
`api.json` `tiers` / `context_over_200k` multipliers (qwen → $4.80/out >256k).
A single long-context request can cost 3x; meter + hook must use the right tier
and treat >200k expensive requests as budget events.

**7. Cache token pricing ignored [MED]**
Real cost = input + output + `cache_read` + `cache_write`. Meter must use the
actual token breakdown, not just in/out.

**8. DB may not be a single shared source [MED]**
Multica / per-project sessions may write separate DBs; a single-meter would miss
cross-project spend. Confirm one shared `opencode.db` vs aggregate many.

**9. Per-request DB query too slow for a hook [MED]**
Shelling out to sqlite on every `model.request` adds latency. Needs a cached
state + in-flight reservations (the `budget-service` daemon).

**10. No dry-run / audit mode or tests [MED]**
A guard bug could let overspend *or* wrongly block all models (self-DoS).
Needs dry-run + tests.

**11. Source-down fallback [LOW]**
If `api.json` is unreachable, fall back to last snapshot + safe default — don't
crash or falsely block.

**12. Hardcoded tiers in `cost-tracker.js` [LOW]**
Its model→tier list is static and rots as models change. Derive tiers from the
live catalog.

## Design adjustment

Replace the stateless "script + hook" with a **`budget-service` daemon** that:
aggregates spend from the DB (+ multiple DBs if needed) + holds in-flight
reservations; publishes state to the **bus** (one truth, no racing); exposes a
fast local check the thin hook calls to reserve/approve/downgrade; handles
provider-switch to free-tier and context-window tiers.

This single change closes #1, #2, #5–#9. #3–#4 are policy/workflow
(orchestrator consults `model-select`; add override allowlist). #10–#12 are
hardening.
