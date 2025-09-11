// pages/api/crypto.js
// API sa "compat" projekcijom: dodaje alias polja i shape=slim + Entry/TP/SL/rr/expectedMove.

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

  // policy (fallback za live)
  CRYPTO_MIN_RR = "0",
  CRYPTO_MIN_EXPECTED_MOVE_PCT = "0",
  CRYPTO_REQUIRE_H1_H4 = "0",
  CRYPTO_INCLUDE_7D = "1",
  CRYPTO_PERSIST_SNAPSHOTS = "0",
  CRYPTO_DEDUP_WINDOW_MIN = "0",
  CRYPTO_PRICE_DIVERGENCE_MAX_PCT = "0",
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

  MIN_RR: toNum(CRYPTO_MIN_RR, 0),
  MIN_EM: toNum(CRYPTO_MIN_EXPECTED_MOVE_PCT, 0),
  REQUIRE_H1H4: parseBool(CRYPTO_REQUIRE_H1_H4),
  INCLUDE_7D: parseBool(CRYPTO_INCLUDE_7D, true),
  PERSIST_SNAPSHOTS: clampInt(CRYPTO_PERSIST_SNAPSHOTS, 0, 0, 10),
  DEDUP_MIN: clampInt(CRYPTO_DEDUP_WINDOW_MIN, 0, 0, 2880),
  DIVERGENCE_MAX: toNum(CRYPTO_PRICE_DIVERGENCE_MAX_PCT, 0),
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
      const arr = projectForUI(cached.items).sort((a, b) => b.confidence_pct - a.confidence_pct).slice(0, n);
      return sendCompat(
        res,
        {
          ok: true,
          version: "crypto-v1-compat",
          sport: "crypto",
          source: "cache",
          ts: cached.ts || Date.now(),
          ttl_min: cached.ttl_min || CFG.REFRESH_MIN,
          count: arr.length,
          items: arr,
        },
        shape
      );
    }

    // LIVE refresh (fallback ako nema cache-a ili ?force=1)
    let items = await buildSignals({
      cgApiKey: COINGECKO_API_KEY,
      minVol: CFG.MIN_VOL,
      minMcap: CFG.MIN_MCAP,
      quorum: CFG.QUORUM,
      binanceTop: CFG.BINANCE_TOP,
    });

    items = enforcePolicy(items, CFG);
    items = await applyPersistenceAndDedup(items, CFG);
    items = await applyStickiness(items, CFG.COOLDOWN_MIN);

    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items };
    await kvSetJSON(cacheKey, payload, CFG.REFRESH_MIN * 60);
    if (force) await setForceLock();

    const arr = projectForUI(items).sort((a, b) => b.confidence_pct - a.confidence_pct).slice(0, n);
    return sendCompat(
      res,
      {
        ok: true,
        version: "crypto-v1-compat",
        sport: "crypto",
        source: "live",
        ts: payload.ts,
        ttl_min: payload.ttl_min,
        count: arr.length,
        items: arr,
      },
      shape
    );
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------- UI projection ---------- */
function projectForUI(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const isLong = String(it.signal || "").toUpperCase() === "LONG";
    const entry = Number.isFinite(it.entry) ? it.entry : null;
    const tp = Number.isFinite(it.tp) ? it.tp : null;
    const sl = Number.isFinite(it.sl) ? it.sl : null;

    const m30 = numOr0(it.m30_pct), h1 = numOr0(it.h1_pct), h4 = numOr0(it.h4_pct), d24 = numOr0(it.d24_pct), d7 = numOr0(it.d7_pct);

    return {
      ...it,
      type: "crypto",
      sport: "crypto",
      category: "crypto",
      ticker: (it.ticker || it.symbol || "").toUpperCase(),
      symbolUpper: (it.symbol || "").toUpperCase(),
      direction: isLong ? "long" : "short",
      side: isLong ? "long" : "short",
      action: isLong ? "BUY" : "SELL",
      isLong, isShort: !isLong,

      confidence: it.confidence_pct,
      confidenceScore: it.confidence_pct,
      score: it.confidence_pct,

      m30_pct: m30, h1_pct: h1, h4_pct: h4, d24_pct: d24, d7_pct: d7,
      change30m: m30, change1h: h1, change4h: h4, change24h: d24, change7d: d7,

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
    signals: items,
    data: items, predictions: items, rows: items, list: items, results: items,
    total: base.count,
  };
  if (shape === "legacy") return res.status(200).json({ ok: out.ok, total: out.count, items: out.items, ...out });
  if (shape === "slim") return res.status(200).json(items);
  return res.status(200).json(out);
}

/* ---------- Policy filter ---------- */
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
function parseBool(x){ const s = String(x).toLowerCase(); if (s==="1"||s==="true") return true; if (s==="0"||s==="false") return false; return false; }
function numOr0(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
