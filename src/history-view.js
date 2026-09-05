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
module.exports = { generateHistoryHtml, sparkline, esc, metricFor, buildPricingData, generatePublicPage };

// ===========================================================================
// Public Pages redesign (Closes #75): price graph + summarized feed + change
// metrics. Reuses the shared change-metric helpers so the page expresses a move
// exactly like the Discord model table / digest / report.md.
// ===========================================================================

const changeMetric = require('./change-metric');

// Default 7-day window used for the page's deltas + graph X axis.
const PAGE_WINDOW_DAYS = 7;

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Reduce a changeParts() result to a plain serializable object (or a neutral
// "no data" object when the comparison is impossible).
function deltaToObj(parts) {
  if (!parts) {
    return { old: null, new: null, pct: null, mult: null, abs: null, direction: 'flat', isNew: false };
  }
  return {
    old: parts.old,
    new: parts.new,
    pct: parts.pct,
    mult: parts.mult,
    abs: parts.abs,
    direction: parts.direction,
    isNew: parts.isNew
  };
}

// Build the public page data object from price history + the pricing snapshot
// map. Returns an allowlisted, fully-serializable structure (model id + public
// name + cost numbers only — never usage/quota/auth/paths). Exported for tests.
//   history    : array of { ts, models: { id: { cost, tiers } } }
//   pricingMap : pricing-snapshot map (id -> { meta, cost, ... })
//   opts.now / opts.windowDays / opts.generatedAt (for deterministic tests)
function buildPricingData(history, pricingMap, opts) {
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.now();
  const windowDays = opts.windowDays || PAGE_WINDOW_DAYS;
  const WIN = windowDays * 864e5;
  const pricing = pricingMap && typeof pricingMap === 'object' ? pricingMap : {};

  const nameOf = (id) => {
    const m = pricing[id] && pricing[id].meta;
    return m && m.name ? m.name : id;
  };

  // Per-model time series of cost metrics, in time order.
  const seriesMap = {};
  if (Array.isArray(history)) {
    for (const s of history) {
      const t = Date.parse(s && s.ts);
      if (isNaN(t)) continue;
      if (s && s.models) {
        for (const id of Object.keys(s.models)) {
          const cost = s.models[id] && s.models[id].cost;
          if (!cost) continue;
          const pt = {
            ts: s.ts,
            t,
            output: cost.output,
            input: cost.input,
            cache_read: cost.cache_read,
            cache_write: cost.cache_write
          };
          (seriesMap[id] = seriesMap[id] || []).push(pt);
        }
      }
    }
  }

  const models = [];
  for (const id of Object.keys(seriesMap)) {
    const series = seriesMap[id];
    // Graph series restricted to the window (samples in window).
    const inWindow = series.filter((p) => now - p.t <= WIN);
    const graphSeries = (inWindow.length ? inWindow : series).map((p) => ({
      ts: p.ts,
      output: numOrNull(p.output),
      input: numOrNull(p.input),
      cache_read: numOrNull(p.cache_read),
      cache_write: numOrNull(p.cache_write)
    }));
    const latest = series[series.length - 1];
    // Reference sample ~7d ago = earliest sample still inside the window.
    let ref = series[0];
    for (const p of series) {
      if (now - p.t <= WIN) {
        ref = p;
        break;
      }
    }
    const cur = {
      output: numOrNull(latest.output),
      input: numOrNull(latest.input),
      cache_read: numOrNull(latest.cache_read),
      cache_write: numOrNull(latest.cache_write)
    };
    const deltaOut = changeMetric.changeParts(ref.output, latest.output);
    const deltaIn = changeMetric.changeParts(ref.input, latest.input);
    const direction = (deltaOut && deltaOut.direction) || (deltaIn && deltaIn.direction) || 'flat';
    models.push({
      id,
      name: nameOf(id),
      current: cur,
      delta7d: {
        output: deltaToObj(deltaOut),
        input: deltaToObj(deltaIn),
        direction
      },
      series: graphSeries
    });
  }

  // Top-10 movers by absolute output $/1M delta (fallback to input magnitude).
  const topMovers = models
    .slice()
    .sort((a, b) => Math.abs(b.delta7d.output.abs || 0) - Math.abs(a.delta7d.output.abs || 0))
    .slice(0, 10)
    .map((m) => m.id);

  // Recent feed: output $/1M changes between consecutive samples, most recent
  // first, capped at 10. Summarized one-liners (never the full log).
  const feed = [];
  for (const id of Object.keys(seriesMap)) {
    const series = seriesMap[id];
    for (let i = 1; i < series.length; i++) {
      const o = series[i - 1].output;
      const n = series[i].output;
      if (typeof o === 'number' && typeof n === 'number' && o !== n) {
        const pct = changeMetric.fmtFeedPct(o, n);
        feed.push({
          ts: series[i].ts,
          model: id,
          name: nameOf(id),
          metric: 'output',
          old: o,
          new: n,
          direction: changeMetric.directionOf(o, n),
          text: `${id} output $${changeMetric.trimNum(o)}→$${changeMetric.trimNum(n)} ${pct}`
        });
      }
    }
  }
  feed.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  return {
    generatedAt: opts.generatedAt || new Date(now).toISOString(),
    windowDays,
    models,
    topMovers,
    feed: feed.slice(0, 10)
  };
}

// Format a signed money value for the table (e.g. "$0.5800" / "—").
function fmtMoneyCell(v) {
  return v == null ? '—' : '$' + changeMetric.trimNum(v);
}

// Format a delta cell: "▲ +700% (8x, +$0.5075)" / "—" when no data.
function fmtDeltaCell(d) {
  if (!d || d.old == null || d.new == null) return '—';
  if (d.isNew) return 'new';
  const arrow = d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '■';
  return `${arrow} ${changeMetric.fmtPct(d)} (${changeMetric.fmtMult(d)}, ${changeMetric.fmtAbs(d)})`;
}

// Server-render the model table rows (escaped) with per-row direction color.
function renderPublicModelRows(data) {
  const models = data.models || [];
  if (models.length === 0) {
    return '<tr><td colspan="5" class="muted">No models recorded in history.</td></tr>';
  }
  // Sort by id for a stable table; color reflects the 7d price direction.
  const sorted = models.slice().sort((a, b) => a.id.localeCompare(b.id));
  const rows = sorted.map((m) => {
    const dir = m.delta7d && m.delta7d.direction ? m.delta7d.direction : 'flat';
    const color = changeMetric.directionColor(dir);
    return (
      `<tr class="dir-${esc(dir)}">` +
      `<td class="model"><code>${esc(m.name || m.id)}</code></td>` +
      `<td class="mono">${fmtMoneyCell(m.current && m.current.output)}</td>` +
      `<td class="mono">${fmtMoneyCell(m.current && m.current.input)}</td>` +
      `<td class="mono" style="color:${color};font-weight:600">${fmtDeltaCell(m.delta7d && m.delta7d.output)}</td>` +
      `<td class="mono" style="color:${color}">${fmtDeltaCell(m.delta7d && m.delta7d.input)}</td>` +
      `</tr>`
    );
  });
  return rows.join('\n');
}

// Server-render the summarized feed list (escaped) with per-item direction dot.
function renderPublicFeed(data) {
  const feed = data.feed || [];
  if (feed.length === 0) {
    return '<li class="muted">No recent price changes in the window.</li>';
  }
  return feed
    .map((e) => {
      const color = changeMetric.directionColor(e.direction);
      const when = e.ts ? esc(e.ts) : '';
      return (
        `<li><span class="dot" style="background:${color}"></span>` +
        `<code>${esc(e.model)}</code> ${esc(e.text.replace(/^[^ ]+ /, ''))}` +
        ` <span class="muted">(${when})</span></li>`
      );
    })
    .join('\n');
}

// Build the full redesigned public HTML document.
//   history : array of samples (see buildPricingData)
//   opts.pricing      : pricing-snapshot map (id -> { meta, cost, ... })
//   opts.generatedAt  : ISO timestamp (defaults to now)
//   opts.now          : override "now" for deterministic windowing/tests
function generatePublicPage(history, opts) {
  const o = opts || {};
  const pricing = o.pricing && typeof o.pricing === 'object' ? o.pricing : {};
  // Allow a precomputed data object (keeps docs/pricing.json + index.html in
  // sync from a single build); otherwise derive it from history on the fly.
  const data = o.data
    ? o.data
    : buildPricingData(history, pricing, { now: o.now, windowDays: o.windowDays, generatedAt: o.generatedAt });

  // Embed the data as JSON for the client-side Chart.js graph (file:// safe —
  // no fetch()). Escape '<' so a model name can never break out of the script.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  const modelRows = renderPublicModelRows(data);
  const feedItems = renderPublicFeed(data);
  const generatedAt = data.generatedAt;
  const sampleCount = (data.models || []).reduce((n, m) => n + (m.series ? m.series.length : 0), 0);
  const modelCount = data.models.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model Budget Guard — Price Graph</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         margin: 0; padding: 1.5rem; max-width: 1040px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 1.8rem 0 .5rem; border-bottom: 1px solid #ccc; padding-bottom: .25rem; }
  .sub { color: #888; margin: 0 0 1rem; }
  .controls { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; margin: .5rem 0 1rem; }
  #search { flex: 1 1 240px; padding: .5rem; border: 1px solid #aaa; border-radius: 6px; font-size: 1rem; }
  .note { color: #888; font-size: .82rem; }
  .legend { font-size: .82rem; margin: .25rem 0 .75rem; }
  .legend .sw { display: inline-block; width: .7rem; height: .7rem; border-radius: 2px; vertical-align: middle; margin: 0 .25rem 0 .75rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: #666; }
  .mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .mono { white-space: nowrap; }
  .model code { font-weight: 600; }
  .muted { color: #999; }
  .dot { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; margin-right: .4rem; vertical-align: middle; }
  #feed { list-style: none; padding-left: 0; }
  #feed li { padding: .3rem 0; border-bottom: 1px solid #eee; }
  footer { margin-top: 2rem; color: #888; font-size: .8rem; }
  a { color: #2a7ae2; }
</style>
</head>
<body>
<header>
  <h1>Model Budget Guard — Price Graph</h1>
  <p class="sub">Generated ${esc(generatedAt)} · ${sampleCount} sample(s) · ${modelCount} model(s) tracked · ${data.windowDays}-day window</p>
</header>

<section id="graph">
  <h2>Output $/1M over time</h2>
  <div class="controls">
    <label><input type="radio" name="metric" value="output" checked> Output $/1M</label>
    <label><input type="radio" name="metric" value="input"> Input $/1M</label>
    <input id="search" type="search" placeholder="Filter / add a model…" aria-label="Filter models">
  </div>
  <p class="legend">
    <span class="sw" style="background:#c0392b"></span>increased (7d)
    <span class="sw" style="background:#27ae60"></span>decreased (7d)
    <span class="sw" style="background:#95a5a6"></span>unchanged (7d)
  </p>
  <p class="note">Usage color is N/A on this public page (no per-model usage is published) — coloring reflects price change only. Default shows the top-10 movers; type a model id/name above to add it to the graph.</p>
  <canvas id="priceGraph" height="320" aria-label="Model output price over time"></canvas>
</section>

<section id="compare">
  <h2>Model table — 7-day price change</h2>
  <table>
    <thead>
      <tr><th>Model</th><th>Output $/1M</th><th>Input $/1M</th><th>Δ7d output</th><th>Δ7d input</th></tr>
    </thead>
    <tbody>
${modelRows}
    </tbody>
  </table>
</section>

<section id="feed">
  <h2>Recent price changes</h2>
  <ul id="feed">
${feedItems}
  </ul>
  <p><a href="changelog.json">Full log → changelog.json</a></p>
</section>

<footer>Static view — open directly from disk (file://). Graph data is embedded inline; no network fetch required.</footer>

<script type="application/json" id="pricing-data">${json}</script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('pricing-data').textContent);
  function dirColor(d) {
    if (d === 'up') return '#c0392b';
    if (d === 'down') return '#27ae60';
    return '#95a5a6';
  }
  // Shared label axis = union of all sample timestamps.
  var tsSet = {};
  data.models.forEach(function (m) { (m.series || []).forEach(function (p) { tsSet[p.ts] = 1; }); });
  var labels = Object.keys(tsSet).sort();
  function valAt(m, ts, metric) {
    var p = (m.series || []).filter(function (x) { return x.ts === ts; })[0];
    if (!p) return null;
    var v = p[metric];
    return typeof v === 'number' ? v : null;
  }
  var chart = null;
  function buildChart(metric) {
    var datasets = data.models.map(function (m) {
      return {
        label: m.name || m.id,
        data: labels.map(function (ts) { return valAt(m, ts, metric); }),
        borderColor: dirColor(m.delta7d.direction),
        backgroundColor: dirColor(m.delta7d.direction),
        hidden: data.topMovers.indexOf(m.id) === -1,
        spanGaps: true,
        pointRadius: 2,
        borderWidth: 2
      };
    });
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('priceGraph').getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        animation: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { ticks: { maxRotation: 45, autoSkip: true }, title: { display: true, text: 'sample time' } },
          y: { title: { display: true, text: (metric === 'output' ? 'Output $/1M' : 'Input $/1M') } }
        },
        plugins: { legend: { labels: { boxWidth: 12, filter: function (item) { return !item.hidden; } } } }
      }
    });
  }
  buildChart('output');
  document.querySelectorAll('input[name=metric]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) buildChart(r.value); });
  });
  document.getElementById('search').addEventListener('input', function () {
    var q = this.value.trim().toLowerCase();
    chart.data.datasets.forEach(function (ds, i) {
      var m = data.models[i];
      var match = q && ((m.id || '').toLowerCase().indexOf(q) !== -1 || (m.name || '').toLowerCase().indexOf(q) !== -1);
      chart.setDatasetVisibility(i, !!match || data.topMovers.indexOf(m.id) !== -1);
    });
    chart.update();
  });
})();
</script>
</body>
</html>
`;
}

if (require.main === module) {
  main();
}
