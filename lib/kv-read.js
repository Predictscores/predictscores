// lib/kv-read.js
// Unified KV adapter for all routes: getKV(), kvGet(), kvSet()
// Works with Upstash-style REST: KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN

const URL_A = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOK_A = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

function trimSlash(u) { return (u || '').replace(/\/+$/, ''); }
const BASE = trimSlash(URL_A);
const AUTH = TOK_A ? `Bearer ${TOK_A}` : '';

function ensureEnv() {
  if (!BASE || !AUTH) {
    throw new Error('KV adapter: missing REST URL/TOKEN (set KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN)');
  }
}

async function kvGet(key) {
  ensureEnv();
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    method: 'GET',
    headers: { Authorization: AUTH },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`KV GET failed ${res.status}: ${txt}`);
  }
  const data = await res.json().catch(() => null);
  return data ? (data.result ?? null) : null;
}

async function kvSet(key, value) {
  ensureEnv();
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  // Use JSON body to avoid very long URLs (431)
  const res = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: payload }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`KV SET failed ${res.status}: ${txt}`);
  }
  return true;
}

// Optional client wrapper with the same interface used in routes
async function getKV() {
  return {
    async get(k) { return kvGet(k); },
    async set(k, v) { return kvSet(k, v); },
  };
}

module.exports = { getKV, kvGet, kvSet };
