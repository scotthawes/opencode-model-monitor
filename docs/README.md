# Model Budget Guard — Public Pricing Snapshot

> **Optional / experimental.** This snapshot is generated from public model
> pricing data only. It contains **no** usage, quota, credentials, or local
> filesystem paths.

Generated: 2026-09-05T12:49:54.774Z

- **36** model(s) tracked
- **5** price-history sample(s)
- **70** public pricing-change event(s)

## What is published

| File | Contents |
| --- | --- |
| `index.html` | Static compare/history view (from P2-1) |
| `pricing-snapshot.json` | Latest public per-model pricing (cost / tiers / meta) |
| `history.json` | Public per-sample pricing history |
| `changelog.json` | Only `model_change` events (pricing changes) |

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
