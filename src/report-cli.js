'use strict';

const fs = require('fs');
const path = require('path');

const stateDir = path.join(__dirname, '..', 'state');
const mdPath = path.join(stateDir, 'report.md');
const jsonPath = path.join(stateDir, 'report.json');

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
