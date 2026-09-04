'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

// Discord's incoming-webhook content limit is 2000 chars; we cap each digest
// chunk at 1900 to leave headroom for the JSON envelope / username.
const CHUNK_MAX = 1900;

// Header line distinguishing the periodic digest from a single alert.
const DIGEST_HEADER = 'Daily digest — OpenCode Model Monitor (auto-posted)';

// Best-effort read of report.json from a state dir. Returns null on any miss.
function readReport(stateDir) {
  try {
    const p = path.join(stateDir || delivery.STATE_DIR || path.join(__dirname, '..', 'state'), 'report.json');
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

// Build 1-3 Discord-safe chunks (each <=1900 chars) from the current report:
// a digest header + the human-readable Markdown report (which already contains
// the generated timestamp, models tracked, 7-day quota movement + events, and
// upcoming resets/projections). Split on newlines to fit; never exceed the cap.
function buildDigestChunks(report, opts) {
  opts = opts || {};
  const max = opts.chunkMax || CHUNK_MAX;
  const md = delivery.renderMarkdown(report || {});
  const full = DIGEST_HEADER + '\n' + md;
  const chunks = chunkText(full, max);
  // Cap at 3 posts per the spec; each piece is already <= max so even the
  // (unlikely) 3rd chunk stays under Discord's 2000-char POST limit.
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
  }
  return chunks;
}

module.exports = { buildDigestChunks, postDigest, chunkText, CHUNK_MAX };
