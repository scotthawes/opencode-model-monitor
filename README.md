# model-budget-guard

A **passive monitoring microservice** for OpenCode hosted models — the
`opencode-go` ("Go") provider on `opencode.ai`. It observes and reports; it
does **not** intercept, rewrite, downgrade, or block any model request.

## Goal

**Monitor** OpenCode hosted models (pricing, quota/usage, config pins, spend)
and surface **alerts/reports** — observation only, no control. The service:

1. Polls the documented data feeds (see `FEEDS.md`) for model pricing and price
   changes, usage/quota via the `/zen/go/v1/usage` API, agent model pins across
   project `.opencode/opencode.json` files, and local spend from `opencode.db`.
2. Reports and alerts via the bus, logs, and/or a dashboard.
3. **Does not** intercept or rewrite model requests, downgrade/block models, or
   enforce any routing policy on the orchestrator or subagents. All control
   behavior is deferred to a future phase (if ever).

## Why this exists

- Project-level `.opencode/opencode.json` files can pin agents to models the
  operator may not realize are active. Example found in the wild:
  `graphics-programmer → opencode-go/qwen3.7-plus`, which is **~22x the cost**
  of the `hy3` default on output tokens (`$1.60` vs `$0.0725` per 1M).
- The hosted provider enforces usage caps; blowing them halts all work, so it is
  useful to *see* headroom approaching.
- Model pricing changes over time and is published by OpenCode — we want to
  track it and report on it, so the operator can notice drift.

## Status

Design / planning. Implementation not yet started. See:

- [`DESIGN.md`](DESIGN.md) — system architecture
- [`PRICING.md`](PRICING.md) — where model pricing comes from
- [`GAPS.md`](GAPS.md) — gap analysis & design adjustments
- [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — task breakdown
- [`FEEDS.md`](FEEDS.md) — data feed sources for every input

## Scope

- Provider of interest: `opencode-go` (base URL `https://opencode.ai/zen/go/v1`).
- Targets OpenCode v2 (the beta that exposes the `model.request` session hook).
- Platform-agnostic: lives in `~/.config/opencode/scripts` and as a plugin
  alongside the existing `caveman` / `ponytail` plugins.
