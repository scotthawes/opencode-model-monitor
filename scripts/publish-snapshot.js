'use strict';

// P2-3: public published snapshot (Closes #56).
//
// Builds a GitHub-Pages-safe snapshot of ONLY public pricing data into docs/.
// This MUST never contain personal data: usage/quota, auth, webhooks,
// subscribers, config, or local filesystem paths. To guarantee that, every
// value written to docs/ is produced through a strict allowlist, and the
// finished output is scanned for a blocklist of personal/secret substrings
// before it is accepted. A violation throws and aborts the build.
//
// Inputs (all under state/, gitignored, never committed):
//   pricing-snapshot.json  -> public per-model pricing (cost / tiers / meta)
//   history.json           -> public per-sample pricing history
//   changelog.json         -> ONLY `model_change` events survive (pricing only)
//
// Outputs (committed to docs/, Pages source):
//   pricing-snapshot.json, history.json, changelog.json, index.html, README.md
//
// Reuses P2-1's generateHistoryHtml for the rendered page.

const fs = require('fs');
const path = require('path');

const { generateHistoryHtml } = require('../src/history-view');

const repoRoot = path.join(__dirname, '..');
const stateDir = path.join(repoRoot, 'state');
const defaultOutDir = path.join(repoRoot, 'docs');

// --- Allowlists (the ONLY fields that may be published) --------------------

const COST_FIELDS = ['input', 'output', 'cache_read', 'cache_write'];

const META_FIELDS = [
  'name',
  'family',
  'provider',
  'contextWindow',
  'outputLimit',
  'capabilities',
  'open_weights',
  'knowledge',
  'release_date',
  'last_updated'
];

// Substrings that must NEVER appear in published output (privacy guardrail).
const FORBIDDEN = [
  'auth.json',
  'config.json',
  'subscribers.json',
  'webhook',
  'subscribers',
  'secret',
  'password',
  'token',
  'gho_',
  'ghp_',
  'api_key',
  'apikey',
  'bearer ',
  '/Users/',
  '/home/',
  '/root/',
  'C:\\',
  '\\\\'
];

// --- Sanitizers -----------------------------------------------------------

function sanitizeCost(cost) {
  const out = {};
  if (cost && typeof cost === 'object') {
    for (const k of COST_FIELDS) {
      if (typeof cost[k] === 'number' && Number.isFinite(cost[k])) {
        out[k] = cost[k];
      }
    }
  }
  return out;
}

function sanitizeTiers(tiers) {
  // Tiers are public pricing tiers only. Pass through unchanged (null or array).
  return tiers == null ? null : tiers;
}

function sanitizeMeta(meta) {
  const out = {};
  if (meta && typeof meta === 'object') {
    for (const k of META_FIELDS) {
      if (meta[k] !== undefined) out[k] = meta[k];
    }
  }
  return out;
}

function sanitizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  return {
    cost: sanitizeCost(model.cost),
    tiers: sanitizeTiers(model.tiers)
  };
}

function sanitizePricingEntry(id, entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    id,
    cost: sanitizeCost(entry.cost),
    tiers: sanitizeTiers(entry.tiers),
    meta: sanitizeMeta(entry.meta)
  };
}

// Returns { map, list }: map keyed by id (for the HTML generator), list of entries.
function sanitizePricingSnapshot(snap) {
  const map = {};
  const list = [];
  if (snap && typeof snap === 'object') {
    for (const id of Object.keys(snap)) {
      const clean = sanitizePricingEntry(id, snap[id]);
      if (clean) {
        map[id] = clean;
        list.push(clean);
      }
    }
  }
  return { map, list };
}

// Public history samples: { ts, models: { id: { cost, tiers } } }.
function sanitizeHistorySample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const models = {};
  if (sample.models && typeof sample.models === 'object') {
    for (const id of Object.keys(sample.models)) {
      const m = sanitizeModel(sample.models[id]);
      if (m) models[id] = m;
    }
  }
  return { ts: typeof sample.ts === 'string' ? sample.ts : '', models };
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map(sanitizeHistorySample).filter(Boolean);
}

// Changelog: keep ONLY `model_change` events (public pricing changes).
function filterChangelog(changelog) {
  if (!Array.isArray(changelog)) return [];
  return changelog
    .filter((e) => e && e.level === 'model_change')
    .map((e) => ({
      ts: typeof e.ts === 'string' ? e.ts : '',
      level: 'model_change',
      title: typeof e.title === 'string' ? e.title : '',
      message: typeof e.message === 'string' ? e.message : ''
    }));
}

// --- Privacy guardrail ----------------------------------------------------

function assertNoForbidden(blob, label) {
  const lower = String(blob).toLowerCase();
  for (const needle of FORBIDDEN) {
    if (lower.includes(needle.toLowerCase())) {
      throw new Error(
        `PRIVACY VIOLATION: forbidden substring ${JSON.stringify(needle)} ` +
          `found in published ${label}. Aborting publish.`
      );
    }
  }
}

// --- Build ----------------------------------------------------------------

function readStateJson(name) {
  return readStateJsonFrom(stateDir, name);
}

function readStateJsonFrom(dir, name) {
  const file = path.join(dir, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return undefined;
  }
}

// Build docs/ from state/. Returns the list of written file paths.
// If the required pricing snapshot is absent (e.g. CI without state/), returns
// null so callers can preserve the already-committed docs/ instead.
//   outDir : where to write docs/ (default repo docs/)
//   inDir  : state/ to read from (default repo state/) — overridable for tests
function buildSnapshot(outDir, inDir) {
  const src = inDir || stateDir;
  const pricing = readStateJsonFrom(src, 'pricing-snapshot.json');
  if (pricing === undefined) {
    return null; // nothing to regenerate; keep committed docs/
  }
  const history = readStateJsonFrom(src, 'history.json');
  const changelog = readStateJsonFrom(src, 'changelog.json');

  const cleanPricing = sanitizePricingSnapshot(pricing);
  const cleanHistory = sanitizeHistory(history);
  const cleanChangelog = filterChangelog(changelog);

  const generatedAt = new Date().toISOString();
  const html = generateHistoryHtml(cleanHistory, {
    pricing: cleanPricing.map,
    changelog: cleanChangelog,
    generatedAt
  });

  fs.mkdirSync(outDir, { recursive: true });

  const files = {
    'pricing-snapshot.json': JSON.stringify(cleanPricing.list, null, 2),
    'history.json': JSON.stringify(cleanHistory, null, 2),
    'changelog.json': JSON.stringify(cleanChangelog, null, 2),
    'index.html': html,
    'README.md': buildReadme(cleanPricing.list.length, cleanHistory.length, cleanChangelog.length, generatedAt)
  };

  // Privacy guardrail: scan every byte before writing anything.
  for (const name of Object.keys(files)) {
    assertNoForbidden(files[name], name);
  }

  const written = [];
  for (const name of Object.keys(files)) {
    const full = path.join(outDir, name);
    fs.writeFileSync(full, files[name], 'utf8');
    written.push(full);
  }
  return written;
}

function buildReadme(modelCount, sampleCount, eventCount, generatedAt) {
  return `# Model Budget Guard — Public Pricing Snapshot

> **Optional / experimental.** This snapshot is generated from public model
> pricing data only. It contains **no** usage, quota, credentials, or local
> filesystem paths.

Generated: ${generatedAt}

- **${modelCount}** model(s) tracked
- **${sampleCount}** price-history sample(s)
- **${eventCount}** public pricing-change event(s)

## What is published

| File | Contents |
| --- | --- |
| \`index.html\` | Static compare/history view (from P2-1) |
| \`pricing-snapshot.json\` | Latest public per-model pricing (cost / tiers / meta) |
| \`history.json\` | Public per-sample pricing history |
| \`changelog.json\` | Only \`model_change\` events (pricing changes) |

## Regenerate locally

\`\`\`bash
node scripts/publish-snapshot.js
\`\`\`

## Enable GitHub Pages (deploy is OFF by default)

The publish workflow builds this folder on every run and uploads it as a Pages
artifact, but **deployment is disabled until you opt in**:

1. Repo **Settings → Pages → Build and deployment → Source = GitHub Actions**.
2. Repo **Settings → Variables → Actions → New repository variable**: name
   \`ENABLE_PAGES\`, value \`true\`.
3. Run the **Publish snapshot (Pages)** workflow manually (\`workflow_dispatch\`),
   or wait for the daily schedule.

Until then the workflow only verifies the build (it never publishes anything).
`;
}

// --- CLI ------------------------------------------------------------------

function main() {
  const outDir = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : defaultOutDir;

  const written = buildSnapshot(outDir);
  if (written === null) {
    console.log(
      'No state/pricing-snapshot.json found — preserving the committed docs/ ' +
        '(this is expected in CI, where live state/ is not available).'
    );
    return;
  }
  console.log(`Published ${written.length} file(s) to ${outDir}:`);
  for (const f of written) console.log('  - ' + path.relative(repoRoot, f));
}

module.exports = {
  COST_FIELDS,
  META_FIELDS,
  FORBIDDEN,
  sanitizeCost,
  sanitizeModel,
  sanitizePricingEntry,
  sanitizePricingSnapshot,
  sanitizeHistorySample,
  sanitizeHistory,
  filterChangelog,
  buildSnapshot,
  assertNoForbidden
};

if (require.main === module) {
  main();
}
