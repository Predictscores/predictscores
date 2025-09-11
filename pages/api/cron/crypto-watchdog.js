// pages/api/cron/crypto-watchdog.js
// Watchdog: izračuna signale i napiše ih u KV (sa Entry/TP/SL), izolovano na kripto.

import { buildSignals } from "../../../lib/crypto-core";

const {
  COINGECKO_API_KEY = "",
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

  // „lepljivost“ (anti-flip)
  CRYPTO_COOLDOWN_MIN = "0",
} = process.env;

const CFG = {
  MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 50_000_000),
  MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 200_000_000),
  REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
  QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 3, 3, 5),
  BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 150, 20, 400),

  MIN_RR: toNum(CRYPTO_MIN_RR, 0),
  MIN_EM: toNum(CRYPTO_MIN_EXPECTED_MOVE_PCT, 0),
  REQUIRE_H1H4: parseBool(CRYPTO_REQUIRE_H1_H4),
  INCLUDE_7D: parseBool(CRYPTO_INCLUDE_7D, true),
  PERSIST_SNAPSHOTS: clampInt(CRYPTO_PERSIST_SNAPSHOTS, 0, 0, 10),
  DEDUP_MIN: clampInt(CRYPTO_DEDUP_WINDOW_MIN, 0, 0, 2880),
  DIVERGENCE_MAX: toNum(CRYPTO_PRICE_DIVERGENCE_MAX_PCT, 0),

  COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 0, 0, 1440),
};

export default async function handler(req, res) {
  try {
    if (!checkCronKey(req, CRON_KEY)) {
      return res
        .status(401)
        .json({ ok: true, triggered: true, upstream: { ok: false, status: 401 } });
    }

    // 1) gradi sirove kandidate
    const itemsRaw = await buildSignals({
      cgApiKey: COINGECKO_API_KEY,
      minVol: CFG.MIN_VOL,
      minMcap: CFG.MIN_MCAP,
      quorum: CFG.QUORUM,
      binanceTop: CFG.BINANCE_TOP,
    });

    // 2) primeni policy filtere (RR/EM/H1=H4/7d/divergence)
    let items = enforcePolicy(itemsRaw, CFG);

    // 3) dedup + persist + anti-flip cooldown
    items = await applyPersistenceAndDedup(items, CFG);
    items = await applyStickiness(items, CFG.COOLDOWN_MIN);

    // 4) upiši u KV
    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items };
    await kvSetJSON("crypto:signals:latest", payload, CFG.REFRESH_MIN * 60);

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

/* ---------- anti-flip (postojeci) ---------- */
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

  function snap(x) {
    return { signal: x.signal, score: (x.confidence_pct - 55) / 40, confidence_pct: x.confidence_pct, ts: now };
  }
}

/* ---------- KV helpers & utils ---------- */
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
