# Pricing sources

All pricing for the `opencode-go` provider is published by OpenCode in
machine-readable and human-readable forms.

## Primary: machine-readable catalog (authoritative)

`https://models.opencode.ai/api.json`

- Keyed by provider. The `opencode-go` key has
  `"api": "https://opencode.ai/zen/go/v1"` — an **exact match** for the
  baseURL in `~/.config/opencode/opencode.json`, so its costs are the user's
  actual billed prices.
- Each model carries `cost: { input, output, cache_read, cache_write }` in
  USD per 1M tokens, plus `tiers` for context-window-based pricing.
- Example (verified live):
  - `hy3` → `{input:0.0175, output:0.0725, cache_read:0.004375}`
  - `qwen3.7-plus` → `{input:0.4, output:1.6, cache_read:0.04, cache_write:0.5,
    tiers:[{input:1.2, output:4.8, ... >256k}]}`
  - `minimax-m3` → `{input:0.3, output:1.2, cache_read:0.06, ...}`
  - `mimo-v2.5` → `{input:0.14, output:0.28, cache_read:0.0028}`
  - `deepseek-v4-pro` → `{input:0.66, output:1.98, cache_read:0.022}`
- 31 models listed under `opencode-go`.
- A parallel `opencode` (Zen) key lists the `-free` models.

## Secondary: documentation pages (human-readable)

- `https://opencode.ai/docs/zen/` — Zen (pay-as-you-go) pricing table.
- `https://opencode.ai/docs/go/` — Go ($10/mo subscription) pricing table plus
  usage limits (`$12/5h`, `$30/week`, `$60/month` — confirm against the user's
  actual plan). Temporary discounts appear only as footnotes.

## Tertiary: source-control commits (history)

In `anomalyco/opencode` (default branch `dev`):

- `packages/web/src/content/docs/zen.mdx` — published Zen pricing table.
- `packages/web/src/content/docs/go.mdx` — Go pricing table.

Watching `git log` / `git blame` on these two files reveals pricing edits and
discount notes.

**Caveat:** the open-source `internal/llm/models/models.go` does **not** contain
hosted (Zen/Go) pricing — only BYO-key providers (Anthropic, OpenAI, …). So
commit-watching must target the `.mdx` docs, not `models.go`.

## Not a price source

The OpenAI-compatible list endpoints (`https://opencode.ai/zen/go/v1/models`)
return model IDs only — **no pricing**. Don't use them for cost logic.

## Implication for the system

`price-watch.js` polls `api.json` as the authoritative source and diffs
snapshots. The `.mdx` git history is an optional secondary layer for
human-readable discount notes. The open-source `models.go` is irrelevant for
hosted pricing.
