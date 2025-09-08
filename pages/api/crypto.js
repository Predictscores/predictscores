// pages/api/crypto.js
// API sa "compat" projekcijom: dodaje ALIAS signals + shape=slim + aliasi za Entry/TP/SL.
// Propusta Entry/SL/TP/expectedMove/rr/valid_until iz core-a. Fudbal se ne dotiče.

import { buildSignals } from "../../lib/crypto-core";

const {
  COINGECKO_API_KEY = "",
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRON_KEY = "",
  CRYPTO_TOP_N = "3",
  CRYPTO_MIN_VOL_USD = "50000000",
  CRYPTO_MIN_MCAP_USD = "200000000",
  CRYPTO_COOLDOWN_MIN = "30",
  CRYPTO_REFRESH_MINUTES = "45",
  CRYPTO_QUORUM_VOTES = "3",
  CRYPTO_BINANCE_TOP = "150",
  CRYPTO_FORCE_THROTTLE_SEC = "240",
} = process.env;

const CFG = {
  TOP_N: clampInt(CRYPTO_TOP_N, 3, 1, 10),
  MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 50_000_000),
  MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 200_000_000),
  COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 30, 0, 1440),
  REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
  QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 3, 3, 5),
  BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 150, 20, 400),
  FORCE_TTL: clampInt(CRYPTO_FORCE_THROTTLE_SEC, 240, 30, 3600),
};

export default async function handler(req, res) {
  try {
    const force = parseBool(req.query.force || "0");
    const n = clampInt(req.query.n, CFG.TOP_N, 1, 10);
    const shape = String(req.query.shape || "").toLowerCase(); // "legacy" | "slim"

    if (force) {
      if (!checkCronKey(req, CRON_KEY)) return res.status(401).json({ ok: false, error: "unauthorized" });
      if (await isForceThrottled()) return res.status(429).json({ ok: false, error: "too_many_requests" });
    }

    const cacheKey = "crypto:signals:latest";
    const cached = await kvGetJSON(cacheKey);
    if (!force && cached && Array.isArray(cached.items) && cached.items.length) {
      const arr = projectForUI(cached.items).sort((a,b)=>b.confidence_pct - a.confidence_pct).slice(0, n);
      return sendCompat(res, {
        ok: true, version: "crypto-v1-compat", sport: "crypto",
        source: "cache", ts: cached.ts || Date.now(), ttl_min: cached.ttl_min || CFG.REFRESH_MIN,
        count: arr.length, items: arr,
      }, shape);
    }

    const itemsRaw = await buildSignals({
      cgApiKey: COINGECKO_API_KEY,
      minVol: CFG.MIN_VOL,
      minMcap: CFG.MIN_MCAP,
      quorum: CFG.QUORUM,
      binanceTop: CFG.BINANCE_TOP,
    });

    const itemsStable = await applyStickiness(itemsRaw, CFG.COOLDOWN_MIN);
    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items: itemsStable };
    await kvSetJSON(cacheKey, payload, CFG.REFRESH_MIN * 60);
    if (force) await setForceLock();

    const arr = projectForUI(itemsStable).sort((a,b)=>b.confidence_pct - a.confidence_pct).slice(0, n);
    return sendCompat(res, {
      ok: true, version: "crypto-v1-compat", sport: "crypto",
      source: "live", ts: payload.ts, ttl_min: payload.ttl_min,
      count: arr.length, items: arr,
    }, shape);

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------- projection / aliases ---------- */
function projectForUI(list) {
  return (Array.isArray(list) ? list : []).map((it) => {
    const dir = String(it.signal || "").toLowerCase(); // long/short
    const isLong = dir === "long";
    const isShort = dir === "short";

    const m30 = numOr0(it.m30_pct);
    const h1  = numOr0(it.h1_pct);
    const h4  = numOr0(it.h4_pct);
    const d24 = numOr0(it.d24_pct);
    const d7  = numOr0(it.d7_pct);

    // ---- aliasi za nivoe (bitno za SignalCard) ----
    const entry = (it.entry ?? it.entryPrice ?? null);
    const tp    = (it.tp ?? it.takeProfit ?? it.tpPrice ?? null);
    const sl    = (it.sl ?? it.stopLoss ?? it.slPrice ?? null);

    return {
      ...it,

      // canonical
      type: "crypto", sport: "crypto", category: "crypto", market: "crypto",
      ticker: it.symbol, symbolUpper: String(it.symbol || "").toUpperCase(),

      // direction aliases
      direction: dir, side: dir, action: isLong ? "BUY" : "SELL", isLong, isShort,

      // confidence aliases
      confidence: it.confidence_pct, confidenceScore: it.confidence_pct, score: it.confidence_pct,

      // timeframe aliases (numbers only)
      m30_pct: m30, h1_pct: h1, h4_pct: h4, d24_pct: d24, d7_pct: d7,
      change30m: m30, change1h: h1, change4h: h4, change24h: d24, change7d: d7,

      // ----- LEVELS (sa svim popularnim imenima) -----
      entry, entryPrice: entry,
      tp, takeProfit: tp, tpPrice: tp, targetPrice: tp,
      sl, stopLoss: sl, slPrice: sl,
      rr: it.rr ?? it.riskReward ?? null,
      valid_until: it.valid_until ?? it.validUntil ?? null,
      validUntil: it.valid_until ?? it.validUntil ?? null,
    };
  });
}

function sendCompat(res, base, shape) {
  const items = base.items || [];
  const out = {
    ...base,
    signals: items,      // front čita ovo
    data: items, predictions: items, rows: items, list: items, results: items,
    total: base.count,
  };
  if (shape === "legacy") return res.status(200).json({ ok: out.ok, total: out.count, items: out.items, ...out });
  if (shape === "slim")   return res.status(200).json(items);
  return res.status(200).json(out);
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
    if (!last) { bySymbol[it.symbol] = snap(it); return true; }
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

/* ---------- KV/throttle/security ---------- */
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
async function isForceThrottled() {
  if (!UPSTASH_REDIS_REST_URL) return false;
  const v = await kvGetJSON("crypto:force:lock");
  return !!v;
}
async function setForceLock() {
  if (!UPSTASH_REDIS_REST_URL) return;
  await kvSetJSON("crypto:force:lock", { ts: Date.now() }, CFG.FORCE_TTL);
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

/* ---------- utils ---------- */
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clampInt(v, def, min, max) { const n = parseInt(v,10); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function parseBool(x){ return String(x).toLowerCase()==="1"||String(x).toLowerCase()==="true"; }
function numOr0(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
