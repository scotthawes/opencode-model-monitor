'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

// Watches an Atom feed (Go/Zen pricing docs commits, or releases.atom) for new
// entries. Uses ETag conditional GETs plus a persisted store of seen entry ids
// so that repeated runs are idempotent (no duplicate alerts for the same entry).
//
// Returns { key, newEntries } where newEntries is an array of
// { title, updated, id, link }. On a 304 (not modified) newEntries is [].

const MAX_SEEN = 25;

async function runAtomWatch(stateDir, key, feedUrl) {
  const etagPath = path.join(stateDir, '.etag-' + key);
  const storePath = path.join(stateDir, 'feed-' + key + '.json');

  let etag = null;
  try {
    etag = fs.readFileSync(etagPath, 'utf8').trim() || null;
  } catch (_) {}

  let prior = { etag: null, seenIds: [] };
  try {
    prior = JSON.parse(fs.readFileSync(storePath, 'utf8')) || {};
  } catch (_) {}
  const seenIds = Array.isArray(prior.seenIds) ? prior.seenIds : [];

  // Prefer the dedicated etag file, fall back to the etag stored in the feed
  // store (kept in parity with price-watch's .etag-* snapshot file).
  const reqEtag = etag || prior.etag || null;

  if (!feedUrl) {
    delivery.alert('warning', 'Feed not configured: ' + key, 'No feed URL for key ' + key);
    return { key, newEntries: [] };
  }

  let res;
  try {
    res = await fetch(feedUrl, {
      headers: reqEtag ? { 'If-None-Match': reqEtag } : {}
    });
  } catch (e) {
    delivery.alert('warning', 'Feed fetch failed: ' + key, String(e && e.message ? e.message : e));
    return { key, newEntries: [] };
  }

  if (res.status === 304) {
    return { key, newEntries: [] };
  }

  if (!res.ok) {
    delivery.alert('warning', `Feed fetch HTTP ${res.status}: ${key}`, feedUrl);
    return { key, newEntries: [] };
  }

  const newEtag = res.headers && res.headers.get ? res.headers.get('etag') : null;
  const text = await res.text();

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(text)) !== null) {
    const block = m[1];
    const title = matchTag(block, 'title');
    const updated = matchTag(block, 'updated');
    let id = matchTag(block, 'id');
    let link = '';
    const linkM = block.match(/<link[^>]*href="([^"]+)"/);
    if (linkM) link = linkM[1];
    if (!id) id = (title || '') + '|' + (updated || '');
    entries.push({ title: title || '(untitled)', updated: updated || '', id, link });
  }

  const seenSet = new Set(seenIds);
  const newEntries = [];
  for (const e of entries) {
    if (!seenSet.has(e.id)) {
      newEntries.push(e);
      delivery.alert('model_change', 'Feed update: ' + key, e.title + (e.link ? ' — ' + e.link : ''));
    }
  }

  // Merge new ids into the seen set, keeping only the most recent ~25.
  const merged = seenIds.concat(newEntries.map((e) => e.id));
  const trimmed = merged.slice(-MAX_SEEN);

  try {
    fs.writeFileSync(
      storePath,
      JSON.stringify({ etag: newEtag || reqEtag, seenIds: trimmed }, null, 2)
    );
    if (newEtag) fs.writeFileSync(etagPath, newEtag);
  } catch (e) {
    delivery.alert('warning', 'Feed store save failed: ' + key, String(e && e.message ? e.message : e));
  }

  return { key, newEntries };
}

// Extracts the text content of the first <tag>...</tag> (attribute-aware), or ''.
// Uses [\s\S] so it tolerates whitespace/newlines between the open tag and the
// content (GitHub's commit feeds put the title on its own line).
function matchTag(block, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>');
  const m = block.match(re);
  return m ? (m[1] || '').trim() : '';
}

module.exports = { runAtomWatch };
