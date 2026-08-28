# Implementation plan

Broken into tasks. Each is a unit that completes in 1–2 sessions. Follows the
project GitHub workflow (issue → branch → PR → merge on green; no force-push).

## Phase 0 — Repo & scaffolding
- [ ] Public repo `model-budget-guard` (this repo).
- [ ] `package.json` with scripts: `price-watch`, `budget`, `config-audit`.
- [ ] Directory layout: `scripts/`, `plugins/`, `price-history/`.

## Phase 1 — Source of truth
- [ ] **`price-watch.js`** — fetch `api.json`, snapshot `opencode-go` costs,
      diff, alert via bus. (Closes PRICING primary source.)
- [ ] **`budget.json`** schema + loader — plan, caps per window, free-tier
      fallback list. (User supplies actual numbers.)

## Phase 2 — Budget meter / monitoring service
- [ ] **`budget-service` daemon (monitoring)** — poll `/zen/go/v1/usage` for
      quota + aggregate `opencode.db` spend over rolling windows (read-only);
      OK/WARNING/CRITICAL/EXHAUSTED state; publish state to bus; report/alert.
      **No in-flight reservations, no local check endpoint, no control.** (Closes
      #5, #6, #7, #8, #9 for monitoring accuracy.)
- [ ] Confirm DB topology (single shared vs many) before finalizing.

## Phase 3 — Enforcement ( ★ FUTURE / DEFERRED ★ )
> Not built in the monitoring phase. The system does not intervene in sessions.
- [ ] **`budget-guard` plugin** (`model.request` hook) — would thin-check the
      service; downgrade to `hy3` at CRITICAL; switch to free-tier provider at
      EXHAUSTED; log overrides to bus. **Deferred** (was #2).
- [ ] **Override allowlist** — `@premium` / per-task bypass. **Deferred** (was #4).

## Phase 4 — Smart selection (model-select DEFERRED) / Config audit (REPORT-ONLY)
- [ ] **`model-select` policy** — tier×budget→model table derived from live
      catalog; consulted by orchestrator before every delegation. **DEFERRED**
      (was #3) — selection is not altered in the monitoring phase.
- [ ] **Config audit (REPORT-ONLY)** — scan `.opencode/opencode.json`, flag
      costly pins, suggest fixes in a report. Does **not** auto-PR or change
      pins. (Active; the *reporting* half of the original #3.)

## Phase 5 — Visibility & hardening
- [ ] **`npm run budget`** dashboard.
- [ ] **Dry-run / audit mode** + tests. (Closes #10.)
- [ ] **Source-down fallback** to last snapshot. (Closes #11.)
- [ ] **Dynamic tiers** from catalog (drop `cost-tracker.js` hardcoded list).
      (Closes #12.)
- [ ] Optional: `zen.mdx` / `go.mdx` git-history watcher for discount notes.

## Open questions (monitoring thresholds / alerting, not control)
1. Actual allowance numbers & windows (confirm Go plan caps or custom) — *for
   setting alert thresholds.*
2. At what `percent` should WARNING / CRITICAL alerts fire (default 80% / 95%)?
3. Alert delivery: bus only, logs, dashboard, or all three?
4. Policy ceiling — report any agent pin above a $/1M threshold (e.g. vs `hy3`)?
