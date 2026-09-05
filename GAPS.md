# Gap analysis

Stress-test of the original "script + hook" design. Severity: **[CRIT]**
would break the core promise, **[MED]** degrades correctness/robustness,
**[LOW]** hardening.

> ## Scope note — control gaps are DEFERRED
>
> This project is now a **monitoring-only** microservice: it observes and reports
> on OpenCode hosted models but never intercepts, rewrites, downgrades, or blocks
> any request. As a result, the **control-related gaps are deferred** (not
> solved, simply out of scope for now):
>
> - **#1 in-flight reservations** — no reservations held; nothing to reserve
>   against. Deferred to a future control phase.
> - **#2 free-tier provider switch** — no rewriting of model/provider. Deferred.
> - **#3 where selection fires** — selection is never altered, so there is no
>   "where it fires" question. Deferred.
> - **#4 override allowlist** — no downgrade to override, so no allowlist needed.
>   Deferred.
>
> The remaining gaps stay relevant — but as **monitoring-accuracy** concerns,
> not enforcement: **#5 window semantics**, **#6 context tiers**, **#7 cache
> pricing**, **#8 multi-DB**, **#9 latency** (polling cost), **#10 dry-run/tests**,
> **#11 source-down**, **#12 hardcoded tiers**.

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

**12. Hardcoded tier list [LOW]**
Its model→tier list is static and rots as models change. Derive tiers from the
live catalog.

## Design adjustment

Replace the stateless "script + hook" with a **`budget-service` daemon** that:
aggregates spend from the DB (+ multiple DBs if needed) + holds in-flight
reservations; publishes state to its log / notifier / report file (one truth, no
racing); exposes a
fast local check the thin hook calls to reserve/approve/downgrade; handles
provider-switch to free-tier and context-window tiers.

This single change closes #1, #2, #5–#9. #3–#4 are policy/workflow
(orchestrator consults `model-select`; add override allowlist). #10–#12 are
hardening.

## Metadata follow-ups (P0-2, issue #48)

`pricing-snapshot.json` now carries `meta` per model (capabilities, context
window `limit`, provider npm, open_weights, knowledge) parsed from `api.json`.
Two fields are **not** available in `api.json` and are intentionally out of scope
for the v0.5.x cycle so the monitor never blocks on an external scrape:

- **privacy** (e.g. training-data / zero-retention guarantees)
- **training** data cutoff beyond the coarse `knowledge` date

*Follow-up:* best-effort enrichment from **models.dev** structured data
(timeout 10s, 24h cache in `state/`, never block the cycle, never fail hard).
This is tracked separately and does not gate the api.json-only metadata ship.

## Event-sourced history (v0.8.0, #73)

History moved from a derived snapshot/changelog to an **append-only JSONL event
log** (`state/events-YYYY-MM.jsonl`) as the source of truth. Decision + why:

- **Flexibility for add / drop / change.** A snapshot only ever answers "what is
  the model's current cost?" — it cannot record *when* a model appeared or
  vanished. The event log treats an add, a drop, and a reprice as equal
  first-class facts, so questions like "list everything that was dropped" become
  a single `jq` filter instead of diffing two snapshots.
- **No rewrite cost.** The old `changelog.json` was a capped array rewritten
  every cycle (and pruned to 7 days). The JSONL log is pure append — adding or
  dropping a model never re-reads or rewrites the whole history, and rotation is
  just "start a new month file".
- **`jq`-queryable.** Each line is a flat `{ ts, type, model, old, new }`
  record, so per-model life, drops, and cost timelines are trivial one-liners
  (`jq 'select(.model=="hy3")' state/events-*.jsonl`) with no custom parser.
- **Backward compatibility.** `changelog.json` is still written this version
  (dual-write) so existing readers (digest, history view) keep working; the read
  path prefers the event log and falls back to the changelog. The legacy
  changelog is migrated once into the event log via `migrateFromChangelog()`
  (guarded by a `.events-migrated` marker).
- **Safe by construction.** Append is best-effort and never throws, so a failed
  write can never affect alerts or the snapshot write. `state/` is gitignored, so
  the event log (and the migration marker) are never committed.

