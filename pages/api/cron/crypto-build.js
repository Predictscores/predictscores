// pages/api/cron/crypto-build.js
// Stable builder endpoint: builds crypto signals, writes them to KV and history.

import { buildSignals, validateCoinGeckoApiKey } from "../../../lib/crypto-core";
import { upstashFallbackGet, upstashFallbackSet } from "../../../lib/upstash-fallback";

const MIN_EXPECTED_MOVE_DEFAULT = 1.5;

export default async function handler(req, res) {
  const expectedKey = process.env.CRON_KEY || "";
  const providedKey = String(req.query.key || "");
  if (!expectedKey || providedKey !== expectedKey) {
    return res.status(401).json({ ok: false, reason: "bad key" });
  }

  const debug = String(req.query.debug || "") === "1";
  const trace = debug ? [] : null;
  const pushTrace = (stage, data) => {
    if (trace) trace.push({ stage, ...(data || {}) });
  };

  try {
    const envReport = summarizeCoinGeckoEnv({
      apiKey: process.env.COINGECKO_API_KEY,
      coingeckoFree: process.env.COINGECKO_FREE,
      upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
      upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    pushTrace("env", { summary: envReport.summary, missing: envReport.missing });

    if (!envReport.ok) {
      const body = {
        ok: false,
        error: "coingecko_env_incomplete",
        missing: envReport.missing,
      };
      if (trace) body.trace = trace;
      return res.status(500).json(body);
    }

    const cfg = readConfig();
    pushTrace("cfg", {
      refresh_min: cfg.REFRESH_MIN,
      min_vol: cfg.MIN_VOL,
      min_mcap: cfg.MIN_MCAP,
    });

    const cacheKey = "crypto:signals:latest";
    const freeMode = envReport.free ?? parseBool(process.env.COINGECKO_FREE);
    let itemsRaw = [];

    try {
      pushTrace("build:start", { mode: freeMode ? "free" : "pro" });
      itemsRaw = await buildSignals({
        cgApiKey: process.env.COINGECKO_API_KEY,
        cgFree: freeMode,
        minVol: cfg.MIN_VOL,
        minMcap: cfg.MIN_MCAP,
        quorum: cfg.QUORUM,
        binanceTop: cfg.BINANCE_TOP,
      });
      pushTrace("build:done", { count: Array.isArray(itemsRaw) ? itemsRaw.length : 0 });
    } catch (err) {
      if (isCoinGeckoApiKeyError(err)) {
        pushTrace("error", { type: "coingecko_api_key", code: err?.code || null });
        const body = { ok: false, error: err?.code || "coingecko_api_key_missing" };
        if (trace) body.trace = trace;
        return res.status(500).json(body);
      }
      if (isCoinGeckoQuotaError(err)) {
        const snapshot = await kvGetJSON(cacheKey);
        const quota = quotaDetails(err);
        if (snapshot && Array.isArray(snapshot.items) && snapshot.items.length) {
          const ageMin = snapshot.ts ? (Date.now() - snapshot.ts) / 60000 : null;
          pushTrace("quota", { mode: "cache_quota", count: snapshot.items.length });
          const body = {
            ok: true,
            saved: 0,
            ttl_min: snapshot.ttl_min || cfg.REFRESH_MIN,
            source: "cache_quota",
            count: snapshot.items.length,
            cache_age_min: Number.isFinite(ageMin) ? ageMin : null,
            quota,
          };
          if (trace) body.trace = trace;
          return res.status(200).json(body);
        }
        pushTrace("quota", { mode: "none" });
        const body = {
          ok: true,
          saved: 0,
          ttl_min: cfg.REFRESH_MIN,
          source: "none",
          quota,
        };
        if (trace) body.trace = trace;
        return res.status(200).json(body);
      }
      pushTrace("error", { type: "unexpected_build", message: String(err?.message || err) });
      throw err;
    }

    const beforePolicy = Array.isArray(itemsRaw) ? itemsRaw.length : 0;
    let items = enforcePolicy(itemsRaw, cfg);
    pushTrace("policy", { before: beforePolicy, after: items.length });

    const afterPolicy = items.length;
    items = await applyPersistenceAndDedup(items, cfg);
    pushTrace("persistence", { before: afterPolicy, after: items.length });

    const afterPersist = items.length;
    items = await applyStickiness(items, cfg.COOLDOWN_MIN);
    pushTrace("stickiness", { before: afterPersist, after: items.length });

    const payload = { ts: Date.now(), ttl_min: cfg.REFRESH_MIN, items };
    await kvSetJSON(cacheKey, payload, cfg.REFRESH_MIN * 60);
    pushTrace("kv", { action: "set", key: cacheKey, count: items.length });

    await logHistory(items, payload.ts, cfg);
    pushTrace("history", { count: items.length });

    const body = {
      ok: true,
      saved: items.length,
      ttl_min: payload.ttl_min,
      ts: payload.ts,
      count: items.length,
    };
    if (trace) body.trace = trace;

    return res.status(200).json(body);
  } catch (err) {
    console.error("[cron/crypto-build] unexpected error", err);
    const body = { ok: false, error: String(err?.message || err) };
    if (trace) body.trace = trace;
    return res.status(500).json(body);
  }
}

function readConfig() {
  const {
    CRYPTO_MIN_VOL_USD = "50000000",
    CRYPTO_MIN_MCAP_USD = "200000000",
    CRYPTO_REFRESH_MINUTES = "45",
    CRYPTO_QUORUM_VOTES = "3",
    CRYPTO_BINANCE_TOP = "150",
    CRYPTO_MIN_RR = "0",
    CRYPTO_MIN_EXPECTED_MOVE_PCT = "0",
    CRYPTO_REQUIRE_H1_H4 = "0",
    CRYPTO_INCLUDE_7D = "1",
    CRYPTO_PERSIST_SNAPSHOTS = "0",
    CRYPTO_DEDUP_WINDOW_MIN = "0",
    CRYPTO_PRICE_DIVERGENCE_MAX_PCT = "0",
    CRYPTO_COOLDOWN_MIN = "0",
    CRYPTO_HISTORY_TTL_DAYS = "60",
    CRYPTO_HISTORY_MAX_IDS = "5000",
  } = process.env;

  const minExpectedMove = normalizeMinExpectedMove(
    CRYPTO_MIN_EXPECTED_MOVE_PCT,
    MIN_EXPECTED_MOVE_DEFAULT
  );

  return {
    MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 50_000_000),
    MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 200_000_000),
    REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
    QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 3, 3, 5),
    BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 150, 20, 400),

    MIN_RR: toNum(CRYPTO_MIN_RR, 0),
    MIN_EM: minExpectedMove,
    REQUIRE_H1H4: parseBool(CRYPTO_REQUIRE_H1_H4),
    INCLUDE_7D: parseBool(CRYPTO_INCLUDE_7D, true),
    PERSIST_SNAPSHOTS: clampInt(CRYPTO_PERSIST_SNAPSHOTS, 0, 0, 10),
    DEDUP_MIN: clampInt(CRYPTO_DEDUP_WINDOW_MIN, 0, 0, 2880),
    DIVERGENCE_MAX: toNum(CRYPTO_PRICE_DIVERGENCE_MAX_PCT, 0),

    COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 0, 0, 1440),

    HIST_TTL_SEC: clampInt(CRYPTO_HISTORY_TTL_DAYS, 60, 1, 365) * 86400,
    HIST_MAX_IDS: clampInt(CRYPTO_HISTORY_MAX_IDS, 5000, 100, 100000),
  };
}

function normalizeMinExpectedMove(value, fallback) {
  const parsed = toNum(value, fallback);
  if (parsed <= 0) return fallback;
  return Math.max(parsed, fallback);
}

function summarizeCoinGeckoEnv({
  apiKey,
  coingeckoFree,
  upstashUrl,
  upstashToken,
  fallbackStore,
} = {}) {
  const freeMode = parseBool(coingeckoFree ?? process.env.COINGECKO_FREE ?? "0");
  const fallbackActive = detectFallbackStore(fallbackStore);

  const resolvedUrl = typeof upstashUrl === "string" ? upstashUrl : process.env.UPSTASH_REDIS_REST_URL;
  const resolvedToken = typeof upstashToken === "string" ? upstashToken : process.env.UPSTASH_REDIS_REST_TOKEN;
  const resolvedApiKey = typeof apiKey === "string" ? apiKey : process.env.COINGECKO_API_KEY;

  const validation = validateCoinGeckoApiKey(resolvedApiKey);
  const missing = [];

  const keyStatus = (() => {
    if (freeMode) {
      return validation.ok ? "present" : "skipped";
    }
    if (validation.ok) return "present";
    return validation.code || "missing";
  })();

  if (!freeMode && !validation.ok) {
    missing.push("coingecko_api_key");
  }

  if (!fallbackActive) {
    if (!hasValue(resolvedUrl)) missing.push("upstash_url");
    if (!hasValue(resolvedToken)) missing.push("upstash_token");
  }

  const log = {
    mode: freeMode ? "FREE" : "PAID",
    store: fallbackActive ? "fallback" : "upstash",
    coingecko_api_key: keyStatus,
  };

  const summary = JSON.stringify(log);
  const missingUnique = [...new Set(missing)];

  return {
    ok: missingUnique.length === 0,
    summary,
    missing: missingUnique,
    free: freeMode,
  };
}

function detectFallbackStore(value) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    if (value.available === true) return true;
    if (typeof value.mode === "string" && value.mode.toLowerCase() === "fallback") return true;
    if (typeof value.store === "string" && value.store.toLowerCase() === "fallback") return true;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "true" || trimmed === "fallback" || trimmed === "yes") return true;
  }

  const tokenHints = [
    process.env.CRYPTO_FALLBACK_STORE_TOKEN,
    process.env.CRYPTO_STORE_FALLBACK_TOKEN,
  ];
  if (tokenHints.some((raw) => typeof raw === "string" && raw.trim())) return true;

  const urlHints = [
    process.env.CRYPTO_FALLBACK_STORE_URL,
    process.env.CRYPTO_STORE_FALLBACK_URL,
  ];
  if (urlHints.some((raw) => typeof raw === "string" && raw.trim())) return true;

  return false;
}

function hasValue(raw) {
  return typeof raw === "string" && raw.trim().length > 0;
}

function isCoinGeckoQuotaError(err) {
  if (!err) return false;
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (code === "coingecko_quota_exceeded") return true;
  return message.includes("coingecko_quota_exceeded");
}

function isCoinGeckoApiKeyError(err) {
  if (!err) return false;
  const code = typeof err.code === "string" ? err.code : "";
  if (code === "coingecko_api_key_missing" || code === "coingecko_api_key_invalid") return true;
  const message = typeof err.message === "string" ? err.message : "";
  return message.includes("coingecko_api_key_missing") || message.includes("coingecko_api_key_invalid");
}

function quotaDetails(err) {
  const details = err && typeof err === "object" && err.details && typeof err.details === "object" ? err.details : {};
  const minuteCount = Number(details.minuteCount ?? details.minute_count);
  const dayCount = Number(details.dayCount ?? details.day_count);
  const minuteLimit = Number(details.minuteLimit ?? details.minute_limit);
  const dayLimit = Number(details.dayLimit ?? details.day_limit);
  const backend = typeof details.backend === "string" ? details.backend : null;
  return {
    code: "coingecko_quota_exceeded",
    minute_count: Number.isFinite(minuteCount) ? minuteCount : null,
    day_count: Number.isFinite(dayCount) ? dayCount : null,
    minute_limit: Number.isFinite(minuteLimit) ? minuteLimit : 30,
    day_limit: Number.isFinite(dayLimit) ? dayLimit : 300,
    backend,
  };
}

async function applyPersistenceAndDedup(items, cfg) {
  const now = Date.now();
  const persistKey = "crypto:persist:v1";
  const prevPersist = (await kvGetJSON(persistKey)) || {};
  const nextPersist = {};

  const dedupKey = "crypto:dedup:v1";
  const prevDedup = (await kvGetJSON(dedupKey)) || {};
  const nextDedup = { ...prevDedup };

  const out = [];
  for (const it of items) {
    const sym = String(it.symbol || it.ticker || "").toUpperCase();
    const dir = String(it.signal || it.direction || "").toUpperCase();

    if (cfg.DEDUP_MIN > 0) {
      const lastTs = prevDedup[sym] || 0;
      const ageMin = (now - lastTs) / 60000;
      if (ageMin < cfg.DEDUP_MIN) continue;
    }

    let rec = prevPersist[sym];
    if (!rec || rec.dir !== dir) rec = { dir, count: 0, ts: 0 };
    rec.count += 1;
    rec.ts = now;
    nextPersist[sym] = rec;

    if (cfg.PERSIST_SNAPSHOTS > 0 && rec.count < cfg.PERSIST_SNAPSHOTS) continue;

    nextDedup[sym] = now;
    out.push(it);
  }

  await kvSetJSON(persistKey, nextPersist, 24 * 3600);
  await kvSetJSON(dedupKey, nextDedup, 24 * 3600);

  return out;
}

async function applyStickiness(items, cooldownMin) {
  if (!cooldownMin || cooldownMin <= 0) return items;
  const key = "crypto:signals:last";
  const prev = await kvGetJSON(key);
  const now = Date.now();
  const bySymbol = {};
  const STICKINESS_DELTA = 0.15;

  const filtered = (items || []).filter((it) => {
    const last = prev?.bySymbol?.[it.symbol];
    if (!last) {
      bySymbol[it.symbol] = snap(it);
      return true;
    }
    const ageMin = (now - (last.ts || 0)) / 60000;
    const scoreNow = (it.confidence_pct - 55) / 40;
    const scorePrev = last.score != null ? last.score : (last.confidence_pct - 55) / 40;
    if (ageMin < cooldownMin && it.signal !== last.signal) {
      if (scoreNow - scorePrev < STICKINESS_DELTA) return false;
    }
    bySymbol[it.symbol] = { signal: it.signal, score: scoreNow, confidence_pct: it.confidence_pct, ts: now };
    return true;
  });

  await kvSetJSON(key, { ts: now, bySymbol }, 24 * 3600);
  return filtered;

  function snap(x) {
    return {
      signal: x.signal,
      score: (x.confidence_pct - 55) / 40,
      confidence_pct: x.confidence_pct,
      ts: now,
    };
  }
}

async function logHistory(items, snapshotTs, cfg) {
  if (!Array.isArray(items) || !items.length) return;
  const indexKey = "crypto:history:index";
  const idx = (await kvGetJSON(indexKey)) || { ids: [] };

  const toAdd = [];
  for (const it of items) {
    const sym = String(it.symbol || it.ticker || "").toUpperCase();
    const id = `${sym}:${snapshotTs}`;
    const rec = {
      id,
      ts: snapshotTs,
      symbol: sym,
      name: it.name || sym,
      side: String(it.signal || it.direction || "").toUpperCase(),
      exchange: it.exchange || null,
      pair: it.pair || `${sym}-USDT`,
      entry: Number.isFinite(it.entry) ? it.entry : null,
      sl: Number.isFinite(it.sl) ? it.sl : null,
      tp: Number.isFinite(it.tp) ? it.tp : null,
      rr: Number.isFinite(it.rr) ? it.rr : null,
      expectedMove: Number.isFinite(it.expectedMove) ? it.expectedMove : null,
      confidence_pct: Number.isFinite(it.confidence_pct) ? it.confidence_pct : null,
      valid_until: it.valid_until || null,

      m30_pct: numOrNull(it.m30_pct),
      h1_pct: numOrNull(it.h1_pct),
      h4_pct: numOrNull(it.h4_pct),
      d24_pct: numOrNull(it.d24_pct),
      d7_pct: numOrNull(it.d7_pct),
      votes: sanitizeVotes(it.votes),

      outcome: null,
      win: null,
      exit_price: null,
      time_to_hit_min: null,
      realized_rr: null,
      evaluated_ts: null,
    };

    await kvSetJSON(`crypto:history:item:${id}`, rec, cfg.HIST_TTL_SEC);
    toAdd.push(id);
  }

  const all = Array.isArray(idx.ids) ? idx.ids : [];
  const newIds = [...toAdd, ...all].slice(0, cfg.HIST_MAX_IDS);
  await kvSetJSON(indexKey, { ids: newIds, ts: Date.now() }, cfg.HIST_TTL_SEC);
}

async function kvGetJSON(key) {
  if (!key) return null;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url) {
    try {
      const u = `${url.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: authHeader(token), cache: "no-store" });
      if (!r.ok) return null;
      const raw = await r.json().catch(() => null);
      const val = raw?.result;
      if (!val) return null;
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    } catch {
      // fall back below
    }
  }
  const fallbackVal = upstashFallbackGet(key);
  if (fallbackVal == null) return null;
  try {
    return JSON.parse(fallbackVal);
  } catch {
    return null;
  }
}

async function kvSetJSON(key, obj, ttlSec) {
  if (!key) return;
  const value = JSON.stringify(obj);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url) {
    try {
      const base = url.replace(/\/+$/, "");
      const u = new URL(`${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`);
      if (ttlSec && ttlSec > 0) u.searchParams.set("EX", String(ttlSec));
      await fetch(u.toString(), { headers: authHeader(token), cache: "no-store" }).catch(() => {});
      return;
    } catch {
      // fall back below
    }
  }
  upstashFallbackSet(key, value, { ttlSeconds: ttlSec });
}

function authHeader(token) {
  const h = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function parseBool(x, def = false) {
  const s = String(x).toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  return def;
}

function toNum(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeVotes(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const key of ["m30", "h1", "h4", "d24", "d7", "sum"]) {
    const n = Number(v[key]);
    out[key] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function enforcePolicy(list, cfg) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (cfg.MIN_RR > 0 && !(Number.isFinite(it.rr) && it.rr >= cfg.MIN_RR)) continue;
    if (cfg.MIN_EM > 0 && !(Number.isFinite(it.expectedMove) && it.expectedMove >= cfg.MIN_EM)) continue;

    const s1 = Math.sign(numOr0(it.h1_pct));
    const s4 = Math.sign(numOr0(it.h4_pct));
    if (cfg.REQUIRE_H1H4 && s1 !== 0 && s4 !== 0 && s1 !== s4) continue;

    if (!cfg.INCLUDE_7D) {
      const m30 = Math.sign(numOr0(it.m30_pct));
      const h1 = Math.sign(numOr0(it.h1_pct));
      const h4 = Math.sign(numOr0(it.h4_pct));
      const d24 = Math.sign(numOr0(it.d24_pct));
      const sumNo7d = m30 + h1 + h4 + d24;
      if (sumNo7d === 0) continue;
      const dirNo7d = sumNo7d > 0 ? "LONG" : "SHORT";
      if (dirNo7d !== it.signal) continue;
    }

    if (cfg.DIVERGENCE_MAX > 0 && Number.isFinite(it.cg_price) && Number.isFinite(it.price)) {
      const divPct = Math.abs(it.price - it.cg_price) / Math.max(it.cg_price, 1e-9) * 100;
      if (divPct > cfg.DIVERGENCE_MAX) continue;
    }

    out.push(it);
  }
  return out;
}
