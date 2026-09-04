'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

// Reads the opencode-go API key from auth.json (defensively), then polls the
// server-enforced usage/quota endpoint. Returns { status, usage, error }.
// stateDir: directory where per-window quota history is persisted so we can
// compute deltas between cycles.
async function runUsage(authJsonPath, thresholds, stateDir) {
  // Time-series quota history: an array of samples [{ts, rolling, weekly,
  // monthly}]. Kept for ~8 days so a 7-day movement window is always available.
  const historyFile = stateDir ? path.join(stateDir, 'usage-history.json') : null;
  const PRUNE_MS = 8 * 24 * 3600 * 1000;
  const MAX_SAMPLES = 5000;

  // Load best-effort. Supports the new array format, gracefully migrates the
  // old latest-only object format {rolling,weekly,monthly}, and tolerates a
  // missing/corrupt file by starting empty.
  let history = [];
  if (historyFile) {
    try {
      const raw = fs.readFileSync(historyFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        history = parsed;
      } else if (parsed && typeof parsed === 'object') {
        history = [
          {
            ts: Date.now(),
            rolling: typeof parsed.rolling === 'number' ? parsed.rolling : null,
            weekly: typeof parsed.weekly === 'number' ? parsed.weekly : null,
            monthly: typeof parsed.monthly === 'number' ? parsed.monthly : null
          }
        ];
      }
    } catch (_) {
      history = [];
    }
  }

  // Per-cycle delta is computed against the previous sample in the series (the
  // last element before we append the new one this cycle).
  const prevSample = history.length ? history[history.length - 1] : null;
  const prevPct = {};
  if (prevSample) {
    for (const win of ['rolling', 'weekly', 'monthly']) {
      if (typeof prevSample[win] === 'number') prevPct[win] = prevSample[win];
    }
  }
  const deltaThreshold =
    thresholds && typeof thresholds.quotaDeltaPct === 'number' ? thresholds.quotaDeltaPct : 5;
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
  if (!usage) {
    // Previously this returned silently — subscribers saw nothing while usage
    // silently broke. Surface it as a deduped warning so degradation is visible.
    delivery.alert('warning', 'Usage data missing', 'usage field absent in provider response', {
      dedupKey: 'usage:missing'
    });
    return { status: 'unknown', error: 'no usage field' };
  }

  const warn = thresholds && typeof thresholds.warning === 'number' ? thresholds.warning : 80;
  const crit = thresholds && typeof thresholds.critical === 'number' ? thresholds.critical : 95;

  const currentPct = {};
  for (const win of ['rolling', 'weekly', 'monthly']) {
    const w = usage[win];
    if (!w) continue;
    const pct = typeof w.percent === 'number' ? w.percent : null;
    if (pct == null) continue;
    currentPct[win] = pct;

    // Delta vs previous cycle (null on the first run / no history).
    const prev = prevPct[win] != null ? prevPct[win] : null;
    const delta = prev == null ? null : pct - prev;
    w.delta = delta;

    // Quota-delta alert: only when we have a real prior value and the move is
    // significant. Suppressed on the first run so we just record a baseline.
    if (prev != null && Math.abs(delta) >= deltaThreshold) {
      delivery.alert(
        'info',
        'Quota ' + win + ' changed',
        pct + '% used (was ' + prev + '%, ' + (delta > 0 ? '+' : '') + delta +
          'pts) (resets ' + (w.resetsAt || '?') + ')'
      );
    }

    const detail = `${pct}% used (resets ${w.resetsAt || '?'})`;
    if (pct >= crit) {
      delivery.alert('critical', `Quota ${win} critical`, detail);
    } else if (pct >= warn) {
      delivery.alert('warning', `Quota ${win} warning`, detail);
    }
  }

  // Persist the time-series: append this cycle's sample, prune anything older
  // than ~8 days, and cap the array length as a safety.
  if (historyFile) {
    try {
      const now = Date.now();
      const sample = { ts: now };
      for (const win of ['rolling', 'weekly', 'monthly']) {
        const w = usage && usage[win];
        sample[win] = w && typeof w.percent === 'number' ? w.percent : null;
      }
      history.push(sample);
      const cutoff = now - PRUNE_MS;
      history = history.filter((s) => s.ts >= cutoff);
      if (history.length > MAX_SAMPLES) history = history.slice(history.length - MAX_SAMPLES);
      fs.writeFileSync(historyFile, JSON.stringify(history));
    } catch (_) {
      // best effort
    }
  }

  return { status: 'ok', usage };
}

module.exports = { runUsage };
