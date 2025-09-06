// pages/api/crypto.js
// API: vraća 3–6 najjačih signala (keš iz KV); force=1 radi live refresh (code-only auth).
import { buildSignals } from "../../lib/crypto-core";

const {
  COINGECKO_API_KEY = "",
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRON_KEY = "",
  CRYPTO_TOP_N = "5",
  CRYPTO_MIN_VOL_USD = "100000000",
  CRYPTO_MIN_MCAP_USD = "500000000",
  CRYPTO_COOLDOWN_MIN = "30",
  CRYPTO_REFRESH_MINUTES = "45",
  CRYPTO_QUORUM_VOTES = "4",
  CRYPTO_BINANCE_TOP = "120",
  CRYPTO_FORCE_THROTTLE_SEC = "240",
} = process.env;

const CFG = {
  TOP_N: clampInt(CRYPTO_TOP_N, 5, 1, 10),
  MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 100_000_000),
  MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 500_000_000),
  COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 30, 0, 1440),
  REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
  QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 4, 3, 5),
  BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 120, 20, 250),
  FORCE_TTL: clampInt(CRYPTO_FORCE_THROTTLE_SEC, 240, 30, 3600),
  THRESH: { m30: 0.2, h1: 0.3, h4: 0.5, d24: 0.0, d7: 0.0 },
};

export default async function handler(req, res) {
  try {
    const force = parseBool(req.query.force || "0");
    const n = clampInt(req.query.n, CFG.TOP_N, 1, 10);

    // force traži CRON_KEY + throttle
    if (force) {
      if (!checkCronKey(req, CRON_KEY)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      if (await isForceThrottled()) {
        return res.status(429).json({ ok: false, error: "too_many_requests" });
      }
    }

    // 1) KV keš
    const cacheKey = "crypto:signals:latest";
    const cached = await kvGetJSON(cacheKey);
    if (!force && cached && Array.isArray(cached.items) && cached.items.length) {
      return res.status(200).json({
        ok: true, source: "cache",
        ts: cached.ts || Date.now(),
        ttl_min: cached.ttl_min || CFG.REFRESH_MIN,
        count: Math.min(n, cached.items.length),
        items: cached.items.slice(0, n),
      });
    }

    // 2) Izračunaj sveže
    const itemsRaw = await buildSignals({
      cgApiKey: COINGECKO_API_KEY,
      minVol: CFG.MIN_VOL,
      minMcap: CFG.MIN_MCAP,
      quorum: CFG.QUORUM,
      binanceTop: CFG.BINANCE_TOP,
      thresh: CFG.THRESH,
    });

    // 3) Anti-flip (stickiness)
    const items = await applyStickiness(itemsRaw, CFG.COOLDOWN_MIN);

    // 4) Upisi KV (bez n-limit)
    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items };
    await kvSetJSON(cacheKey, payload, CFG.REFRESH_MIN * 60);

    if (force) await setForceLock();

    // 5) Top-N
    const top = items.sort((a, b) => b.confidence_pct - a.confidence_pct).slice(0, n);

    return res.status(200).json({
      ok: true, source: "live",
      ts: payload.ts, ttl_min: payload.ttl_min,
      count: top.length, items: top,
    });

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------------- security/throttle ---------------- */
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

/* ---------------- anti-flip ---------------- */
async function applyStickiness(items, cooldownMin) {
  if (!cooldownMin || cooldownMin <= 0) return items;
  const key = "crypto:signals:last";
  const prev = await kvGetJSON(key);
  const now = Date.now();
  const bySymbol = {};
  const STICKINESS_DELTA = 0.15;

  const filtered = items.filter((it) => {
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

/* ---------------- KV helpers ---------------- */
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

/* ---------------- utils ---------------- */
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clampInt(v, def, min, max) { const n = parseInt(v,10); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function parseBool(x){ return String(x).toLowerCase()==="1"||String(x).toLowerCase()==="true"; }
