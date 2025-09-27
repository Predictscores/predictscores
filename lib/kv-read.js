// lib/kv-read.js
// Unified KV adapter for all API routes.
// Exposes getKV(), kvGet(key), kvSet(key, value) and keeps tiny utils (toJson, arrFromAny).
// Internally delegates to lib/kv-helpers.js (readKeyFromBackends / writeKeyToBackends).

/* -------- helpers loader (supports CJS/ESM) -------- */
let helpers = null;

function loadHelpers() {
  if (helpers) return helpers;
  try {
    // Prefer require (most repos keep kv-helpers as CJS)
    // eslint-disable-next-line global-require, import/no-commonjs
    helpers = require('./kv-helpers');
    return helpers;
  } catch (_) {
    // Fallback to dynamic import if kv-helpers is ESM
    // NOTE: Next.js will transpile this fine
    return import('./kv-helpers.js').then((m) => {
      helpers = m.default ? m.default : m;
      return helpers;
    });
  }
}

/* -------- low-level read / write (string I/O) -------- */
async function readRaw(key) {
  if (!key) return null;
  const h = helpers || (await loadHelpers());
  const fn = h.readKeyFromBackends || h.kvGet || h.get; // support alt names if present
  if (typeof fn !== 'function') {
    throw new Error('kv-read: lib/kv-helpers missing readKeyFromBackends/kvGet/get');
  }
  return fn(key);
}

async function writeRaw(key, value) {
  if (!key) return false;
  const h = helpers || (await loadHelpers());
  const fn = h.writeKeyToBackends || h.kvSet || h.set; // support alt names if present
  if (typeof fn !== 'function') {
    throw new Error('kv-read: lib/kv-helpers missing writeKeyToBackends/kvSet/set');
  }
  // Always store strings to keep backend consistent
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  await fn(key, payload);
  return true;
}

/* -------- tiny utils (kept for compatibility) -------- */
function toJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function arrFromAny(x) {
  if (Array.isArray(x)) return x;
  if (x == null) return [];
  return [x];
}

/* -------- public API used by routes -------- */
async function getKV() {
  // Provides a minimal client with .get/.set expected by routes
  return {
    get: async (key) => readRaw(key),
    set: async (key, value) => writeRaw(key, value),
  };
}

// Function forms (some routes import kvGet/kvSet directly)
async function kvGet(key) { return readRaw(key); }
async function kvSet(key, value) { return writeRaw(key, value); }

/* -------- exports -------- */
module.exports = {
  getKV,
  kvGet,
  kvSet,
  toJson,
  arrFromAny,
};
