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

## Phase 2 — Budget meter / service
- [ ] **`budget-service` daemon** — aggregate `opencode.db` spend over rolling
      windows; in-flight reservations; OK/WARNING/CRITICAL/EXHAUSTED state;
      publish to bus; fast local check endpoint. (Closes #1, #5, #6, #7, #8, #9.)
- [ ] Confirm DB topology (single shared vs many) before finalizing.

## Phase 3 — Enforcement
- [ ] **`budget-guard` plugin** (`model.request` hook) — thin check against the
      service; downgrade to `hy3` at CRITICAL; switch to free-tier provider at
      EXHAUSTED; log overrides to bus. (Closes #2.)
- [ ] **Override allowlist** — `@premium` / per-task bypass. (Closes #4.)

## Phase 4 — Smart selection
- [ ] **`model-select` policy** — tier×budget→model table derived from live
      catalog; consulted by orchestrator before every delegation. (Closes #3.)
- [ ] **Config audit** — scan `.opencode/opencode.json`, flag violating pins,
      suggest/PR fixes.

## Phase 5 — Visibility & hardening
- [ ] **`npm run budget`** dashboard.
- [ ] **Dry-run / audit mode** + tests. (Closes #10.)
- [ ] **Source-down fallback** to last snapshot. (Closes #11.)
- [ ] **Dynamic tiers** from catalog (drop `cost-tracker.js` hardcoded list).
      (Closes #12.)
- [ ] Optional: `zen.mdx` / `go.mdx` git-history watcher for discount notes.

## Open questions (block Phase 1/2)
1. Actual allowance numbers & windows (confirm Go plan caps or custom).
2. Free-tier fallback acceptable when exhausted, or hard-stop?
3. Downgrade strictness at CRITICAL (silent vs alert-then-ask)?
4. Policy ceiling — cap any agent pin at a $/1M threshold unless justified?
