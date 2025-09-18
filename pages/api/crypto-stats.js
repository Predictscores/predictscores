// pages/api/crypto-stats.js
// Vraća zbirne statistike na osnovu crypto:history:item:* zapisa (rolling lookback).

import { upstashFallbackGet } from "../../lib/upstash-fallback";

const {
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",

  CRYPTO_STATS_LOOKBACK_DAYS = "14",
} = process.env;

export default async function handler(req, res) {
  try {
    const lookbackDays = clampInt(req.query.days || CRYPTO_STATS_LOOKBACK_DAYS, 14, 1, 365);
    const now = Date.now();
    const minTs = now - lookbackDays * 86400 * 1000;

    const index = (await kvGetJSON("crypto:history:index")) || { ids: [] };
    const ids = (index.ids || []).slice(0, 5000);

    const rows = [];
    for (const id of ids) {
      const rec = await kvGetJSON(`crypto:history:item:${id}`);
      if (!rec) continue;
      if (rec.ts < minTs) continue;
      rows.push(rec);
    }

    const decided = rows.filter(r => r.outcome === "tp" || r.outcome === "sl");
    const wins = decided.filter(r => r.win === 1);

    const winRate = decided.length ? (wins.length / decided.length) * 100 : null;
    const avgRR = mean(decided.map(r => num(r.realized_rr)));
    const medRR = median(decided.map(r => num(r.realized_rr)));

    const buckets = bucketByConfidence(rows);

    return res.status(200).json({
      ok: true,
      lookback_days: lookbackDays,
      total_signals: rows.length,
      decided: decided.length,
      win_rate_pct: round2(winRate),
      avg_rr: round3(avgRR),
      median_rr: round3(medRR),
      long_count: rows.filter(r => r.side === "LONG").length,
      short_count: rows.filter(r => r.side === "SHORT").length,
      buckets,
      sample: rows.slice(0, 5),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

function bucketByConfidence(rows) {
  const out = {
    ">=90": agg(rows.filter(r => (r.confidence_pct ?? 0) >= 90)),
    "75-89": agg(rows.filter(r => (r.confidence_pct ?? 0) >= 75 && (r.confidence_pct ?? 0) < 90)),
    "50-74": agg(rows.filter(r => (r.confidence_pct ?? 0) >= 50 && (r.confidence_pct ?? 0) < 75)),
    "<50":  agg(rows.filter(r => (r.confidence_pct ?? 0) < 50)),
  };
  return out;

  function agg(list) {
    const d = list.filter(r => r.outcome === "tp" || r.outcome === "sl");
    const w = d.filter(r => r.win === 1);
    return {
      signals: list.length,
      decided: d.length,
      win_rate_pct: d.length ? round2((w.length / d.length) * 100) : null,
      avg_rr: round3(mean(d.map(r => num(r.realized_rr)))),
      median_rr: round3(median(d.map(r => num(r.realized_rr)))),
    };
  }
}

/* ---------- KV & utils ---------- */
async function kvGetJSON(key) {
  if (!key) return null;
  if (UPSTASH_REDIS_REST_URL) {
    const u = `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
    const r = await fetch(u, { headers: authHeader(), cache: "no-store" });
    if (!r.ok) return null;
    const raw = await r.json().catch(() => null);
    const val = raw?.result;
    if (!val) return null;
    try { return JSON.parse(val); } catch { return null; }
  }
  const fallbackVal = upstashFallbackGet(key);
  if (fallbackVal == null) return null;
  try { return JSON.parse(fallbackVal); } catch { return null; }
}
function authHeader() {
  const h = {};
  if (UPSTASH_REDIS_REST_TOKEN) h["Authorization"] = `Bearer ${UPSTASH_REDIS_REST_TOKEN}`;
  return h;
}
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
function mean(arr){ const f = arr.filter(x => Number.isFinite(x)); return f.length ? f.reduce((a,b)=>a+b,0)/f.length : null; }
function median(arr){ const f = arr.filter(x => Number.isFinite(x)).sort((a,b)=>a-b); if (!f.length) return null; const m = Math.floor(f.length/2); return f.length%2?f[m]:(f[m-1]+f[m])/2; }
function round2(x){ return Number.isFinite(x) ? Math.round(x*100)/100 : null; }
function round3(x){ return Number.isFinite(x) ? Math.round(x*1000)/1000 : null; }
function clampInt(v, def, min, max) { const n = parseInt(v,10); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
