// pages/api/cron/crypto-watchdog.js
// Watchdog: direktno izračuna signale i upiše u KV (nema internog HTTP poziva, nema Protection).
import { buildSignals } from "../../../lib/crypto-core";

const {
  COINGECKO_API_KEY = "",
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRON_KEY = "",
  CRYPTO_REFRESH_MINUTES = "45",
  CRYPTO_MIN_VOL_USD = "100000000",
  CRYPTO_MIN_MCAP_USD = "500000000",
  CRYPTO_QUORUM_VOTES = "4",
  CRYPTO_BINANCE_TOP = "120",
  CRYPTO_COOLDOWN_MIN = "30", // koristimo isti anti-flip kao u /api/crypto
} = process.env;

const CFG = {
  REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
  MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 100_000_000),
  MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 500_000_000),
  QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 4, 3, 5),
  BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 120, 20, 250),
  COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 30, 0, 1440),
  THRESH: { m30: 0.2, h1: 0.3, h4: 0.5, d24: 0.0, d7: 0.0 },
};

export default async function handler(req, res) {
  try {
    const key = String(req.query.key || "");
    if (!CRON_KEY || key !== CRON_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    // 1) sveže izračunaj
    const itemsRaw = await buildSignals({
      cgApiKey: COINGECKO_API_KEY,
      minVol: CFG.MIN_VOL,
      minMcap: CFG.MIN_MCAP,
      quorum: CFG.QUORUM,
      binanceTop: CFG.BINANCE_TOP,
      thresh: CFG.THRESH,
    });

    // 2) anti-flip kao i u /api/crypto (da i watchdog piše stabilan set)
    const items = await applyStickiness(itemsRaw, CFG.COOLDOWN_MIN);

    // 3) upiši u KV (bez n-limit)
    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items };
    await kvSetJSON("crypto:signals:latest", payload, CFG.REFRESH_MIN * 60);

    return res.status(200).json({
      ok: true, wrote: true,
      ts: payload.ts, ttl_min: payload.ttl_min,
      count: items.length,
      sample: items.slice(0, 3),
    });

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* -------- anti-flip (isti kao u /api/crypto) -------- */
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

/* -------- KV helpers -------- */
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

/* -------- small utils -------- */
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clampInt(v, def, min, max) { const n = parseInt(v,10); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
