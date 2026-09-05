'use strict';

// P2-1: lightweight static compare/history view from state/ (Closes #54).
//
// Generates a self-contained static HTML page (no deps, inline CSS/JS) that
// works from file://. It renders a sortable/filterable model table with a
// text-bar "sparkline" of the last-10 output-cost trend, plus the full
// changelog event list. Reads state/history.json + state/pricing-snapshot.json
// and state/changelog.json, and writes state/history.html (gitignored).
//
// The pure `generateHistoryHtml(history, opts)` function is exported for tests;
// the CLI entry at the bottom reads the real state files and writes the page.

const fs = require('fs');
const path = require('path');

const stateDir = path.join(__dirname, '..', 'state');

// Block chars from light -> full, used for the text-bar sparkline.
const SPARK_BARS = '▁▂▃▄▅▆▇█';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build a text-bar sparkline from an array of numbers.
//   - empty input -> '' (no data)
//   - flat input  -> all mid bars (▄)
//   - varied input-> bars scaled between min and max
// Exported for unit testing.
function sparkline(values) {
  if (!Array.isArray(values) || values.length === 0) return '';
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return nums.map(() => '▄').join('');
  return nums
    .map((v) => {
      const idx = Math.round(((v - min) / (max - min)) * (SPARK_BARS.length - 1));
      const clamped = Math.max(0, Math.min(SPARK_BARS.length - 1, idx));
      return SPARK_BARS[clamped];
    })
    .join('');
}

// Representative cost metric for a single model sample: prefer output $/1M,
// fall back to input if output is missing. Returns null when unknown.
function metricFor(model) {
  if (!model || !model.cost) return null;
  const c = model.cost;
  if (typeof c.output === 'number') return c.output;
  if (typeof c.input === 'number') return c.input;
  return null;
}

// Render the <tbody> rows of the model compare table.
function renderModelRows(history, pricing) {
  // Union of all model ids seen across samples, sorted alphabetically.
  const ids = new Set();
  for (const s of history) {
    if (s && s.models) for (const id of Object.keys(s.models)) ids.add(id);
  }
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));

  if (sorted.length === 0) {
    return '<tr><td colspan="4" class="muted">No models recorded in history.</td></tr>';
  }

  const last10 = history.slice(-10);
  const rows = [];
  for (const id of sorted) {
    const meta = (pricing && pricing[id] && pricing[id].meta) || {};
    const displayName = meta.name || id;

    // Latest known cost for this model.
    let latest = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i] && history[i].models && history[i].models[id];
      if (m) { latest = m; break; }
    }
    const latestMetric = metricFor(latest);
    const latestInput = latest && latest.cost && typeof latest.cost.input === 'number' ? latest.cost.input : null;

    // Trend = output cost across the last 10 samples where the model appears.
    const trend = last10
      .map((s) => (s && s.models && s.models[id] ? metricFor(s.models[id]) : null))
      .filter((v) => v !== null);

    const bars = sparkline(trend);
    const trendCell = bars
      ? `${esc(bars)} <span class="muted">(${trend.length})</span>`
      : '<span class="muted">—</span>';

    rows.push(
      `<tr data-id="${esc(id)}">` +
        `<td class="model"><code>${esc(displayName)}</code></td>` +
        `<td class="mono">${latestInput === null ? '—' : '$' + latestInput.toFixed(4)}</td>` +
        `<td class="mono">${latestMetric === null ? '—' : '$' + latestMetric.toFixed(4)}</td>` +
        `<td class="spark">${trendCell}</td>` +
      `</tr>`
    );
  }
  return rows.join('\n');
}

// Render the changelog event list.
function renderEvents(changelog) {
  if (!Array.isArray(changelog) || changelog.length === 0) {
    return '<tr><td colspan="4" class="muted">No changelog events.</td></tr>';
  }
  const rows = changelog
    .slice()
    .reverse()
    .map((e) => {
      const ts = e && e.ts ? e.ts : '';
      const level = e && e.level ? e.level : 'info';
      const title = e && e.title ? e.title : '';
      const message = e && e.message ? e.message : '';
      return (
        `<tr class="lvl-${esc(level)}">` +
          `<td class="mono">${esc(ts)}</td>` +
          `<td class="lvl">${esc(level)}</td>` +
          `<td>${esc(title)}</td>` +
          `<td>${esc(message)}</td>` +
        `</tr>`
      );
    });
  return rows.join('\n');
}

// Pure generator. Returns a full HTML document string.
//   history   : array of { ts, models: { id: { cost, tiers } } }
//   opts.pricing   : pricing-snapshot map (id -> { meta, cost, ... })
//   opts.changelog : array of { ts, level, title, message }
//   opts.generatedAt : ISO timestamp string (defaults to now)
function generateHistoryHtml(history, opts) {
  const o = opts || {};
  const hist = Array.isArray(history) ? history : [];
  const pricing = o.pricing && typeof o.pricing === 'object' ? o.pricing : {};
  const changelog = Array.isArray(o.changelog) ? o.changelog : [];
  const generatedAt = o.generatedAt || new Date().toISOString();

  const sampleCount = hist.length;
  const modelCount = (() => {
    const ids = new Set();
    for (const s of hist) if (s && s.models) for (const id of Object.keys(s.models)) ids.add(id);
    return ids.size;
  })();

  const modelRows = renderModelRows(hist, pricing);
  const eventRows = renderEvents(changelog);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model Budget Guard — Price History</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         margin: 0; padding: 1.5rem; max-width: 980px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 1.8rem 0 .5rem; border-bottom: 1px solid #ccc; padding-bottom: .25rem; }
  .sub { color: #888; margin: 0 0 1rem; }
  #filter { width: 100%; box-sizing: border-box; padding: .5rem; margin: .5rem 0 1rem;
            border: 1px solid #aaa; border-radius: 6px; font-size: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: #666; }
  .mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .mono { white-space: nowrap; }
  .spark { font-size: 1.1rem; letter-spacing: .08em; white-space: nowrap; }
  .muted { color: #999; }
  .model code { font-weight: 600; }
  .lvl-warning td.lvl { color: #b8860b; font-weight: 600; }
  .lvl-model_change td.lvl { color: #2a7; font-weight: 600; }
  .lvl-error td.lvl { color: #c33; font-weight: 600; }
  tr.hidden { display: none; }
  footer { margin-top: 2rem; color: #888; font-size: .8rem; }
</style>
</head>
<body>
<header>
  <h1>Model Budget Guard — Price History</h1>
  <p class="sub">Generated ${esc(generatedAt)} · ${sampleCount} sample(s) · ${modelCount} model(s) tracked</p>
</header>

<section id="compare">
  <h2>Model compare — last-10 output-cost trend</h2>
  <input id="filter" type="search" placeholder="Filter models…" aria-label="Filter models">
  <table>
    <thead>
      <tr><th>Model</th><th>Input $/1M</th><th>Output $/1M</th><th>Trend (text bars)</th></tr>
    </thead>
    <tbody>
${modelRows}
    </tbody>
  </table>
</section>

<section id="events">
  <h2>Changelog events</h2>
  <table>
    <thead>
      <tr><th>Timestamp</th><th>Level</th><th>Title</th><th>Message</th></tr>
    </thead>
    <tbody>
${eventRows}
    </tbody>
  </table>
</section>

<footer>Static view — open directly from disk (file://). Regenerate with <code>npm run history:html</code>.</footer>

<script>
  (function () {
    var f = document.getElementById('filter');
    if (!f) return;
    f.addEventListener('input', function () {
      var q = f.value.trim().toLowerCase();
      var rows = document.querySelectorAll('#compare tbody tr');
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i].getAttribute('data-id') || '';
        var text = rows[i].textContent.toLowerCase();
        var match = !q || id.toLowerCase().indexOf(q) !== -1 || text.indexOf(q) !== -1;
        rows[i].classList.toggle('hidden', !match);
      }
    });
  })();
</script>
</body>
</html>
`;
}

// ---- CLI entry -----------------------------------------------------------

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
  } catch (_) {
    return null;
  }
}

function main() {
  const history = readJsonSafe('history.json') || [];
  const pricing = readJsonSafe('pricing-snapshot.json') || {};
  const changelog = readJsonSafe('changelog.json') || [];

  if (!Array.isArray(history) || history.length === 0) {
    console.error('No price history found (state/history.json empty/missing).');
    // Still emit a minimal page so the artifact always exists and is valid.
  }

  const html = generateHistoryHtml(history, {
    pricing,
    changelog,
    generatedAt: new Date().toISOString()
  });

  const out = path.join(stateDir, 'history.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log(`Wrote ${out} (${history.length} sample(s), ${Object.keys(pricing).length} pricing entry/ies, ${changelog.length} event(s)).`);
}

// Export for tests; run CLI only when executed directly.
module.exports = { generateHistoryHtml, sparkline, esc, metricFor };

if (require.main === module) {
  main();
}
