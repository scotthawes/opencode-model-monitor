# Model Budget Guard — Public Pricing Snapshot

> **Optional / experimental.** This snapshot is generated from public model
> pricing data only. It contains **no** usage, quota, credentials, or local
> filesystem paths.

Generated: 2026-09-05T21:32:01.746Z

- **36** model(s) tracked
- **17** price-history sample(s)
- **70** public pricing-change event(s)

## Page sections (index.html)

1. **Leaderboard** — proper table: # / Model / Eff $/req / Cap / Req-mo, zebra rows,
   cheapest-effective first (green). The fastest read, shown at the top.
2. **Price graph** — output (or input) $/1M over time, one line per model. Defaults
   to the top-10 movers; type a model id/name to add any of the tracked models.
   X axis is daily ("Sep 5"), capped at ~320px, legend at the bottom. Coloring
   reflects the 30-day price direction (green = down, red = up, grey = flat).
3. **Model table** — current output/input $/1M with the 30-day delta (% / × / $) per
   model, rows colored by direction. No per-model usage is published, so usage
   coloring is intentionally N/A (price-only).
4. **Recent feed** — last 8-10 summarized price-change one-liners with change
   metric, plus a link to the full public log (`changelog.json`).

## What is published

| File | Contents |
| --- | --- |
| `index.html` | Redesigned public page: leaderboard table (top) + daily price graph (Chart.js) + 30-day-colored model table + summarized feed |
| `pricing.json` | Allowlisted page data: 30-day deltas per model, graph series, top movers, recent feed |
| `pricing-snapshot.json` | Latest public per-model pricing (cost / tiers / meta) |
| `history.json` | Public per-sample pricing history |
| `changelog.json` | Only `model_change` events (pricing changes) — linked as the "Full log" |

## Regenerate locally

```bash
node scripts/publish-snapshot.js
```

## Enable GitHub Pages (deploy is OFF by default)

The publish workflow builds this folder on every run and uploads it as a Pages
artifact, but **deployment is disabled until you opt in**:

1. Repo **Settings → Pages → Build and deployment → Source = GitHub Actions**.
2. Repo **Settings → Variables → Actions → New repository variable**: name
   `ENABLE_PAGES`, value `true`.
3. Run the **Publish snapshot (Pages)** workflow manually (`workflow_dispatch`),
   or wait for the daily schedule.

Until then the workflow only verifies the build (it never publishes anything).
