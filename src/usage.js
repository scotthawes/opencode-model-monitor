'use strict';

const fs = require('fs');
const delivery = require('./delivery');

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

// Reads the opencode-go API key from auth.json (defensively), then polls the
// server-enforced usage/quota endpoint. Returns { status, usage, error }.
async function runUsage(authJsonPath, thresholds) {
  let key = null;
  try {
    const raw = fs.readFileSync(authJsonPath, 'utf8');
    const d = JSON.parse(raw);
    let entry = d && d['opencode-go'];
    if (!entry || !entry.key) {
      // Fallback: any key named like opencode-go* that carries a .key.
      for (const k of Object.keys(d || {})) {
        if (/^opencode-go/.test(k) && d[k] && d[k].key) {
          entry = d[k];
          break;
        }
      }
    }
    key = entry && entry.key ? entry.key : null;
  } catch (e) {
    delivery.alert('warning', 'Could not read auth.json', String(e && e.message ? e.message : e));
    return { status: 'unknown', error: 'no key' };
  }

  if (!key) {
    return { status: 'unknown', error: 'no key' };
  }

  let res;
  try {
    res = await fetch(USAGE_URL, { headers: { Authorization: 'Bearer ' + key } });
  } catch (e) {
    delivery.alert('warning', 'Usage fetch failed', String(e && e.message ? e.message : e));
    return { status: 'unknown', error: String(e && e.message ? e.message : e) };
  }

  if (!res.ok) {
    delivery.alert('warning', `Usage HTTP ${res.status}`, 'check your opencode-go key');
    return { status: 'unknown', error: `HTTP ${res.status}` };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    delivery.alert('warning', 'Usage JSON parse failed', String(e && e.message ? e.message : e));
    return { status: 'unknown', error: 'parse' };
  }

  const usage = data && data.usage ? data.usage : null;
  if (!usage) return { status: 'unknown', error: 'no usage field' };

  const warn = thresholds && typeof thresholds.warning === 'number' ? thresholds.warning : 80;
  const crit = thresholds && typeof thresholds.critical === 'number' ? thresholds.critical : 95;

  for (const win of ['rolling', 'weekly', 'monthly']) {
    const w = usage[win];
    if (!w) continue;
    const pct = typeof w.percent === 'number' ? w.percent : null;
    if (pct == null) continue;
    const detail = `${pct}% used (resets ${w.resetsAt || '?'})`;
    if (pct >= crit) {
      delivery.alert('critical', `Quota ${win} critical`, detail);
    } else if (pct >= warn) {
      delivery.alert('warning', `Quota ${win} warning`, detail);
    }
  }

  return { status: 'ok', usage };
}

module.exports = { runUsage };
