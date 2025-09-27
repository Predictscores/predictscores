// lib/kv-helpers.js
// Unified KV backend (read & write use the SAME client).
// Supports KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN (Upstash-compatible).

const URL_A = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOK_A = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

function trimSlash(u) { return (u || '').replace(/\/+$/, ''); }

const BASE = trimSlash(URL_A);
const AUTH = TOK_A ? `Bearer ${TOK_A}` : '';

async function upstashGet(key) {
  if (!BASE || !AUTH) throw new Error('kv-helpers: missing REST URL/TOKEN in environment');
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    method: 'GET',
    headers: { Authorization: AUTH },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`KV GET failed ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data ? data.result ?? null : null;
}

async function upstashSet(key, value) {
  if (!BASE || !AUTH) throw new Error('kv-helpers: missing REST URL/TOKEN in environment');
  const payload = typeof value === 'string' ? value : JSON.stringify(value);

  // IMPORTANT: send the value in the JSON BODY (not in the URL path),
  // to avoid 431/URI too long on large documents.
  const res = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: AUTH,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value: payload }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`KV SET failed ${res.status}: ${txt}`);
  }
  return true;
}

/* Public API expected by the rest of the app */
async function readKeyFromBackends(key) {
  return upstashGet(key);
}

async function writeKeyToBackends(key, value) {
  return upstashSet(key, value);
}

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
