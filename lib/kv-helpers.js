// lib/kv-helpers.js
// Unified KV backend (read & write use the SAME client).
// Supports either KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN (Upstash-compatible).
// No dry-run. No prefixes. Keys are used exactly as provided.

const URL_A = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOK_A = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

if (!URL_A || !TOK_A) {
  // We don't throw here because some builds import this module at compile time.
  // The routes using it will error clearly if they actually try to use the client without envs.
  console.warn('kv-helpers: REST URL/TOKEN not found in env; reads/writes will fail if called.');
}

function trimSlash(u) {
  return (u || '').replace(/\/+$/,'');
}

const BASE = trimSlash(URL_A);
const AUTH = `Bearer ${TOK_A}`;

async function upstashGet(key) {
  // Upstash REST: GET {base}/get/{key}
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    method: 'GET',
    headers: { Authorization: AUTH },
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    throw new Error(`KV GET failed ${res.status}: ${txt}`);
  }
  const data = await res.json();
  // Upstash returns { result: "..." | null }
  return data ? data.result ?? null : null;
}

async function upstashSet(key, value) {
  // Upstash REST simple form: POST {base}/set/{key}/{value}
  // Value must be string; callers can pass string or object (we stringfy here).
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  const res = await fetch(`${BASE}/set/${encodeURIComponent(key)}/${encodeURIComponent(payload)}`, {
    method: 'POST',
    headers: { Authorization: AUTH },
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`KV SET failed ${res.status}: ${txt}`);
  }
  // Upstash returns { result: "OK" } typically
  return true;
}

/* Public API expected by the rest of the app */

async function readKeyFromBackends(key) {
  if (!BASE || !TOK_A) throw new Error('kv-helpers: missing REST URL/TOKEN in environment');
  // Single backend — if you add more later, fan-out here.
  return upstashGet(key);
}

async function writeKeyToBackends(key, value) {
  if (!BASE || !TOK_A) throw new Error('kv-helpers: missing REST URL/TOKEN in environment');
  // Single backend — if you add more later, fan-out here (and ensure readers match).
  return upstashSet(key, value);
}

// Optional descriptor (some code may import kvBackends for introspection)
const kvBackends = [
  {
    kind: 'upstash-rest',
    base: BASE || null,
    hasAuth: Boolean(TOK_A),
    read: true,
    write: true,
  },
];

module.exports = {
  kvBackends,
  readKeyFromBackends,
  writeKeyToBackends,
};
