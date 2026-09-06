'use strict';

// Shared change-metric helpers used by the public page, Discord model table,
// digest, and report.md so every surface expresses a price move identically:
//   Δ% / × / $   (e.g. "+700% (8x, +$0.5075)")
// with graceful handling of a zero (or missing) old price -> "new".
//
// This module is pure and dependency-free so it can be required from the
// publish pipeline (browser-bound page data), delivery, discord-digest, and
// price-watch without pulling in any personal/secret-bearing code.

// Trim a number to at most 6 significant figures, dropping trailing zeros.
function trimNum(n) {
  if (n == null || !isFinite(n)) return '0';
  return String(parseFloat(Number(n).toPrecision(6)));
}

// --- Number-formatting rule (v0.19.0, #110) ----------------------------------
// One helper, one rule, every surface:
//   money  -> fmtMoney(v): '—' when missing, else '$' + trimNum(v)
//   factor -> trimNum(mult) + 'x' (no unrounded float artifacts)
// delivery.fmtModelCost, history-view fmtMoneyCell, discord-digest fmtNum and
// calc.fmtUsd all delegate here (or are documented equivalents) so the same
// value can never differ per surface. Dust is never hidden: tiny non-zero
// values render in full trimNum precision, never rounded to 0.
// Money cell: '—' when missing, else '$' + trimNum (e.g. '$0.5075').
function fmtMoney(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return '$' + trimNum(n);
}

// Compute raw change components between two numeric values.
// Returns null when either side is not a finite number (no comparison possible).
// When old is exactly 0 we cannot form a ratio: we mark the move as "new" when
// new is non-zero, otherwise treat it as unchanged.
function changeParts(oldV, newV) {
  if (typeof oldV !== 'number' || typeof newV !== 'number') return null;
  if (!Number.isFinite(oldV) || !Number.isFinite(newV)) return null;
  if (oldV === 0) {
    // v0.19.0 (#110): 0→0 is "no change", not "new" — render 0% / 1x / $0.
    if (newV === 0) {
      return { old: oldV, new: newV, pct: 0, mult: 1, abs: 0, isNew: false, direction: 'flat' };
    }
    const direction = newV > 0 ? 'up' : newV < 0 ? 'down' : 'flat';
    return { old: oldV, new: newV, pct: null, mult: null, abs: newV - oldV, isNew: newV !== 0, direction };
  }
  const diff = newV - oldV;
  const pct = (diff / oldV) * 100;
  const mult = newV / oldV;
  const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  return { old: oldV, new: newV, pct, mult, abs: diff, isNew: false, direction };
}

// Signed percent string: +700%, -50%, 0%, or "new" when old was zero.
function fmtPct(parts) {
  if (!parts) return '?';
  if (parts.isNew) return 'new';
  const p = parts.pct;
  const sign = p > 0 ? '+' : '';
  // Whole percent when >=10% (or <=-10%); one decimal below for precision.
  const r = Math.abs(p) >= 10 ? Math.round(p) : Math.round(p * 10) / 10;
  return sign + r + '%';
}

// Multiplier string: 8x, 0.5x, or "new".
function fmtMult(parts) {
  if (!parts) return '?';
  if (parts.isNew) return 'new';
  return Math.round(parts.mult * 100) / 100 + 'x';
}

// Absolute dollar diff: +$0.5075, -$0.5, $0.
function fmtAbs(parts) {
  if (!parts) return '?';
  const a = parts.abs;
  const sign = a > 0 ? '+' : a < 0 ? '-' : '';
  return sign + '$' + trimNum(Math.abs(a));
}

// Full combined metric for alerts / discord / digest / report:
//   "+700% (8x, +$0.5075)"   or   "new" when old was zero.
function fmtChangeMetric(oldV, newV) {
  const parts = changeParts(oldV, newV);
  if (!parts) return '';
  if (parts.isNew) return 'new';
  return `${fmtPct(parts)} (${fmtMult(parts)}, ${fmtAbs(parts)})`;
}

// Feed one-liner percent only: "(+700%)" / "(new)".
function fmtFeedPct(oldV, newV) {
  const parts = changeParts(oldV, newV);
  if (!parts) return '';
  if (parts.isNew) return '(new)';
  return `(${fmtPct(parts)})`;
}

// Direction (up/down/flat) from old->new; null when not comparable.
function directionOf(oldV, newV) {
  const parts = changeParts(oldV, newV);
  return parts ? parts.direction : null;
}

// Color for a direction: green = decreased, red = increased, grey = unchanged.
// (Price going UP is bad for the user, so it is red; a drop is green.)
function directionColor(direction) {
  if (direction === 'up') return '#c0392b'; // red — price increased
  if (direction === 'down') return '#27ae60'; // green — price decreased
  return '#95a5a6'; // grey — unchanged
}

// --- Shared quota-projection helpers (v0.16.0, #103) --------------------------
//
// warn-date math was copy-pasted across delivery.renderMarkdown (ISO dates),
// discord-digest.warnDateFor/critDateFor (human dates) with the same linear
// model: rate = delta/daysElapsed from the 7-day window, then
// daysToThreshold = (threshold - current)/rate. This module owns the single
// window constant + the pure projection core so every surface derives the same
// dates/ranks. Formatting stays at the call site (ISO vs "Sep 8"), so rendered
// output is byte-identical to before.

// Single 7-day analysis window shared by quota-movement + projection math.
// Intentionally hardcoded (not config) to match changelogRetentionDays default.
const QUOTA_WINDOW_MS = 7 * 24 * 3600 * 1000;

// Quota thresholds shared by all surfaces.
const WARN_THRESHOLD = 80;
const CRIT_THRESHOLD = 95;

// Days from now until `current` (growing at `ratePerDay` pts/day) reaches
// `threshold`. Returns null when the rate is not positive (stable/unknown),
// 0 when already at/above the threshold. Pure, never throws.
function daysToThreshold(current, ratePerDay, threshold) {
  if (typeof current !== 'number' || typeof ratePerDay !== 'number') return null;
  if (!Number.isFinite(current) || !Number.isFinite(ratePerDay)) return null;
  if (ratePerDay <= 0) return null;
  if (current >= threshold) return 0;
  return (threshold - current) / ratePerDay;
}

// ISO date (YYYY-MM-DD) `days` from `nowMs`. Pure, never throws.
function thresholdDateIso(nowMs, days) {
  return new Date(nowMs + days * 864e5).toISOString().slice(0, 10);
}

// Human date only (e.g. "Sep 8"), UTC so it never shifts across timezones.
// Same rendering the digest used inline; shared so report/digest/page agree.
function humanDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '?';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Both warn + crit projections from one windowInfo-shaped input:
//   { current, delta, daysElapsed } + nowMs + optional resetsAtIso
// Returns null when unprojectable (no data / stable), otherwise
//   { daysToWarn, daysToCrit } (0 = already at/above). Pure, never throws.
// v0.19.0 (#110): projections are BOUNDED by the known reset — a linear
// crossing that lands after resetsAt is capped at the reset horizon (with
// bounded:true) instead of promising a date in the next quota cycle, which
// the reset would invalidate.
function projectThresholds(wi, nowMs, resetsAtIso) {
  if (!wi || typeof wi.current !== 'number' || typeof wi.delta !== 'number') return null;
  const rate = wi.daysElapsed > 0 ? wi.delta / wi.daysElapsed : 0;
  let daysToWarn = daysToThreshold(wi.current, rate, WARN_THRESHOLD);
  let daysToCrit = daysToThreshold(wi.current, rate, CRIT_THRESHOLD);
  if (daysToWarn == null && daysToCrit == null) return null;
  let bounded = false;
  try {
    const resetMs = resetsAtIso != null ? Date.parse(resetsAtIso) : NaN;
    const now = nowMs != null ? nowMs : Date.now();
    if (!isNaN(resetMs) && resetMs > now) {
      const horizonDays = (resetMs - now) / 864e5;
      if (daysToWarn != null && daysToWarn > horizonDays) {
        daysToWarn = horizonDays;
        bounded = true;
      }
      if (daysToCrit != null && daysToCrit > horizonDays) {
        daysToCrit = horizonDays;
        bounded = true;
      }
    }
  } catch (_) {
    // best effort — unparseable resetsAt leaves projections unbounded
  }
  return { daysToWarn, daysToCrit, rate, bounded };
}

// --- v0.17 insight helpers (#105) ------------------------------------------------
// All pure, dependency-free, never throw. Shared by price-watch (anomaly + meta
// diffs), delivery/report (burn-rate block), digest + page (arrows + cap-upset).

// Sudden-jump anomaly: a single-poll move is anomalous when the multiplier is
// >=2x (up) or the absolute percent swing is >=50% (either direction — a 0.125x
// collapse reads as -87.5%). "new" (old 0) and non-comparable pairs are never
// anomalous. Pure, never throws.
const ANOMALY_MULT = 2;
const ANOMALY_PCT = 50;

function isAnomalousMove(oldV, newV) {
  try {
    const parts = changeParts(oldV, newV);
    if (!parts || parts.isNew) return false;
    if (parts.mult != null && parts.mult >= ANOMALY_MULT) return true;
    if (parts.pct != null && Math.abs(parts.pct) >= ANOMALY_PCT) return true;
    return false;
  } catch (_) {
    return false;
  }
}

// Pick the (old, new) pair an anomaly check applies to: prefer the output
// $/1M (the page headline metric), fall back to input when output is absent.
// Returns null when neither side is a comparable number pair.
function anomalyPair(oldCost, newCost) {
  try {
    const o = oldCost && typeof oldCost === 'object' ? oldCost : {};
    const n = newCost && typeof newCost === 'object' ? newCost : {};
    const useOutput = typeof o.output === 'number' || typeof n.output === 'number';
    const key = useOutput ? 'output' : 'input';
    if (typeof o[key] !== 'number' || typeof n[key] !== 'number') return null;
    return { key, old: o[key], new: n[key] };
  } catch (_) {
    return null;
  }
}

// One-line warning text for an anomalous move (or null when not anomalous).
//   "Anomaly: <id> moved 8x between polls (output $0.0725→$0.58 +700%)"
function anomalyText(model, oldCost, newCost) {
  try {
    const pair = anomalyPair(oldCost, newCost);
    if (!pair) return null;
    if (!isAnomalousMove(pair.old, pair.new)) return null;
    const parts = changeParts(pair.old, pair.new);
    const mult = parts && parts.mult != null ? Math.round(parts.mult * 100) / 100 + 'x' : '?';
    const metric = fmtChangeMetric(pair.old, pair.new);
    return `Anomaly: ${model} moved ${mult} between polls (${pair.key} $${trimNum(pair.old)}→$${trimNum(pair.new)}${metric ? ' ' + metric : ''})`;
  } catch (_) {
    return null;
  }
}

// Burn-rate projection for one quota window from a windowInfo-shaped input
// ({ current, delta, daysElapsed }) plus the window's resetsAt ISO string.
// Returns null when unprojectable; otherwise
//   { ratePerDay, daysToCrit, critDateIso, resetsAt, exhaustsBeforeReset }.
// exhaustsBeforeReset is true when the linear ~95% crossing lands strictly
// before the known reset (the budget runs out mid-cycle). Pure, never throws.
function burnRateInfo(wi, resetsAtIso, nowMs) {
  try {
    if (!wi || typeof wi.current !== 'number' || typeof wi.delta !== 'number') return null;
    const now = nowMs != null ? nowMs : Date.now();
    const rate = wi.daysElapsed > 0 ? wi.delta / wi.daysElapsed : 0;
    if (!(rate > 0)) return null;
    const daysToCrit = daysToThreshold(wi.current, rate, CRIT_THRESHOLD);
    if (daysToCrit == null) return null;
    const critDateIso = thresholdDateIso(now, daysToCrit);
    let exhaustsBeforeReset = null;
    const resetMs = resetsAtIso != null ? Date.parse(resetsAtIso) : NaN;
    if (!isNaN(resetMs)) {
      exhaustsBeforeReset = now + daysToCrit * 864e5 < resetMs;
    }
    return { ratePerDay: rate, daysToCrit, critDateIso, resetsAt: resetsAtIso || null, exhaustsBeforeReset };
  } catch (_) {
    return null;
  }
}

// Acceleration alarm: compares the last-24h burn rate against the prior-7d
// baseline rate for one usage window. `history` is an array of { ts, [win] }
// samples (ms epoch ts, numeric percents). Returns
//   { recentRate, baseRate, ratio } when recent >= threshold x baseline,
// otherwise null. A non-positive baseline still alarms when the last 24h moved
// materially (>=2pts) so a flat-then-spike week is not missed. Pure, never throws.
const ACCEL_WINDOW_MS = 24 * 3600 * 1000;
const ACCEL_THRESHOLD = 2;
const ACCEL_MIN_DELTA = 2;

function accelerationAlarm(history, win, nowMs, threshold) {
  try {
    const now = nowMs != null ? nowMs : Date.now();
    const thr = typeof threshold === 'number' && threshold > 0 ? threshold : ACCEL_THRESHOLD;
    const arr = Array.isArray(history) ? history : [];
    const valAtOrBefore = (t) => {
      let best = null;
      for (const s of arr) {
        if (s && typeof s.ts === 'number' && typeof s[win] === 'number' && s.ts <= t) {
          if (!best || s.ts > best.ts) best = s;
        }
      }
      return best;
    };
    const cur = arr.length ? arr[arr.length - 1] : null;
    const curVal = cur && typeof cur[win] === 'number' ? cur[win] : null;
    if (curVal == null) return null;
    const dayAgo = valAtOrBefore(now - ACCEL_WINDOW_MS);
    const weekAgo = valAtOrBefore(now - QUOTA_WINDOW_MS);
    if (!dayAgo || dayAgo.ts === cur.ts) return null;
    const recentDays = Math.max((now - dayAgo.ts) / 864e5, 1 / 24);
    const recentRate = (curVal - dayAgo[win]) / recentDays;
    if (!(recentRate > 0)) return null;
    let baseRate = 0;
    if (weekAgo && weekAgo.ts < dayAgo.ts && typeof weekAgo[win] === 'number') {
      const baseDays = Math.max((dayAgo.ts - weekAgo.ts) / 864e5, 1 / 24);
      baseRate = (dayAgo[win] - weekAgo[win]) / baseDays;
    }
    if (baseRate > 0) {
      const ratio = recentRate / baseRate;
      return ratio >= thr ? { recentRate, baseRate, ratio } : null;
    }
    // Flat/declining baseline: alarm only on a material 24h jump.
    if (curVal - dayAgo[win] >= ACCEL_MIN_DELTA) {
      return { recentRate, baseRate, ratio: Infinity };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Leaderboard rank arrows: compare current rank order against the 7d-ago rank
// order. Both args are arrays of model ids in rank order (cheapest first).
// Returns { [id]: { arrow: '▲'|'▼'|'–', pastRank, rank } }. New/unranked ids
// get '–' with a null pastRank. Pure, never throws.
function rankArrows(rankNow, rankPast) {
  try {
    const now = Array.isArray(rankNow) ? rankNow : [];
    const past = Array.isArray(rankPast) ? rankPast : [];
    const pastPos = {};
    past.forEach((id, i) => {
      if (!(id in pastPos)) pastPos[id] = i + 1;
    });
    const out = {};
    now.forEach((id, i) => {
      const rank = i + 1;
      const pr = pastPos[id] != null ? pastPos[id] : null;
      let arrow = '–';
      if (pr != null) {
        if (pr > rank) arrow = '▲';
        else if (pr < rank) arrow = '▼';
      }
      out[id] = { arrow, pastRank: pr, rank };
    });
    return out;
  } catch (_) {
    return {};
  }
}

// Cap-upset flag: models that look cheap on LIST price but are expensive
// effectively because they sit on a high-multiplier (default $15 → 4x) cap.
// `rawOrder`/`effOrder` are id arrays ranked cheapest-first by raw list cost
// and by effective cost; `capOf` maps id -> numeric cap. Flags ids with
// rawRank <= topN whose effective rank trails by >= minGap AND whose cap is in
// upsetCaps. Returns [{ id, rawRank, effRank, cap, gap }]. Pure, never throws.
function capUpsets(rawOrder, effOrder, capOf, opts) {
  try {
    const o = opts || {};
    const topN = typeof o.topN === 'number' ? o.topN : 10;
    const minGap = typeof o.minGap === 'number' ? o.minGap : 5;
    const upsetCaps = Array.isArray(o.upsetCaps) ? o.upsetCaps : [15];
    const raw = Array.isArray(rawOrder) ? rawOrder : [];
    const eff = Array.isArray(effOrder) ? effOrder : [];
    const effPos = {};
    eff.forEach((id, i) => {
      if (!(id in effPos)) effPos[id] = i + 1;
    });
    const out = [];
    raw.slice(0, topN).forEach((id, i) => {
      const rawRank = i + 1;
      const effRank = effPos[id];
      if (effRank == null) return;
      const cap = capOf ? capOf[id] : null;
      if (!upsetCaps.includes(cap)) return;
      const gap = effRank - rawRank;
      if (gap >= minGap) out.push({ id, rawRank, effRank, cap, gap });
    });
    return out;
  } catch (_) {
    return [];
  }
}

// Meta fields whose silent moves are user-visible (cost unchanged): provider
// family rename, knowledge cutoff refresh, open-weights flip, context-window
// resize. capabilities/description churn is intentionally excluded (noisy).
const META_DIFF_FIELDS = ['family', 'knowledge', 'open_weights', 'contextWindow'];

// Pure: list { field, old, new } moves between two extractModelMeta-shaped
// objects. JSON-compare per field so objects (knowledge) compare by value.
// Returns [] when nothing tracked moved. Never throws.
function diffMeta(prevMeta, currMeta) {
  try {
    const a = prevMeta && typeof prevMeta === 'object' ? prevMeta : {};
    const b = currMeta && typeof currMeta === 'object' ? currMeta : {};
    const out = [];
    for (const f of META_DIFF_FIELDS) {
      const sa = JSON.stringify(a[f] == null ? null : a[f]);
      const sb = JSON.stringify(b[f] == null ? null : b[f]);
      if (sa !== sb) out.push({ field: f, old: a[f] == null ? null : a[f], new: b[f] == null ? null : b[f] });
    }
    return out;
  } catch (_) {
    return [];
  }
}

function fmtMetaVal(v) {
  if (v == null) return '?';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch (_) {
      return '?';
    }
  }
  return String(v);
}

// One-line info text for a meta move (or null when nothing tracked moved).
//   "Meta changed for <id>: family A→B"
function metaChangeText(model, prevMeta, currMeta) {
  try {
    const diffs = diffMeta(prevMeta, currMeta);
    if (!diffs.length) return null;
    const bits = diffs.map((d) => `${d.field} ${fmtMetaVal(d.old)}→${fmtMetaVal(d.new)}`);
    return `Meta changed for ${model}: ${bits.join('; ')}`;
  } catch (_) {
    return null;
  }
}

module.exports = {
  changeParts,
  fmtPct,
  fmtMult,
  fmtAbs,
  fmtChangeMetric,
  fmtFeedPct,
  directionOf,
  directionColor,
  trimNum,
  fmtMoney,
  QUOTA_WINDOW_MS,
  WARN_THRESHOLD,
  CRIT_THRESHOLD,
  daysToThreshold,
  thresholdDateIso,
  humanDate,
  projectThresholds,
  ANOMALY_MULT,
  ANOMALY_PCT,
  isAnomalousMove,
  anomalyPair,
  anomalyText,
  burnRateInfo,
  ACCEL_WINDOW_MS,
  ACCEL_THRESHOLD,
  ACCEL_MIN_DELTA,
  accelerationAlarm,
  rankArrows,
  capUpsets,
  META_DIFF_FIELDS,
  diffMeta,
  metaChangeText
};
