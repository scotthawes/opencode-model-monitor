'use strict';

// Shared fetch-with-retry for all monitor watchers (v0.20.0, #112).
//
// Retries transient failures (429 / 502 / 503 / 504 + network aborts) up to
// 3 attempts with jittered backoff, honoring Retry-After when present.
// Non-retryable statuses (other 4xx) resolve immediately so callers keep
// their existing !res.ok handling. Never throws for HTTP statuses — only
// throws when every attempt fails at the network level (callers already
// handle fetch rejection as 'unknown', never throw).
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelayMs(attempt, res) {
  try {
    const ra = res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('retry-after') : null;
    if (ra != null && String(ra).trim() !== '') {
      const secs = Number(String(ra).trim());
      if (!isNaN(secs) && secs >= 0 && secs <= 120) return secs * 1000 + Math.random() * 200;
    }
  } catch (_) {}
  return BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
}

// fetchWithRetry(url, options): like fetch but transparently retries
// transient statuses. Returns the final Response (ok or not); throws only
// when all attempts reject at the network level.
async function fetchWithRetry(url, options, attempts) {
  const max = typeof attempts === 'number' && attempts > 0 ? attempts : MAX_ATTEMPTS;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      lastErr = e;
      if (i < max - 1) await sleep(retryDelayMs(i, null));
      continue;
    }
    if (RETRYABLE.has(res.status) && i < max - 1) {
      await sleep(retryDelayMs(i, res));
      continue;
    }
    return res;
  }
  throw lastErr;
}

module.exports = { fetchWithRetry, RETRYABLE, MAX_ATTEMPTS };
