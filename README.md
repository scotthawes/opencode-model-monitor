# model-budget-guard

A **guardrail + smart-selection** system for OpenCode hosted models — the
`opencode-go` ("Go") provider on `opencode.ai`.

## Goal

1. **Hard guardrail** — never let a model selection exhaust your allowance
   (caps per 5h / week / month).
2. **Smart routing** — pick the cheapest model that can do the job, given
   current budget headroom.

## Why this exists

- Project-level `.opencode/opencode.json` files can pin agents to models the
  operator didn't realize were active. Example found in the wild:
  `graphics-programmer → opencode-go/qwen3.7-plus`, which is **~22x the cost**
  of the `hy3` default on output tokens (`$1.60` vs `$0.0725` per 1M).
- The hosted provider enforces usage caps; blowing them stops all work.
- Model pricing changes over time and is published by OpenCode — we want to
  track it and act on it.

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
