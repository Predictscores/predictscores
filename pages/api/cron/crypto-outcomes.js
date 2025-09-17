// pages/api/cron/crypto-outcomes.js
// Evaluator: proverava istorijske signale kojima je istekao valid_until i presuđuje TP/SL/expired.

const {
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRON_KEY = "",

  CRYPTO_STATS_LOOKBACK_DAYS = "14",
  CRYPTO_EVAL_BAR = "30m",          // 30m sveće (kao na chartu)
  CRYPTO_EVAL_GRACE_MIN = "30",     // čekaj još malo posle valid_until
  CRYPTO_FEE_PCT = "0.1",           // u %, jednokratno po ulasku/izlasku (npr 0.1)
  CRYPTO_OUTCOME_LOG_KEY = "crypto:outcomes:log",
  CRYPTO_OUTCOME_LOG_MAX = "2000",
  CRYPTO_OUTCOME_LOG_TTL_DAYS = "120",
} = process.env;

export default async function handler(req, res) {
  try {
    if (!checkCronKey(req, CRON_KEY)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const index = (await kvGetJSON("crypto:history:index")) || { ids: [] };
    const ids = (index.ids || []).slice(0, 5000);

    const now = Date.now();
    const lookbackMs = clampInt(CRYPTO_STATS_LOOKBACK_DAYS, 14, 1, 365) * 86400 * 1000;
    const graceMin = clampInt(CRYPTO_EVAL_GRACE_MIN, 30, 0, 240);
    const feePct = Number(CRYPTO_FEE_PCT) || 0;

    let checked = 0, updated = 0, skipped = 0;

    for (const id of ids) {
      const recKey = `crypto:history:item:${id}`;
      const rec = await kvGetJSON(recKey);
      if (!rec) continue;

      // starost i status
      if (now - rec.ts > lookbackMs) continue;
      if (rec.outcome) { skipped++; continue; }
      if (!rec.valid_until || now < rec.valid_until + graceMin * 60000) { skipped++; continue; }

      // candles (OKX → Bybit fallback)
      const instId = rec.pair || `${rec.symbol}-USDT`;
      const candles = await getCandles30m(instId, CRYPTO_EVAL_BAR);
      if (!candles || !candles.length) { skipped++; continue; }

      const slice = candles.filter(c => c.ts >= rec.ts && c.ts <= rec.valid_until + graceMin * 60000);
      if (!slice.length) { skipped++; continue; }

      // presuda: konzervativno — ako TP i SL u istoj sveći, računaj "gori" ishod
      const side = String(rec.side || "").toUpperCase(); // LONG/SHORT
      const entry = rec.entry, sl = rec.sl, tp = rec.tp;
      let outcome = "expired", exitPrice = null, timeToHitMin = null;
      let lastClose = null;

      for (const k of slice.sort((a,b)=>a.ts-b.ts)) {
        const { high, low } = k;
        const hitTP = side === "LONG" ? (high >= tp) : (low <= tp);
        const hitSL = side === "LONG" ? (low <= sl) : (high >= sl);
        lastClose = Number.isFinite(k.close) ? k.close : lastClose;

        if (hitTP && hitSL) { // tie → gori ishod
          outcome = "sl";
          exitPrice = sl;
          timeToHitMin = Math.round((k.ts - rec.ts)/60000);
          break;
        }
        if (hitSL) {
          outcome = "sl";
          exitPrice = sl;
          timeToHitMin = Math.round((k.ts - rec.ts)/60000);
          break;
        }
        if (hitTP) {
          outcome = "tp";
          exitPrice = tp;
          timeToHitMin = Math.round((k.ts - rec.ts)/60000);
          break;
        }
      }

      if (!Number.isFinite(exitPrice) && Number.isFinite(lastClose)) {
        exitPrice = lastClose;
      }

      // realized RR (sa fee, konzervativno)
      const risk = side === "LONG" ? (entry - sl) : (sl - entry);
      let realizedRR = null, win = null;
      if (outcome === "tp" || outcome === "sl") {
        const gross = side === "LONG" ? (exitPrice - entry) : (entry - exitPrice);
        const fees = (entry + exitPrice) * (feePct/100); // entry + exit
        const net = gross - fees;
        realizedRR = risk > 0 ? (net / risk) : null;
        win = outcome === "tp" ? 1 : 0;
      } else if (outcome === "expired") {
        win = null;
      }

      const pctChange = computePctChange(entry, exitPrice, side);

      const updatedRec = {
        ...rec,
        outcome,
        win,
        exit_price: exitPrice,
        time_to_hit_min: timeToHitMin,
        realized_rr: realizedRR,
        evaluated_ts: Date.now(),
        exit_pct_change: pctChange,
      };
      await kvSetJSON(recKey, updatedRec, 60 * 86400); // produži TTL na 60d
      await appendOutcomeLog({
        id,
        ts: rec.ts || null,
        evaluated_ts: updatedRec.evaluated_ts,
        valid_until: rec.valid_until || null,
        symbol: rec.symbol || rec.symbol1 || null,
        side,
        exchange: rec.exchange || null,
        pair: rec.pair || null,
        confidence_pct: rec.confidence_pct ?? null,
        rr: rec.rr ?? null,
        realized_rr: realizedRR,
        entry,
        exit_price: exitPrice,
        pct_change: pctChange,
        outcome,
        win,
        time_to_hit_min: timeToHitMin,
        m30_pct: toNum(rec.m30_pct),
        h1_pct: toNum(rec.h1_pct),
        h4_pct: toNum(rec.h4_pct),
        d24_pct: toNum(rec.d24_pct),
        d7_pct: toNum(rec.d7_pct),
        votes: rec.votes || null,
      });
      updated++; checked++;
    }

    return res.status(200).json({ ok: true, checked, updated, skipped });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------- Candles: OKX → Bybit ---------- */
async function getCandles30m(instId, bar) {
  // OKX format: ts, o, h, l, c, vol, volCcy (najnovije prvo)
  try {
    const u = new URL("https://www.okx.com/api/v5/market/candles");
    u.searchParams.set("instId", instId);
    u.searchParams.set("bar", bar || "30m");
    u.searchParams.set("limit", "200");
    const r = await fetch(u.toString(), { cache: "no-store" });
    const j = await r.json();
    const arr = Array.isArray(j?.data) ? j.data : [];
    if (arr.length) {
      return arr.map(row => {
        const [ts, o, h, l, c] = row;
        return { ts: Number(ts), open: +o, high: +h, low: +l, close: +c };
      }).sort((a,b)=>a.ts-b.ts);
    }
  } catch {}
  // Bybit linear fallback
  try {
    const sym = instId.replace("-", ""); // BTC-USDT -> BTCUSDT
    const u = new URL("https://api.bybit.com/v5/market/kline");
    u.searchParams.set("category", "linear");
    u.searchParams.set("symbol", sym);
    u.searchParams.set("interval", "30");
    u.searchParams.set("limit", "200");
    const r = await fetch(u.toString(), { cache: "no-store" });
    const j = await r.json();
    const arr = Array.isArray(j?.result?.list) ? j.result.list : [];
    if (arr.length) {
      return arr.map(row => {
        const [ts, o, h, l, c] = row;
        return { ts: Number(ts), open: +o, high: +h, low: +l, close: +c };
      }).sort((a,b)=>a.ts-b.ts);
    }
  } catch {}
  return [];
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
async function appendOutcomeLog(entry) {
  const key = CRYPTO_OUTCOME_LOG_KEY || "crypto:outcomes:log";
  if (!UPSTASH_REDIS_REST_URL || !key) return;
  try {
    const base = UPSTASH_REDIS_REST_URL.replace(/\/+$/, "");
    const payload = encodeURIComponent(JSON.stringify(entry));
    const urlPush = `${base}/lpush/${encodeURIComponent(key)}/${payload}`;
    await fetch(urlPush, { headers: authHeader(), cache: "no-store" }).catch(() => {});
    const maxLen = clampInt(CRYPTO_OUTCOME_LOG_MAX, 2000, 100, 20000);
    const trimStop = Math.max(0, maxLen - 1);
    const urlTrim = `${base}/ltrim/${encodeURIComponent(key)}/0/${trimStop}`;
    await fetch(urlTrim, { headers: authHeader(), cache: "no-store" }).catch(() => {});
    const ttlSec = clampInt(CRYPTO_OUTCOME_LOG_TTL_DAYS, 120, 1, 365) * 86400;
    if (ttlSec > 0) {
      const urlExpire = `${base}/expire/${encodeURIComponent(key)}/${ttlSec}`;
      await fetch(urlExpire, { headers: authHeader(), cache: "no-store" }).catch(() => {});
    }
  } catch {}
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
function clampInt(v, def, min, max) { const n = parseInt(v,10); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function toNum(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function computePctChange(entryPrice, exitPrice, side) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) return null;
  const raw = side === "LONG" ? ((exit - entry) / entry) : ((entry - exit) / entry);
  return Number.isFinite(raw) ? Math.round(raw * 10000) / 100 : null;
}
