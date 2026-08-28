# Implementation plan

Broken into tasks. Each is a unit that completes in 1–2 sessions. Follows the
project GitHub workflow (issue → branch → PR → merge on green; no force-push).

## Phase 0 — Repo & scaffolding
- [ ] Public repo `model-budget-guard` (this repo).
- [ ] `package.json` with scripts: `price-watch`, `budget`, `config-audit`.
- [ ] Directory layout: `scripts/`, `plugins/`, `price-history/`.

## Phase 1 — Source of truth
- [ ] **`price-watch.js`** — fetch `api.json`, snapshot `opencode-go` costs,
       diff, alert via log / notifier / webhook. (Closes PRICING primary source.)
- [ ] **`budget.json`** schema + loader — plan, caps per window, free-tier
      fallback list. (User supplies actual numbers.)

## Phase 2 — Budget meter / monitoring service
- [ ] **`budget-service` daemon (monitoring)** — poll `/zen/go/v1/usage` for
      quota + aggregate `opencode.db` spend over rolling windows (read-only);
       OK/WARNING/CRITICAL/EXHAUSTED state; publish state to log / notifier / report file; report/alert.
      **No in-flight reservations, no local check endpoint, no control.** (Closes
      #5, #6, #7, #8, #9 for monitoring accuracy.)
- [ ] Confirm DB topology (single shared vs many) before finalizing.

## Phase 3 — Enforcement ( ★ FUTURE / DEFERRED ★ )
> Not built in the monitoring phase. The system does not intervene in sessions.
- [ ] **`budget-guard` plugin** (`model.request` hook) — would thin-check the
      service; downgrade to `hy3` at CRITICAL; switch to free-tier provider at
       EXHAUSTED; log overrides to the log file / report. **Deferred** (was #2).
- [ ] **Override allowlist** — `@premium` / per-task bypass. **Deferred** (was #4).

## Phase 4 — Smart selection (model-select DEFERRED) / Config audit (REPORT-ONLY)
- [ ] **`model-select` policy** — tier×budget→model table derived from live
      catalog; consulted by orchestrator before every delegation. **DEFERRED**
      (was #3) — selection is not altered in the monitoring phase.
- [ ] **Config audit (REPORT-ONLY)** — scan `.opencode/opencode.json`, flag
      costly pins, suggest fixes in a report. Does **not** auto-PR or change
      pins. (Active; the *reporting* half of the original #3.)

## Phase 5 — Visibility & hardening
- [ ] **`npm run report`** — bundled report command (reads local state; the project's
      own report, not the platform's `npm run budget`).
- [ ] **Dry-run / audit mode** + tests. (Closes #10.)
- [ ] **Source-down fallback** to last snapshot. (Closes #11.)
- [ ] **Dynamic tiers** from catalog        (drop hardcoded tier list).
      (Closes #12.)
- [ ] Optional: `zen.mdx` / `go.mdx` git-history watcher for discount notes.

## Requirements — what the monitor must answer

Derived from the monitoring-only scope (no control):

1. **Model-change alerts.** Whenever a model changes — price change, new model
   added, model removed, or a tier / context-window price change — send an alert
    (log file + notifier/webhook; surfaced on the report command). Sources: `price-watch` diff on
   `api.json`, plus the GitHub `go.mdx` / `zen.mdx` Atom feeds for published
   pricing edits.
2. **Report all allowances / quotas.** The service must surface *every* allowance
   and quota dimension it can observe, including:
   - Go-plan quota windows: `rolling` / `weekly` / `monthly` percent, status,
     resetsAt (from `/zen/go/v1/usage`).
   - Per-model and per-agent spend (local `opencode.db`).
   - Config pins: each agent's pinned model with its USD-per-1M cost and
     multiplier versus `hy3` (report-only).
   - Free-tier model availability (`opencode` provider `-free` models).
   - A pricing-catalog snapshot (current `api.json`).
3. **Status thresholds (decided):** WARNING at **80%** and CRITICAL at **95%** of
   any quota window (rolling / weekly / monthly). Reporting only — no action taken.
4. **Alert delivery (decided defaults):** enabled by default = **log file**
   (always on) + **local report file** (`report.json` / `report.md`) consumed by
   `npm run report`. Opt-in (off by default) = **stdout**, **desktop
   notification** (node-notifier, cross-platform), and **webhook** (Slack/Discord/
   custom URL). All configurable in `config.json`.
5. **Cadence (decided defaults):** usage API **~5 min**; pricing `api.json` /
   `catalog.json` **30 min**; GitHub Atom feeds **30-60 min**; local `opencode.db`
   **5-10 min**; `releases.atom` **daily**. Conditional GET (ETag) used where
   supported to keep polling cheap.
