'use strict';

const fs = require('fs');
const path = require('path');

const events = require('./events'); // v0.8.0: event-sourced history (JSONL, #73)

const stateDir = path.join(__dirname, '..', 'state');
const mdPath = path.join(stateDir, 'report.md');
const jsonPath = path.join(stateDir, 'report.json');

// `node src/report-cli.js --events <model>` prints a model's full life from the
// append-only JSONL event log (v0.8.0, #73): every add / drop / cost / tier /
// free event, ts-sorted. Falls back to scanning state/changelog.json when no
// JSONL events exist for the model yet. Best-effort, never throws.
if (process.argv.includes('--events')) {
  const idx = process.argv.indexOf('--events');
  const model = process.argv[idx + 1];
  if (!model) {
    console.error('usage: node src/report-cli.js --events <model>');
    process.exit(1);
  }

  let life = events.getModelLife(stateDir, model);

  // Fallback: no JSONL events yet → scan the legacy changelog for this model.
  if (!life.length) {
    try {
      const cl = JSON.parse(fs.readFileSync(path.join(stateDir, 'changelog.json'), 'utf8'));
      if (Array.isArray(cl)) {
        for (const e of cl) {
          if (!e || e.level !== 'model_change') continue;
          // Parse the changelog message into an event-shaped record.
          const parsed = parseChangelogLineForModel(e.message || '', model);
          if (parsed) life.push({ ts: e.ts, type: parsed.type, model, old: parsed.old, new: parsed.new, _source: 'changelog' });
        }
      }
    } catch (_) {}
    life.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  if (!life.length) {
    console.log(`No events recorded yet for "${model}".`);
    process.exit(0);
  }

  const typeLabel = {
    added: 'ADDED',
    removed: 'DROPPED',
    'cost-changed': 'COST',
    'tiers-changed': 'TIERS',
    'free-available': 'FREE+',
    'free-changed': 'FREE~',
    'free-removed': 'FREE-'
  };

  console.log(`Model life for "${model}" — ${life.length} event(s):\n`);
  for (const ev of life) {
    const tag = typeLabel[ev.type] || ev.type;
    let detail = '';
    if (ev.type === 'cost-changed') {
      detail = `  ${JSON.stringify(ev.old)} -> ${JSON.stringify(ev.new)}`;
    } else if (ev.type === 'added' || ev.type === 'free-available') {
      detail = `  new cost ${JSON.stringify(ev.new)}`;
    } else if (ev.type === 'removed' || ev.type === 'free-removed') {
      detail = `  last cost ${JSON.stringify(ev.old)}`;
    } else if (ev.type === 'tiers-changed') {
      detail = `  tiers ${JSON.stringify(ev.old)} -> ${JSON.stringify(ev.new)}`;
    } else if (ev.type === 'free-changed') {
      detail = `  ${JSON.stringify(ev.old)} -> ${JSON.stringify(ev.new)}`;
    }
    const src = ev._source === 'changelog' ? '  (from changelog)' : '';
    console.log(`- [${tag}] ${ev.ts}${detail}${src}`);
  }
  process.exit(0);
}

// Helper: pull a single model's pricing event out of a changelog message line,
// or null if the line is not a pricing event for `model` (e.g. a feed update).
function parseChangelogLineForModel(msg, model) {
  let m;
  if ((m = /^Cost changed for (\S+): ([\s\S]*) -> ([\s\S]*)$/.exec(msg))) {
    if (m[1] !== model) return null;
    let oldC = null;
    let newC = null;
    try { oldC = JSON.parse(m[2]); } catch (_) {}
    try { newC = JSON.parse(m[3]); } catch (_) {}
    return { type: 'cost-changed', old: oldC, new: newC };
  }
  if ((m = /^Added model: (\S+)$/.exec(msg))) {
    if (m[1] !== model) return null;
    return { type: 'added', old: null, new: null };
  }
  if ((m = /^Removed model: (\S+)$/.exec(msg))) {
    if (m[1] !== model) return null;
    return { type: 'removed', old: null, new: null };
  }
  if ((m = /^Tiers changed for (\S+)$/.exec(msg))) {
    if (m[1] !== model) return null;
    return { type: 'tiers-changed', old: null, new: null };
  }
  if ((m = /^Free model (available|changed|removed): (\S+)$/.exec(msg))) {
    if (m[2] !== model) return null;
    const map = { available: 'free-available', changed: 'free-changed', removed: 'free-removed' };
    return { type: map[m[1]], old: null, new: null };
  }
  return null;
}

// `node src/report-cli.js --history [N]` prints the last N pricing time-series
// samples (default 10) from state/history.json. Best-effort, never throws.
if (process.argv.includes('--history')) {
  let n = 10;
  const idx = process.argv.indexOf('--history');
  const raw = process.argv[idx + 1];
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) n = Math.floor(num);

  let history = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'history.json'), 'utf8'));
    if (Array.isArray(parsed)) history = parsed;
  } catch (_) {}

  if (!history.length) {
    console.log('No price history yet — run `npm run monitor:once` a few times.');
    process.exit(0);
  }

  const recent = history.slice(-n).reverse();
  console.log(`Price history: ${history.length} sample(s) total, showing last ${recent.length}:\n`);
  for (const s of recent) {
    const ids = Object.keys(s.models || {});
    console.log(`- ${s.ts} — ${ids.length} model(s)`);
    for (const id of ids.slice(0, 8)) {
      const m = s.models[id] || {};
      console.log(`    ${id}: cost=${JSON.stringify(m.cost || {})} tiers=${JSON.stringify(m.tiers || null)}`);
    }
    if (ids.length > 8) console.log(`    … +${ids.length - 8} more`);
  }
  process.exit(0);
}

if (fs.existsSync(mdPath)) {
  console.log(fs.readFileSync(mdPath, 'utf8'));
} else if (fs.existsSync(jsonPath)) {
  console.log(fs.readFileSync(jsonPath, 'utf8'));
} else {
  console.log('No report yet — run `npm run monitor:once`');
}
