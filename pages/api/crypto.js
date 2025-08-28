// pages/api/crypto.js
// Drop-in: CoinGecko markets -> čisti LONG/SHORT (bez NEUTRAL), stabilan JSON shape

const COINS = [
  "bitcoin","ethereum","solana","binancecoin","ripple",
  "dogecoin","cardano","tron","polkadot","chainlink",
  "litecoin","uniswap","stellar","near","avalanche-2"
];

const CG_BASE = "https://api.coingecko.com/api/v3";

async function safeJsonFetch(url) {
  const r = await fetch(url, { cache: "no-store" });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const raw = await r.text().catch(() => "");
    return { ok:false, status:r.status, statusText:r.statusText, raw };
  }
  try {
    const data = await r.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function classifySignal(h1, d24) {
  // Jednostavno: oba pozitivna → LONG, oba negativna → SHORT,
  // u suprotnom biramo snažniji nagib (1h ima veću težinu).
  const a = Number(h1 ?? 0);
  const b = Number(d24 ?? 0);
  if (a >= 0 && b >= 0) return "LONG";
  if (a <= 0 && b <= 0) return "SHORT";
  return a >= Math.abs(b) ? (a >= 0 ? "LONG" : "SHORT") : (b >= 0 ? "LONG" : "SHORT");
}

function confidenceFrom(h1, d24) {
  // 0–100: kombinacija 1h i 24h, ograničena
  const a = Math.max(-5, Math.min(5, (h1 ?? 0) / 1.0));   // -5..+5 za 1h
  const b = Math.max(-10, Math.min(10, (d24 ?? 0) / 2.0)); // -10..+10 za 24h
  const score = 50 + a * 5 + b * 2.5; // težište na 1h
  return Math.round(Math.max(1, Math.min(99, score)));
}

export default async function handler(req, res) {
  try {
    const ids = COINS.join(",");
    const url = `${CG_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&order=market_cap_desc&price_change_percentage=1h,24h`;
    const r = await safeJsonFetch(url);
    if (!r.ok) {
      res.setHeader("Content-Type", "application/json");
      return res.status(502).json({ ok:false, error:"coingecko failed", detail:r, items: [], crypto: [], signals: [] });
    }

    const arr = Array.isArray(r.data) ? r.data : [];
    const signals = arr.map(c => {
      const h1 = c?.price_change_percentage_1h_in_currency ?? null;
      const d24 = c?.price_change_percentage_24h_in_currency ?? null;
      const signal = classifySignal(h1, d24);
      const confidence = confidenceFrom(h1, d24);
      return {
        symbol: (c?.symbol || "").toUpperCase() + "USDT",
        name: c?.name || null,
        price: c?.current_price ?? null,
        h1_pct: h1,
        d24_pct: d24,
        signal,              // "LONG" | "SHORT"
        confidence_pct: confidence,
        source: "coingecko/markets",
        updated_at: new Date().toISOString(),
      };
    }).sort((a,b) => b.confidence_pct - a.confidence_pct);

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ ok:true, count: signals.length, items: signals, crypto: signals, signals });
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({ ok:false, error:String(e?.message||e), items: [], crypto: [], signals: [] });
  }
}
