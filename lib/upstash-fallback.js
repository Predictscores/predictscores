// lib/upstash-fallback.js
// Lightweight in-memory substitute for Upstash REST KV when credentials are missing.
// Provides minimal get/set/incr behaviour with TTL semantics so API/cron logic can run
// identically in local/dev environments.

const GLOBAL_KEY = "__UPSTASH_FALLBACK_STORE__";

function ensureStore() {
  const g = globalThis;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      entries: new Map(),
      stats: {
        createdAt: Date.now(),
        gets: 0,
        sets: 0,
        incrs: 0,
        lastUpdate: null,
        noticeLogged: false,
      },
      nextCleanup: 0,
    };
  }
  return g[GLOBAL_KEY];
}

function nowMs(now) {
  return Number.isFinite(now) ? Number(now) : Date.now();
}

function ttlToMs(ttlSeconds) {
  const n = Number(ttlSeconds);
  return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : null;
}

function maybeCleanup(store, currentTs) {
  if (!Number.isFinite(store.nextCleanup) || currentTs >= store.nextCleanup) {
    for (const [key, entry] of store.entries.entries()) {
      if (entry.expiresAt != null && entry.expiresAt <= currentTs) {
        store.entries.delete(key);
      }
    }
    store.nextCleanup = currentTs + 60_000;
  }
}

function resolveEntry(store, key, currentTs) {
  const entry = store.entries.get(key);
  if (!entry) return null;
  if (entry.expiresAt != null && entry.expiresAt <= currentTs) {
    store.entries.delete(key);
    return null;
  }
  return entry;
}

export function upstashFallbackInfo() {
  const store = ensureStore();
  return {
    available: true,
    createdAt: store.stats.createdAt,
    lastUpdate: store.stats.lastUpdate,
    gets: store.stats.gets,
    sets: store.stats.sets,
    incrs: store.stats.incrs,
  };
}

export function upstashFallbackGet(key, now) {
  const store = ensureStore();
  const ts = nowMs(now);
  maybeCleanup(store, ts);
  const entry = resolveEntry(store, key, ts);
  if (!entry) return null;
  store.stats.gets += 1;
  return entry.value;
}

export function upstashFallbackSet(key, value, opts = {}) {
  const store = ensureStore();
  const ts = nowMs(opts.now);
  maybeCleanup(store, ts);
  const ttlMs = ttlToMs(opts.ttlSeconds);
  const expiresAt = ttlMs != null ? ts + ttlMs : null;
  store.entries.set(key, { value, expiresAt });
  store.stats.sets += 1;
  store.stats.lastUpdate = ts;
  return true;
}

export function upstashFallbackDel(key) {
  const store = ensureStore();
  return store.entries.delete(key);
}

export function upstashFallbackIncr(key, opts = {}) {
  const store = ensureStore();
  const ts = nowMs(opts.now);
  maybeCleanup(store, ts);
  const entry = resolveEntry(store, key, ts);
  const ttlMs = ttlToMs(opts.expireSeconds);

  let current = 0;
  let expiresAt = null;
  if (entry) {
    const parsed = Number(entry.value);
    current = Number.isFinite(parsed) ? parsed : 0;
    expiresAt = entry.expiresAt != null ? entry.expiresAt : null;
  }
  const next = current + 1;

  if (ttlMs != null) {
    if (!entry || entry.expiresAt == null) {
      expiresAt = ts + ttlMs;
    } else {
      expiresAt = entry.expiresAt;
    }
  }

  store.entries.set(key, { value: next, expiresAt });
  store.stats.incrs += 1;
  store.stats.lastUpdate = ts;
  return next;
}

export function upstashFallbackSnapshot(now) {
  const store = ensureStore();
  const ts = nowMs(now);
  maybeCleanup(store, ts);
  const rows = [];
  for (const [key, entry] of store.entries.entries()) {
    rows.push({
      key,
      value: entry.value,
      expires_in_ms: entry.expiresAt != null ? Math.max(0, entry.expiresAt - ts) : null,
    });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return {
    stats: { ...store.stats },
    entries: rows,
  };
}
