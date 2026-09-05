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

module.exports = {
  changeParts,
  fmtPct,
  fmtMult,
  fmtAbs,
  fmtChangeMetric,
  fmtFeedPct,
  directionOf,
  directionColor,
  trimNum
};
