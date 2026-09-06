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

// Compute raw change components between two numeric values.
// Returns null when either side is not a finite number (no comparison possible).
// When old is exactly 0 we cannot form a ratio: we mark the move as "new" when
// new is non-zero, otherwise treat it as unchanged.
function changeParts(oldV, newV) {
  if (typeof oldV !== 'number' || typeof newV !== 'number') return null;
  if (!Number.isFinite(oldV) || !Number.isFinite(newV)) return null;
  if (oldV === 0) {
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
//   { current, delta, daysElapsed } + nowMs
// Returns null when unprojectable (no data / stable), otherwise
//   { daysToWarn, daysToCrit } (0 = already at/above). Pure, never throws.
function projectThresholds(wi, nowMs) {
  if (!wi || typeof wi.current !== 'number' || typeof wi.delta !== 'number') return null;
  const rate = wi.daysElapsed > 0 ? wi.delta / wi.daysElapsed : 0;
  const daysToWarn = daysToThreshold(wi.current, rate, WARN_THRESHOLD);
  const daysToCrit = daysToThreshold(wi.current, rate, CRIT_THRESHOLD);
  if (daysToWarn == null && daysToCrit == null) return null;
  return { daysToWarn, daysToCrit, rate };
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
  QUOTA_WINDOW_MS,
  WARN_THRESHOLD,
  CRIT_THRESHOLD,
  daysToThreshold,
  thresholdDateIso,
  humanDate,
  projectThresholds
};
