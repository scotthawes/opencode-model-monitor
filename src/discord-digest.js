'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');
const changeMetric = require('./change-metric'); // shared Δ% / × / $ formatting
const calc = require('./calc'); // effective cost + leaderboard (v0.10.0, #77)

// Discord's incoming-webhook content limit is 2000 chars; we cap each digest
// chunk at 1900 to leave headroom for the JSON envelope / username.
const CHUNK_MAX = 1900;

// 7-day retention window for "what changed" events (mirrors delivery's
// changelogRetentionMs default so the digest matches the report's window).
// v0.16.0 (#103): single window constant lives in change-metric.js.
const CHANGELOG_RETENTION_MS = changeMetric.QUOTA_WINDOW_MS;

// Max bullets / events surfaced in the digest before we say "+N more".
// v0.18.0 (#107): top-8 (was top-5) so surfaced anomaly/meta/privacy lines
// can't push real moves out of the digest.
const MAX_EVENTS = 8;

// Windows we surface by default in the quota section.
const WINDOWS = ['rolling', 'weekly', 'monthly'];

// Best-effort read of report.json from a state dir. Returns null on any miss.
function readReport(stateDir) {
  try {
    const p = path.join(stateDir || delivery.getStateDir() || path.join(__dirname, '..', 'state'), 'report.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Split text into chunks of at most `max` chars, breaking only on newlines so
// Discord never receives a mid-line cut. A line longer than `max` is hard-split.
function chunkText(text, max) {
  const lines = String(text).split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const candidate = cur ? cur + '\n' + line : line;
    if (candidate.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = line;
      } else {
        // A single line exceeds the cap — hard split it.
        let rest = line;
        while (rest.length > max) {
          chunks.push(rest.slice(0, max));
          rest = rest.slice(max);
        }
        cur = rest;
      }
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// --- presentation helpers --------------------------------------------------

// Human date only (e.g. "Sep 8"), UTC so it never shifts across timezones.
// v0.16.0 (#103): shared via change-metric.js so digest/report/page agree.
function humanDate(iso) {
  return changeMetric.humanDate(iso);
}

// Trim a number for chat: integers stay ints, floats drop trailing zeros.
// Per-surface rule (v0.19.0, #110): money on every surface renders via
// change-metric trimNum/fmtMoney; this helper is for NON-money chat deltas
// (quota points) only, so its 4-decimal shape is intentional, not drift.
function fmtNum(x) {
  if (x == null || isNaN(x)) return '?';
  if (Number.isInteger(x)) return String(x);
  return String(parseFloat(Number(x).toFixed(4)));
}

// Truncate to ~n chars with an ellipsis so a bullet stays one scannable line.
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Strip a trailing URL (and the " — " before it) from a message.
function stripUrl(s) {
  return String(s || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s*—\s*$/, '')
    .replace(/\s*\(?\s*$/, '')
    .trim();
}

// Turn one changelog event into a single, scannable bullet line:
//   "• hy3 cost 0.0175→0.14 (8x) — model_change"
//   "• Usage fetch failed: fetch failed — warning"
function describeEvent(ev) {
  const lvl = ev.level || '?';
  let desc;
  if (lvl === 'model_change') {
    const m = String(ev.message || '');
    // Unified metric-delta format (Fix 2, #88): "🔴 <Name> (id) output $A→$B ...".
    // It already carries the magnitude, so surface it verbatim. Legacy catalog
    // lines (raw JSON dump) are parsed for backward-compat with old changelogs.
    if (/^🔴\s+.*?\([\w.-]+\)\s+(output|input)\s+\$/.test(m)) {
      desc = m;
    } else {
      const cost = m.match(/Cost changed for (\S+):\s*(\{[^}]*\})\s*->\s*(\{[^}]*\})/);
      if (cost) {
        const model = cost[1];
        try {
          const oldC = JSON.parse(cost[2]);
          const newC = JSON.parse(cost[3]);
          // Prefer output $/1M (the page's headline metric); fall back to input
          // when output is absent. PR page spec #4: always carry Δ% / × / $.
          const useOutput = typeof newC.output === 'number';
          const o = useOutput ? oldC.output : oldC.input;
          const n = useOutput ? newC.output : newC.input;
          const metric = changeMetric.fmtChangeMetric(o, n);
          desc =
            `${model} ${useOutput ? 'output' : 'input'} ${fmtNum(o)}→${fmtNum(n)}` +
            (metric ? ` ${metric}` : '');
        } catch (_) {
          desc = `${model} cost changed`;
        }
      } else {
        // Feed/docs update — summarize the title, drop the commit URL.
        desc = stripUrl(m) || ev.title || 'model change';
      }
    }
  } else {
    desc = ev.title || '';
    if (ev.message && ev.message !== ev.title) {
      desc += ': ' + ev.message;
    }
  }
  return `• ${truncate(desc, 120)} — ${lvl}`;
}

// Read recent changelog events (7-day window), newest first. Returns an array
// of {ts,level,title,message}. v0.16.0 (#103): reads via delivery.readChangelog
// so the per-cycle parse cache is reused instead of a third parse from disk.
function getEvents(stateDir, now) {
  now = now || Date.now();
  const cutoff = now - CHANGELOG_RETENTION_MS;
  let arr = [];
  try {
    if (stateDir) delivery.setStateDir(stateDir);
    const parsed = delivery.readChangelog();
    if (Array.isArray(parsed)) {
      arr = parsed.filter((e) => (e.ts ? Date.parse(e.ts) : 0) >= cutoff);
    }
  } catch (_) {
    return [];
  }
  // NOTE: we return the FULL in-window set (no -20 cap here). "What changed"
  // is sorted model-first and then capped at MAX_EVENTS in buildDigestChunks,
  // so a model_change that sits beyond the last 20 (but still inside the 7-day
  // window) is no longer dropped before it can be prioritized.
  return arr.reverse();
}

// Recognize a quota-crossing alert (title "Quota <window> warning|critical").
// Returns the window name (e.g. "monthly") or null. Used to collapse repeats.
function isQuotaCrossing(ev) {
  const m = /^Quota (\w+) (warning|critical)$/.exec((ev && ev.title) || '');
  return m ? m[1] : null;
}

// Collapse repeated quota-warning/critical crossings for the SAME window into a
// single "What changed" bullet so a noisy window (crossing back and forth
// across the 7-day window) can't bury real model_change events. Each window
// becomes ONE bullet carrying the latest reading + a repeat count, e.g.
//   "Quota monthly warning: 83% used (latest, N repeats)"
// Non-quota events are preserved verbatim; model_change events (priority 0)
// still sort first, so they stay visible. Never throws.
function collapseQuotaWarnings(events) {
  // Tally repeats per window across the whole list first, so N is accurate
  // even when a window's readings are interspersed with other events.
  const tally = new Map(); // window -> { count, latest }
  for (const e of events) {
    const w = isQuotaCrossing(e);
    if (!w) continue;
    const entry = tally.get(w) || { count: 0, latest: null };
    entry.count += 1;
    if (!entry.latest || Date.parse(e.ts) >= Date.parse(entry.latest.ts)) entry.latest = e;
    tally.set(w, entry);
  }
  const emitted = new Set();
  const out = [];
  for (const e of events) {
    const w = isQuotaCrossing(e);
    if (!w) {
      out.push(e);
      continue;
    }
    if (emitted.has(w)) continue; // collapse repeats into the first (latest) bullet
    emitted.add(w);
    const info = tally.get(w);
    if (info && info.count > 1 && info.latest) {
      const pctMatch = String(info.latest.message || '').match(/^(\d+)%\s+used/);
      const pct = pctMatch ? pctMatch[1] : '';
      out.push({ ...info.latest, message: `${pct}% used (latest, ${info.count} repeats)` });
    } else {
      out.push(e);
    }
  }
  return out;
}

// Format a 7-day delta as "(Δ +1/7d)" / "(Δ -3/7d)" / "" when unknown.
function deltaStr(delta) {
  if (delta == null) return '';
  const sign = delta > 0 ? '+' : '';
  return ` (Δ ${sign}${delta}/7d)`;
}

// Project the ~80% warn date for a window, or null when stable/unknown.
// v0.19.0 (#110): accepts the window's resetsAt so the linear projection is
// bounded by the reset (see change-metric.projectThresholds).
function warnDateFor(history, win, now, resetsAtIso) {
  const wi = delivery.windowInfo(history, win, now, resetsAtIso);
  if (!history.length || !wi) return null;
  const proj = changeMetric.projectThresholds(wi, now, resetsAtIso);
  if (!proj || proj.daysToWarn == null) return null;
  if (proj.daysToWarn === 0) return 'at/above warn';
  return humanDate(new Date(now + proj.daysToWarn * 864e5).toISOString());
}

// Project the ~95% critical date for a window (same linear model as warnDateFor,
// threshold 95). Returns 'at/above crit' when already at/above, null when stable.
function critDateFor(history, win, now, resetsAtIso) {
  const wi = delivery.windowInfo(history, win, now, resetsAtIso);
  if (!history.length || !wi) return null;
  const proj = changeMetric.projectThresholds(wi, now, resetsAtIso);
  if (!proj || proj.daysToCrit == null) return null;
  if (proj.daysToCrit === 0) return 'at/above crit';
  return humanDate(new Date(now + proj.daysToCrit * 864e5).toISOString());
}

// Build 1-3 Discord-safe chunks (each <=1900 chars) from the current report,
// in a scannable, chat-first layout:
//
//   Chunk 1 — TL;DR + "What changed" (always present)
//   Chunk 2 — Quota detail lines (only when there is usage data)
//   Chunk 3 — Upcoming / actions (only when there is a projection to surface)
//
// No raw JSON, no full timestamps, no 304/ETag jargon — human dates only.
function buildDigestChunks(report, opts) {
  opts = opts || {};
  const max = opts.chunkMax || CHUNK_MAX;
  const stateDir = opts.stateDir || delivery.getStateDir() || path.join(__dirname, '..', 'state');
  if (opts.stateDir) delivery.setStateDir(opts.stateDir);

  const rep = report || {};
  const now = Date.now();

  // --- gather data ---
  const pricing = rep.pricing || {};
  const models = pricing.models || {};
  const modelCount =
    pricing.modelCount != null ? pricing.modelCount : Object.keys(models).length;

  const usage = rep.usage || {};
  const usageWin = usage.usage ? usage.usage : usage;
  const wins = WINDOWS.filter((w) => usageWin[w]);

  let history = [];
  try {
    history = delivery.readUsageHistory();
  } catch (_) {
    history = [];
  }
  const deltaFor = (w) => {
    const wi = delivery.windowInfo(history, w, now, usageWin[w] && usageWin[w].resetsAt);
    return wi && wi.delta != null ? wi.delta : null;
  };

  const events = getEvents(stateDir, now);
  const eventCount = events.length;

  // Fix f: prioritize model_change events in "What changed" (model events
  // first, then model-ish warnings/info, then everything else), each group
  // newest-first. v0.18.0 (#107): every surfaced type rides at model_change
  // level, but warnings/info with model-ish titles (anomaly/meta/liveness)
  // still sort above generic quota noise so nothing real is buried.
  const MODELISH_RE = /model|anomaly|meta|privacy|quota|liveness|deprecat|withdraw|serving|tiers|digest/i;
  const priorityOf = (e) => {
    if (e && e.level === 'model_change') return 0;
    if (e && (e.level === 'warning' || e.level === 'critical' || e.level === 'info') &&
        MODELISH_RE.test(`${e.title || ''} ${e.message || ''}`)) return 1;
    return 2;
  };
  const sortedEvents = events.slice().sort((a, b) => {
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pa - pb;
    return Date.parse(b.ts) - Date.parse(a.ts);
  });

  // Collapse repeated quota-warning/critical crossings (same window) into one
  // bullet so they can't bury model_change events (fix 2).
  const collapsedEvents = collapseQuotaWarnings(sortedEvents);

  // Headline window for the TL;DR is monthly (the budget users care about),
  // falling back to the last available window. Projections (warn dates) are only
  // meaningful for the headline window — rolling/weekly reset too often for a
  // linear projection to be useful, so we never surface them as "warn ~date".
  const headlineWin = wins.includes('monthly') ? 'monthly' : wins[wins.length - 1];
  const headline = usageWin[headlineWin] || null;
  const headlinePct = headline && headline.percent != null ? headline.percent : null;
  const headlineDelta = headline ? deltaFor(headlineWin) : null;

  // "next reset" — prefer the monthly reset (matches the headline window);
  // otherwise the soonest upcoming reset among the windows.
  let nextResetIso = headline && headline.resetsAt ? headline.resetsAt : null;
  if (!nextResetIso) {
    let soonest = null;
    for (const w of wins) {
      const r = usageWin[w] && usageWin[w].resetsAt;
      if (r) {
        const t = Date.parse(r);
        if (!isNaN(t) && t >= now - 864e5 && (!soonest || t < soonest)) soonest = t;
      }
    }
    nextResetIso = soonest ? new Date(soonest).toISOString() : null;
  }

  // --- status line ---
  const quiet = eventCount === 0;
  const statusEmoji = quiet ? '🟢' : '🔴';
  const statusText = quiet ? 'All quiet' : `${eventCount} changes`;

  const tldrParts = [`**Monitor** ${statusEmoji} ${statusText}`];
  if (modelCount != null) tldrParts.push(`${modelCount} models`);
  if (headlinePct != null) {
    tldrParts.push(`monthly ${headlinePct}%${deltaStr(headlineDelta)}`);
  }
  if (nextResetIso) tldrParts.push(`next reset ${delivery.humanizeReset(nextResetIso)}`);
  const tldr = tldrParts.join(' · ');

  // --- chunk 1: TL;DR + cheapest-now + what changed ---
  const c1 = [tldr, ''];

  // v0.10.0 (#77): surface the top-3 cheapest effective cost/request models so
  // the digest answers "what's the best deal right now" without opening the page.
  // Effective = list × (60 / cap); computed from the same math as `npm run leaderboard`.
  // v0.17 (#105): rank arrows (▲/▼/– vs 7d ago, from price history) + $15-cap
  // upset flags ride on the same line. Best-effort, never blocks the digest.
  try {
    const lbModels = {};
    for (const id of Object.keys(models)) {
      const c = models[id] && models[id].cost;
      if (c && typeof c === 'object') lbModels[id] = { cost: c };
    }
    const lb = calc.leaderboard(lbModels, calc.DEFAULT_PATTERN, 3);
    if (lb.length) {
      let arrows = {};
      let upsets = [];
      try {
        const priceHist = delivery.readPriceHistory();
        const cutoff = now - changeMetric.QUOTA_WINDOW_MS;
        const pastCostOf = {};
        for (const s of priceHist) {
          const t = s && s.ts ? Date.parse(s.ts) : NaN;
          if (isNaN(t) || t > cutoff) continue;
          for (const id of Object.keys((s && s.models) || {})) {
            const cc = s.models[id] && s.models[id].cost;
            if (cc && typeof cc === 'object') pastCostOf[id] = cc;
          }
        }
        const pastLbModels = {};
        for (const id of Object.keys(lbModels)) {
          pastLbModels[id] = { cost: pastCostOf[id] || lbModels[id].cost };
        }
        const nowOrder = calc.leaderboard(lbModels, calc.DEFAULT_PATTERN).map((r) => r.id);
        const pastOrder = calc.leaderboard(pastLbModels, calc.DEFAULT_PATTERN).map((r) => r.id);
        arrows = changeMetric.rankArrows(nowOrder, pastOrder);
        const rawOrder = Object.keys(lbModels)
          .map((id) => ({ id, raw: calc.costPerRequest(lbModels[id].cost) }))
          .filter((r) => r.raw != null && isFinite(r.raw) && r.raw > 0)
          .sort((a, b) => a.raw - b.raw)
          .map((r) => r.id);
        const capOf = {};
        for (const r of calc.leaderboard(lbModels, calc.DEFAULT_PATTERN)) capOf[r.id] = r.cap;
        upsets = changeMetric.capUpsets(rawOrder, nowOrder, capOf);
      } catch (_) {
        arrows = {};
        upsets = [];
      }
      const parts = lb.map((r) => {
        const a = arrows[r.id] ? arrows[r.id].arrow : '–';
        return `${a} ${r.id} ($${changeMetric.trimNum(r.effective)}/req, cap $${r.cap})`;
      });
      c1.push('**Cheapest right now** ' + parts.join(' · '));
      for (const u of upsets.slice(0, 2)) {
        c1.push(`⚠️ ${u.id} looks cheap on list (#${u.rawRank}) but sits on a $${u.cap} cap (effective #${u.effRank})`);
      }
    }
  } catch (_) {
    // best effort — never block the digest
  }
  if (quiet) {
    c1.push('_No discrete changes — quota only._');
  } else {
    c1.push('**What changed**');
    const shown = collapsedEvents.slice(0, MAX_EVENTS);
    for (const ev of shown) c1.push(describeEvent(ev));
    if (collapsedEvents.length > MAX_EVENTS) {
      c1.push(`• +${collapsedEvents.length - MAX_EVENTS} more — see changelog`);
    }
  }
  const chunk1 = c1.join('\n');

  // --- chunk 2: quota detail (only if we have usage data) ---
  // v0.17 (#105): each line also carries burn pts/day + days-to-95 vs reset
  // plus the acceleration alarm. Best-effort, never blocks the digest.
  let chunk2 = '';
  if (usage.status !== 'unknown' && wins.length) {
    const q = ['**Quota**'];
    for (const w of wins) {
      const wi = usageWin[w];
      const pct = wi.percent != null ? wi.percent + '%' : '?';
      const reset = wi.resetsAt ? ` → resets ${humanDate(wi.resetsAt)}` : '';
      // Warn projection only for the headline window (see note above).
      const warn = w === headlineWin ? warnDateFor(history, w, now, wi.resetsAt) : null;
      const warnStr = warn && warn !== 'at/above warn' ? ` · warn ~${warn}` : '';
      let burnStr = '';
      try {
        const info = delivery.windowInfo(history, w, now, wi.resetsAt);
        const burn = info ? changeMetric.burnRateInfo(info, wi.resetsAt, now) : null;
        if (burn) {
          const rate = burn.ratePerDay >= 10 ? Math.round(burn.ratePerDay * 10) / 10 : Math.round(burn.ratePerDay * 100) / 100;
          burnStr = ` · burn ${rate}/d, 95% ~${burn.critDateIso ? humanDate(burn.critDateIso) : '?'}`;
          if (burn.exhaustsBeforeReset) burnStr += ' ⚠️ pre-reset';
        }
        const accel = changeMetric.accelerationAlarm(history, w, now);
        if (accel) burnStr += ` · ⚡${accel.ratio === Infinity ? ' spike' : ' ' + accel.ratio.toFixed(1) + 'x'}`;
      } catch (_) {
        burnStr = '';
      }
      q.push(`• ${w} ${pct}${deltaStr(deltaFor(w))}${reset}${warnStr}${burnStr}`);
    }
    chunk2 = q.join('\n');
  }

  // --- chunk 3: upcoming / actions (only the headline window) ---
  let chunk3 = '';
  const headlineResetsAt = headline && headline.resetsAt ? headline.resetsAt : null;
  const warn = warnDateFor(history, headlineWin, now, headlineResetsAt);
  const actions = [];
  if (warn === 'at/above warn') actions.push(`• ${headlineWin} already at/above warn threshold`);
  else if (warn) actions.push(`• ${headlineWin} warn projected ${warn} — consider throttle`);
  if (actions.length) {
    chunk3 = ['**Upcoming / actions**', ...actions].join('\n');
  }

  // Assemble up to 3 chunks, splitting any over-long piece as a safety net.
  const raw = [chunk1];
  if (chunk2) raw.push(chunk2);
  if (chunk3) raw.push(chunk3);

  const chunks = [];
  for (const piece of raw) {
    for (const c of chunkText(piece, max)) {
      chunks.push(c);
      if (chunks.length >= 3) break;
    }
    if (chunks.length >= 3) break;
  }
  return chunks.slice(0, 3);
}

// Post the digest to every subscriber opted into the `digest` level (or `info`).
// Returns the chunks that were posted (handy for tests / manual runs).
//   opts.report         — report object (defaults to reading stateDir/report.json)
//   opts.stateDir       — state directory holding report.json
//   opts.send           — delivery fn (level, content) => Promise (test injection)
//   opts.chunkMax       — override per-chunk char cap
async function postDigest(opts) {
  opts = opts || {};
  const report = opts.report || readReport(opts.stateDir);
  if (!report) {
    return [];
  }
  const chunks = buildDigestChunks(report, opts);
  const send = opts.send || delivery.sendToSubscribers;
  for (const chunk of chunks) {
    await send('digest', chunk);
    // Legacy webhook parity: also push the digest to CONFIG.webhook (in addition
    // to subscribers) when configured. No-op if unset. Best-effort, never throws.
    if (!opts || !opts.skipWebhook) {
      await delivery.deliverDigestToWebhook(chunk);
    }
  }
  return chunks;
}

module.exports = { buildDigestChunks, postDigest, chunkText, readReport, CHUNK_MAX, MAX_EVENTS, warnDateFor, critDateFor };
