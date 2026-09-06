'use strict';

// Atomic state writes + corrupt-snapshot recovery (v0.20.0, #112).
//
// All durable state goes through tmp+rename so a kill -9 mid-write can never
// leave a half-written snapshot behind. On parse failure the corrupt file is
// preserved as .bak (instead of silently resetting) so trends/dedup survive.
const fs = require('fs');

let readOnly = false; // ENOSPC degrade: stop writing, keep alerting in memory

function isReadOnly() {
  return readOnly;
}

function isNoSpace(err) {
  return !!err && (err.code === 'ENOSPC' || err.code === 'EDQUOT');
}

function noteWriteError(err, onEnospc) {
  if (isNoSpace(err)) {
    readOnly = true;
    try {
      if (typeof onEnospc === 'function') onEnospc(err);
    } catch (_) {}
  }
}

// Atomic write: tmp file in the same dir + rename. Never throws; returns
// true on success. On ENOSPC flips the module into read-only degrade mode
// and fires onEnospc (caller raises a critical alert once).
function atomicWriteFileSync(target, data, onEnospc) {
  if (readOnly) return false;
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    noteWriteError(e, onEnospc);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

function atomicWriteJsonSync(target, obj, onEnospc) {
  let text;
  try {
    text = JSON.stringify(obj, null, 2);
  } catch (_) {
    return false;
  }
  return atomicWriteFileSync(target, text, onEnospc);
}

// Parse a JSON file defensively: returns { ok, data }. On parse failure the
// corrupt file is renamed to <path>.bak (preserved, not wiped) and data is
// the caller's fallback (default {}). Never throws.
function readJsonKeepBak(filePath, fallback) {
  const fb = fallback !== undefined ? fallback : {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      return { ok: true, data: JSON.parse(raw) == null ? fb : JSON.parse(raw) };
    } catch (parseErr) {
      try { fs.renameSync(filePath, filePath + '.bak'); } catch (_) {}
      return { ok: false, data: fb, corrupt: true };
    }
  } catch (_) {
    return { ok: false, data: fb, missing: true };
  }
}

// Strip URL credentials / tokens before embedding a URL in alert text so a
// future `?token=` style URL can never leak a secret into alerts.log.
function redactUrl(url) {
  try {
    const s = String(url || '');
    return s.replace(/([?&])(token|key|secret|auth|signature)=[^&\s]*/gi, '$1$2=REDACTED');
  } catch (_) {
    return String(url || '');
  }
}

function resetForTests() {
  readOnly = false;
}

module.exports = {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  readJsonKeepBak,
  redactUrl,
  isReadOnly,
  isNoSpace,
  resetForTests
};
