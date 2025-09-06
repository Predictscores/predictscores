// pages/api/crypto.js
// API sa "compat" projekcijom za postojeći UI: dodaje alias polja i top-level duplikate.
// Core i KV keš ostaju isti (buildSignals u lib/crypto-core.js).
import { buildSignals } from "../../lib/crypto-core";

const {
  COINGECKO_API_KEY = "",
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRON_KEY = "",
  CRYPTO_TOP_N = "5",
  CRYPTO_MIN_VOL_USD = "50000000",
  CRYPTO_MIN_MCAP_USD = "200000000",
  CRYPTO_COOLDOWN_MIN = "30",
  CRYPTO_REFRESH_MINUTES = "45",
  CRYPTO_QUORUM_VOTES = "3",
  CRYPTO_BINANCE_TOP = "120",
  CRYPTO_FORCE_THROTTLE_SEC = "240",
} = process.env;

const CFG = {
  TOP_N: clampInt(CRYPTO_TOP_N, 5, 1, 10),
  MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 50_000_000),
  MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 200_000_000),
  COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 30, 0, 1440),
  REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
  QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 3, 3, 5),
  BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 120, 20, 250),
  FORCE_TTL: clampInt(CRYPTO_FORCE_THROTTLE_SEC, 240, 30, 3600),
  THRESH: { m30: 0.2, h1: 0.3, h4: 0.5, d24: 0.0, d7: 0.0 },
};

export default async function handler(req, res) {
  try {
    const force = parseBool(req.query.force || "0");
    const n = clampInt(req.query.n, CFG.TOP_N, 1, 10);
    const shape = String(req.query.shape || "").toLowerCase(); // "legacy" | "slim" (opciono)

    // force auth + throttle
    if (force) {
      if (!checkCronKey(req, CRON_KEY)) return res.status(401).json({ ok: false, error: "unauthorized" });
      if (await isForceThrottled()) return res.status(429).json({ ok: false, error: "too_many_requests" });
    }

    const cacheKey = "crypto:signals:latest";
    const cached = await kvGetJSON(cacheKey);
    if (!force && cached && Array.isArray(cached.items) && cached.items.length) {
      const arr = projectForUI(cached.items).sort((a,b)=>b.confidence_pct - a.confidence_pct).slice(0, n);
      return sendCompat(res, {
        ok: true,
        version: "crypto-v1-compat",
        sport: "crypto",
        source: "cache",
        ts: cached.ts || Date.now(),
        ttl_min: cached.ttl_min || CFG.REFRESH_MIN,
        count: arr.length,
        items: arr,
      }, shape);
    }

    // live refresh
    const itemsRaw = await buildSignals({
      cgApiKey: COINGECKO_API_KEY,
      minVol: CFG.MIN_VOL,
      minMcap: CFG.MIN_MCAP,
      quorum: CFG.QUORUM,
      binanceTop: CFG.BINANCE_TOP,
      thresh: CFG.THRESH,
    });

    const itemsStable = await applyStickiness(itemsRaw, CFG.COOLDOWN_MIN);

    // upiši keš (bez n-limit)
    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items: itemsStable };
    await kvSetJSON(cacheKey, payload, CFG.REFRESH_MIN * 60);
    if (force) await setForceLock();

    // top-N i projekcija
    const arr = projectForUI(itemsStable).sort((a,b)=>b.confidence_pct - a.confidence_pct).slice(0, n);

    return sendCompat(res, {
      ok: true,
      version: "crypto-v1-compat",
      sport: "crypto",
      source: "live",
      ts: payload.ts,
      ttl_min: payload.ttl_min,
      count: arr.length,
      items: arr,
    }, shape);

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------- UI projection / aliases ---------- */
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

    return {
      // original
      ...it,

      // canonical fields
      type: "crypto",
      sport: "crypto",
      category: "crypto",
      market: "crypto",
      ticker: it.symbol,
      symbolUpper: String(it.symbol || "").toUpperCase(),

      // direction aliases
      signal: it.signal,                 // LONG/SHORT
      direction: dir,                    // long/short
      side: dir,                         // alias
      action: isLong ? "BUY" : "SELL",   // BUY/SELL
      isLong, isShort,

      // confidence aliases
      confidence_pct: it.confidence_pct,
      confidence: it.confidence_pct,
      confidenceScore: it.confidence_pct,
      score: it.confidence_pct,

      // timeframe aliases (numbers only)
      m30_pct: m30, h1_pct: h1, h4_pct: h4, d24_pct: d24, d7_pct: d7,
      change30m: m30, change1h: h1, change4h: h4, change24h: d24, change7d: d7,
      tf: { m30, h1, h4, d24, d7 },   // ponekad UI čita ugnježden objekat

      // optional SL/TP ako ih ima (ostavi kako jeste)
      // entry, sl, tp mogu postojati iz core-a sa ATR – ne diramo
    };
  });
}

/* ---------- response shaper (top-level aliases) ---------- */
function sendCompat(res, base, shape) {
  const items = base.items || [];
  const out = {
    ...base,
    // top-level duplicati za različite UI-ove
    data: items,
    predictions: items,
    rows: items,
    list: items,
    results: items,
    total: base.count,
  };

  if (shape === "legacy") {
    // Najčešći legacy format: { ok, total, items } (plus zadržimo kompat polja)
    return res.status(200).json({ ok: out.ok, total: out.count, items: out.items, ...out });
  }
  if (shape === "slim") {
    // Samo niz stavki, bez omota (ako UI to traži)
    return res.status(200).json(items);
  }
  return res.status(200).json(out);
}

/* ---------- security/throttle ---------- */
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
async function isForceThrottled() {
  if (!UPSTASH_REDIS_REST_URL) return false;
  const v = await kvGetJSON("crypto:force:lock");
  return !!v;
}
async function setForceLock() {
  if (!UPSTASH_REDIS_REST_URL) return;
  await kvSetJSON("crypto:force:lock", { ts: Date.now() }, CFG.FORCE_TTL);
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

/* ---------- KV helpers ---------- */
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

/* ---------- utils ---------- */
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clampInt(v, def, min, max) { const n = parseInt(v,10); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function parseBool(x){ return String(x).toLowerCase()==="1"||String(x).toLowerCase()==="true"; }
function numOr0(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
