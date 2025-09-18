// pages/api/cron/crypto-watchdog.js
// Watchdog: izračuna signale i napiše ih u KV (sa Entry/TP/SL), + upis u istoriju.

import { buildSignals, validateCoinGeckoApiKey } from "../../../lib/crypto-core";

const {
  COINGECKO_API_KEY = "",
  COINGECKO_FREE = "",
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRON_KEY = "",

  // osnovno
  CRYPTO_MIN_VOL_USD = "50000000",
  CRYPTO_MIN_MCAP_USD = "200000000",
  CRYPTO_REFRESH_MINUTES = "45",
  CRYPTO_QUORUM_VOTES = "3",
  CRYPTO_BINANCE_TOP = "150",

  // kvalitet/polisa
  CRYPTO_MIN_RR = "0",
  CRYPTO_MIN_EXPECTED_MOVE_PCT = "0",
  CRYPTO_REQUIRE_H1_H4 = "0",
  CRYPTO_INCLUDE_7D = "1",
  CRYPTO_PERSIST_SNAPSHOTS = "0",
  CRYPTO_DEDUP_WINDOW_MIN = "0",
  CRYPTO_PRICE_DIVERGENCE_MAX_PCT = "0",

  // „lepljivost“
  CRYPTO_COOLDOWN_MIN = "0",

  // istorija/statistika
  CRYPTO_HISTORY_TTL_DAYS = "60",
  CRYPTO_HISTORY_MAX_IDS = "5000",
} = process.env;

const MIN_EXPECTED_MOVE_DEFAULT = 1.5;
const MIN_EXPECTED_MOVE = normalizeMinExpectedMove(CRYPTO_MIN_EXPECTED_MOVE_PCT, MIN_EXPECTED_MOVE_DEFAULT);

const CFG = {
  MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 50_000_000),
  MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 200_000_000),
  REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
  QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 3, 3, 5),
  BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 150, 20, 400),

  MIN_RR: toNum(CRYPTO_MIN_RR, 0),
  MIN_EM: MIN_EXPECTED_MOVE,
  REQUIRE_H1H4: parseBool(CRYPTO_REQUIRE_H1_H4),
  INCLUDE_7D: parseBool(CRYPTO_INCLUDE_7D, true),
  PERSIST_SNAPSHOTS: clampInt(CRYPTO_PERSIST_SNAPSHOTS, 0, 0, 10),
  DEDUP_MIN: clampInt(CRYPTO_DEDUP_WINDOW_MIN, 0, 0, 2880),
  DIVERGENCE_MAX: toNum(CRYPTO_PRICE_DIVERGENCE_MAX_PCT, 0),

  COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 0, 0, 1440),

  HIST_TTL_SEC: clampInt(CRYPTO_HISTORY_TTL_DAYS, 60, 1, 365) * 86400,
  HIST_MAX_IDS: clampInt(CRYPTO_HISTORY_MAX_IDS, 5000, 100, 100000),
};

export default async function handler(req, res) {
  try {
    if (!checkCronKey(req, CRON_KEY)) {
      return res
        .status(401)
        .json({ ok: true, triggered: true, upstream: { ok: false, status: 401 } });
    }

    const envReport = summarizeCoinGeckoEnv({
      apiKey: COINGECKO_API_KEY,
      coingeckoFree: COINGECKO_FREE,
      upstashUrl: UPSTASH_REDIS_REST_URL,
      upstashToken: UPSTASH_REDIS_REST_TOKEN,
    });
    console.log(`[cron] coingecko env: ${envReport.summary}`);
    if (!envReport.ok) {
      return res.status(500).json({
        ok: false,
        error: "coingecko_env_incomplete",
        missing: envReport.missing,
      });
    }

    const cacheKey = "crypto:signals:latest";

    // 1) kandidati
    let itemsRaw;
    try {
      itemsRaw = await buildSignals({
        cgApiKey: COINGECKO_API_KEY,
        minVol: CFG.MIN_VOL,
        minMcap: CFG.MIN_MCAP,
        quorum: CFG.QUORUM,
        binanceTop: CFG.BINANCE_TOP,
      });
    } catch (err) {
      if (isCoinGeckoApiKeyError(err)) {
        console.error("[cron/crypto-watchdog] CoinGecko API key error", {
          code: err?.code || null,
          message: err?.message || null,
        });
        return res.status(500).json({ ok: false, error: err?.code || "coingecko_api_key_missing" });
      }
      if (isCoinGeckoQuotaError(err)) {
        const snapshot = await kvGetJSON(cacheKey);
        if (snapshot && Array.isArray(snapshot.items) && snapshot.items.length) {
          console.warn(
            `[cron/crypto-watchdog] CoinGecko quota exhausted; using cached snapshot (${snapshot.items.length}).`,
            err?.details || err
          );
          const ageMin = snapshot.ts ? (Date.now() - snapshot.ts) / 60000 : null;
          return res.status(200).json({
            ok: true,
            handled: "coingecko_quota_exceeded",
            wrote: false,
            source: "cache_quota",
            ts: snapshot.ts || Date.now(),
            ttl_min: snapshot.ttl_min || CFG.REFRESH_MIN,
            count: snapshot.items.length,
            sample: snapshot.items.slice(0, 2),
            quota: quotaDetails(err),
            cache_age_min: Number.isFinite(ageMin) ? ageMin : null,
          });
        }
        console.warn(
          `[cron/crypto-watchdog] CoinGecko quota exhausted; no cached snapshot available.`,
          err?.details || err
        );
        return res.status(200).json({
          ok: true,
          handled: "coingecko_quota_exceeded",
          wrote: false,
          source: "none",
          quota: quotaDetails(err),
        });
      }
      throw err;
    }

    // 2) policy filteri
    let items = enforcePolicy(itemsRaw, CFG);

    // 3) persist + dedup + anti-flip
    items = await applyPersistenceAndDedup(items, CFG);
    items = await applyStickiness(items, CFG.COOLDOWN_MIN);

    // 4) upiši u KV (snapshot)
    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items };
    await kvSetJSON(cacheKey, payload, CFG.REFRESH_MIN * 60);

    // 5) ⬇⬇⬇  NOVO: upiši svaki signal u istoriju  ⬇⬇⬇
    await logHistory(items, payload.ts, CFG);

    return res.status(200).json({
      ok: true,
      wrote: true,
      ts: payload.ts,
      ttl_min: payload.ttl_min,
      count: items.length,
      sample: items.slice(0, 2),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------- Policy filter (RR/EM/H1=H4/7d/divergence) ---------- */
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
  const mode = freeMode ? "FREE" : "PAID";

  const validation = validateCoinGeckoApiKey(apiKey);
  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  let keyStatus = validation.ok ? "present" : validation.code === "missing" ? "missing" : "invalid";
  if (freeMode) {
    keyStatus = trimmedKey ? (validation.ok ? "present" : "invalid") : "skipped";
  }

  const urlStatus = String(upstashUrl || "").trim() ? "present" : "missing";
  const tokenStatus = String(upstashToken || "").trim() ? "present" : "missing";
  const upstashStatus =
    urlStatus === "present" && tokenStatus === "present"
      ? "present"
      : urlStatus === "missing" && tokenStatus === "missing"
      ? "missing"
      : "partial";

  const missing = [];
  if (!freeMode && !validation.ok) {
    missing.push({ name: "coingecko_api_key", status: keyStatus });
  }
  if (!fallbackActive) {
    if (urlStatus !== "present") missing.push({ name: "upstash_redis_rest_url", status: urlStatus });
    if (tokenStatus !== "present") missing.push({ name: "upstash_redis_rest_token", status: tokenStatus });
  }

  const summaryParts = [
    `mode=${mode}`,
    `store=${fallbackActive ? "FALLBACK" : "UPSTASH"}`,
    `key=${keyStatus}`,
    `upstash=${upstashStatus}`,
  ];

  const log = {
    mode,
    store: fallbackActive ? "fallback" : "upstash",
    coingecko_api_key: keyStatus,
    upstash: upstashStatus,
    upstash_redis_rest_url: urlStatus,
    upstash_redis_rest_token: tokenStatus,
  };

  return {
    ok: missing.length === 0,
    log,
    missing,
    summary: summaryParts.join(", "),
    mode,
    fallbackStore: fallbackActive,
    free: freeMode,
  };
}

function detectFallbackStore(hint) {
  const inspect = (value) => {
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      for (const it of value) {
        const res = inspect(it);
        if (res != null) return res;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const it of Object.values(value)) {
        const res = inspect(it);
        if (res != null) return res;
      }
      return null;
    }
    const s = String(value || "").trim().toLowerCase();
    if (!s) return null;
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "off", "no"].includes(s)) return false;
    if (s.includes("fallback")) return true;
    if (s.includes("vercel")) return true;
    if (["free", "demo", "readonly", "offline"].includes(s)) return true;
    return null;
  };

  const direct = inspect(hint);
  if (direct != null) return direct;

  const envKeys = [
    "CRYPTO_FALLBACK_STORE",
    "CRYPTO_FALLBACK_STORE_ACTIVE",
    "CRYPTO_STORE_FALLBACK",
    "CRYPTO_STORE_FALLBACK_ACTIVE",
    "CRYPTO_USE_FALLBACK_STORE",
    "CRYPTO_STORE_MODE",
    "CRYPTO_STORE_DRIVER",
    "CRYPTO_STORE_FLAVOR",
    "CRYPTO_STORE_PROVIDER",
    "CRYPTO_STORE_KIND",
    "CRYPTO_STORE_TARGET",
    "CRYPTO_STORE",
    "CRYPTO_STORE_STRATEGY",
  ];
  for (const key of envKeys) {
    const res = inspect(process.env[key]);
    if (res != null) return res;
  }

  const urlHints = [
    process.env.CRYPTO_FALLBACK_STORE_URL,
    process.env.CRYPTO_STORE_FALLBACK_URL,
  ];
  if (urlHints.some((raw) => typeof raw === "string" && raw.trim())) return true;

  const tokenHints = [
    process.env.CRYPTO_FALLBACK_STORE_TOKEN,
    process.env.CRYPTO_STORE_FALLBACK_TOKEN,
  ];
  if (tokenHints.some((raw) => typeof raw === "string" && raw.trim())) return true;

  return false;
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
  return {
    code: "coingecko_quota_exceeded",
    minute_count: Number.isFinite(minuteCount) ? minuteCount : null,
    day_count: Number.isFinite(dayCount) ? dayCount : null,
    minute_limit: Number.isFinite(minuteLimit) ? minuteLimit : 30,
    day_limit: Number.isFinite(dayLimit) ? dayLimit : 300,
  };
}

/* ---------- persistence & dedup ---------- */
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

/* ---------- anti-flip ---------- */
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
    const scorePrev = (last.score != null ? last.score : (last.confidence_pct - 55) / 40);
    if (ageMin < cooldownMin && it.signal !== last.signal) {
      if (scoreNow - scorePrev < STICKINESS_DELTA) return false;
    }
    bySymbol[it.symbol] = { signal: it.signal, score: scoreNow, confidence_pct: it.confidence_pct, ts: now };
    return true;
  });

  await kvSetJSON(key, { ts: now, bySymbol }, 24 * 3600);
  return filtered;

  function snap(x) { return { signal: x.signal, score: (x.confidence_pct - 55) / 40, confidence_pct: x.confidence_pct, ts: now }; }
}

/* ---------- ISTORIJA: upis svakog signala ---------- */
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
      side: String(it.signal || it.direction || "").toUpperCase(),  // LONG/SHORT
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

      // outcome polja (popunjava evaluator)
      outcome: null,            // "tp" | "sl" | "expired" | "tie"
      win: null,                // 1/0
      exit_price: null,
      time_to_hit_min: null,
      realized_rr: null,
      evaluated_ts: null,
    };

    await kvSetJSON(`crypto:history:item:${id}`, rec, cfg.HIST_TTL_SEC);
    toAdd.push(id);
  }

  // održi indeks poslednjih N id-jeva (FIFO)
  const all = Array.isArray(idx.ids) ? idx.ids : [];
  const newIds = [...toAdd, ...all].slice(0, cfg.HIST_MAX_IDS);
  await kvSetJSON(indexKey, { ids: newIds, ts: Date.now() }, cfg.HIST_TTL_SEC);
}

/* ---------- KV & utils ---------- */
async function kvGetJSON(key) {
  if (!UPSTASH_REDIS_REST_URL) return null;
  const u = `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(u, { headers: authHeader(), cache: "no-store" });
  if (!r.ok) return null;
  const raw = await r.json().catch(() => null);
  const val = raw?.result;
  if (!val) return null;
  try { return JSON.parse(val); } catch { return null; }
}
async function kvSetJSON(key, obj, ttlSec) {
  if (!UPSTASH_REDIS_REST_URL) return;
  const value = JSON.stringify(obj);
  const u = new URL(`${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`);
  if (ttlSec && ttlSec > 0) u.searchParams.set("EX", String(ttlSec));
  await fetch(u.toString(), { headers: authHeader(), cache: "no-store" }).catch(() => {});
}
function authHeader() {
  const h = {};
  if (UPSTASH_REDIS_REST_TOKEN) h["Authorization"] = `Bearer ${UPSTASH_REDIS_REST_TOKEN}`;
  return h;
}
function checkCronKey(req, expected) {
  if (!expected) return false;
  const q = String(req.query.key || "");
  const h = String(req.headers["x-cron-key"] || "");
  const auth = String(req.headers["authorization"] || "");
  if (q && q === expected) return true;
  if (h && h === expected) return true;
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7) === expected) return true;
  return false;
}
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clampInt(v, def, min, max) { const n = parseInt(v, 10); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function parseBool(x, def = false) { const s = String(x).toLowerCase(); if (s==="1"||s==="true") return true; if (s==="0"||s==="false") return false; return def; }
function numOr0(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function numOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function sanitizeVotes(v){
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const key of ["m30","h1","h4","d24","d7","sum"]) {
    const n = Number(v[key]);
    out[key] = Number.isFinite(n) ? n : 0;
  }
  return out;
}
