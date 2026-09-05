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

  // Per-window quota status (ok/warn/crit) persisted across cycles so a
  // warn/crit alert fires only ONCE per crossing (fix a).
  const quotaStatusFile = historyFile ? path.join(stateDir, 'quota-status.json') : null;
  const quotaStatus = loadQuotaStatus(quotaStatusFile);

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
    delivery.alert('warning', 'Usage fetch failed', String(e && e.message ? e.message : e), {
      dedupKey: 'usage:fetch',
      dedupTtlMs: 3600000
    });
    return { status: 'unknown', error: String(e && e.message ? e.message : e) };
  }

  if (!res.ok) {
    delivery.alert('warning', `Usage HTTP ${res.status}`, 'check your opencode-go key', {
      dedupKey: 'usage:http',
      dedupTtlMs: 3600000
    });
    return { status: 'unknown', error: `HTTP ${res.status}` };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    delivery.alert('warning', 'Usage JSON parse failed', String(e && e.message ? e.message : e), {
      dedupKey: 'usage:parse',
      dedupTtlMs: 3600000
    });
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
          'pts) (resets ' + (delivery.humanizeReset(w.resetsAt) || '?') + ')'
      );
    }

    const detail = `${pct}% used (resets ${delivery.humanizeReset(w.resetsAt) || '?'})`;
    // Crossings-only alerting (fix a): a warn/crit fires ONCE per crossing.
    // If the window's status (ok/warn/crit) is unchanged since last cycle we
    // only log at DEBUG level — no alert, no changelog, no Discord. Recovery
    // (back below warn) fires an optional info + resets the tracked status.
    const status = classifyQuota(pct, warn, crit);
    const prevStatus = quotaStatus[win] || 'unknown';
    const transition = quotaTransition(prevStatus, status);
    if (transition.alert) {
      if (transition.recovery) {
        delivery.alert(
          'info',
          `Quota ${win} recovered`,
          `${pct}% used — back below threshold (resets ${delivery.humanizeReset(w.resetsAt) || '?'})`
        );
      } else {
        delivery.alert(transition.level, `Quota ${win} ${transition.level}`, detail);
      }
    } else {
      delivery.debug(`Quota ${win} still ${status} (${pct}%) — no crossing, skipping alert`);
    }
    quotaStatus[win] = status;
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
    // Persist the crossing-tracking status alongside the time-series.
    try {
      if (quotaStatusFile) fs.writeFileSync(quotaStatusFile, JSON.stringify(quotaStatus));
    } catch (_) {
      // best effort
    }
  }

  return { status: 'ok', usage };
}

// --- Crossings-only quota status helpers (fix a) ---------------------------
//
// Best-effort load/save of the per-window status map { win: 'ok'|'warn'|'crit' }
// used to detect genuine threshold CROSSINGS (so a warn/crit alert fires once
// per crossing, not every cycle). Never throws.

function loadQuotaStatus(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function saveQuotaStatus(file, status) {
  try {
    if (file) fs.writeFileSync(file, JSON.stringify(status));
  } catch (_) {
    // best effort
  }
}

// Classify a window's percent into a coarse status for crossing detection.
function classifyQuota(pct, warn, crit) {
  if (typeof pct !== 'number' || isNaN(pct)) return 'unknown';
  if (pct >= crit) return 'crit';
  if (pct >= warn) return 'warn';
  return 'ok';
}

// Decide what to do on a status transition between cycles. Same status -> no
// alert (caller logs DEBUG). A change into warn/crit alerts at that level; a
// change back to ok (from warn/crit) is a recovery (optional info). The very
// first sighting (prev 'unknown') alerts only when there is something to say
// (warn/crit) and stays silent when nominal. Never throws.
function quotaTransition(prev, next) {
  if (prev === next) return { alert: false };
  if (prev === 'unknown') {
    if (next === 'crit') return { alert: true, level: 'critical' };
    if (next === 'warn') return { alert: true, level: 'warning' };
    return { alert: false };
  }
  if (next === 'crit') return { alert: true, level: 'critical' };
  if (next === 'warn') return { alert: true, level: 'warning' };
  // next === 'ok' -> recovery from warn/crit
  return { alert: true, level: 'info', recovery: true };
}

module.exports = { runUsage, loadQuotaStatus, saveQuotaStatus, classifyQuota, quotaTransition };
