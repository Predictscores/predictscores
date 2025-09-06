// lib/crypto-core.js
// Core: izrada LONG/SHORT kandidata bez KV i bez keša (čista računica).
// Koriste /pages/api/crypto.js i /pages/api/cron/crypto-watchdog.js.

export const STABLES = new Set([
  "USDT","USDC","DAI","TUSD","USDD","FDUSD","PYUSD","EUR","EURS","PAX","PAXG","GUSD","BUSD","LUSD","USDP"
]);

// Ako neki simbol traži ručno mapiranje na Binance par (retko):
const BINANCE_SYMBOL_FIX = {
  // primer: "IOTA": "IOTAUSDT",
};

export async function buildSignals(opts = {}) {
  const {
    cgApiKey = "",
    minVol = 100_000_000,
    minMcap = 500_000_000,
    quorum = 4,                 // koliko od {30m,1h,4h,24h,7d} mora da se složi
    binanceTop = 120,           // koliko top MCAP šaljemo na Binance provere
    thresh = { m30: 0.2, h1: 0.3, h4: 0.5, d24: 0.0, d7: 0.0 },
    conc = 10,                  // paralelizam za Binance pozive
  } = opts;

  const cg = await fetchCoinGeckoMarkets(cgApiKey);

  // BTC režim (za gating)
  const btc = cg.find((c) => (c.symbol || "").toUpperCase() === "BTC");
  const btc24 = toNum(btc?.price_change_percentage_24h_in_currency, 0);

  // Likvidnost/MCAP + stable filter
  let candidates = cg.filter((c) => {
    const sym = (c.symbol || "").toUpperCase();
    if (STABLES.has(sym)) return false;
    if (!isFiniteNumber(c.market_cap) || c.market_cap < minMcap) return false;
    if (!isFiniteNumber(c.total_volume) || c.total_volume < minVol) return false;
    return true;
  });

  // Suzi na top MCAP + bar malo kretanja da izbegnemo “mrtav range”
  candidates = candidates
    .sort((a, b) => b.market_cap - a.market_cap)
    .slice(0, binanceTop)
    .filter((c) => {
      const h1 = Math.abs(toNum(c.price_change_percentage_1h_in_currency));
      const d24 = Math.abs(toNum(c.price_change_percentage_24h_in_currency));
      const d7 = Math.abs(toNum(c.price_change_percentage_7d_in_currency));
      return h1 >= 0.25 || d24 >= 1.0 || d7 >= 1.0;
    });

  // Binance 30m/4h + glasovi
  const out = [];
  for (let i = 0; i < candidates.length; i += conc) {
    const slice = candidates.slice(i, i + conc);
    const parts = await Promise.all(slice.map(async (c) => {
      const pair = resolveBinancePair(c.symbol);
      if (!pair) return null;

      const [m30, h4] = await Promise.all([
        fetchBinancePct(pair, "30m", 60, 2), // ~1h delta
        fetchBinancePct(pair, "4h",  20, 1), // poslednja 4h sveća
      ]);

      const deltas = {
        m30_pct: m30,
        h1_pct:  toNum(c.price_change_percentage_1h_in_currency),
        h4_pct:  h4,
        d24_pct: toNum(c.price_change_percentage_24h_in_currency),
        d7_pct:  toNum(c.price_change_percentage_7d_in_currency),
      };

      const votes = votePack(deltas, thresh);

      let signal = "NONE";
      if (votes.sum >= quorum) signal = "LONG";
      else if (votes.sum <= -quorum) signal = "SHORT";
      else return null; // mešovito → odbaci

      // BTC gating
      if (signal === "LONG" && btc24 < 0) return null;
      if (signal === "SHORT" && btc24 > 1.0) return null;

      const confidence_pct = confidenceFrom(deltas, signal, votes);

      return {
        id: c.id,
        symbol: (c.symbol || "").toUpperCase(),
        name: c.name,
        image: c.image,
        price: toNum(c.current_price),
        market_cap: toNum(c.market_cap),
        total_volume: toNum(c.total_volume),
        pair,
        signal,
        confidence_pct,
        m30_pct: round2(deltas.m30_pct),
        h1_pct:  round2(deltas.h1_pct),
        h4_pct:  round2(deltas.h4_pct),
        d24_pct: round2(deltas.d24_pct),
        d7_pct:  round2(deltas.d7_pct),
        votes, // { m30,h1,h4,d24,d7,sum }
      };
    }));
    for (const p of parts) if (p) out.push(p);
  }

  return out;
}

/* ---------------- helpers (shared) ---------------- */

export async function fetchCoinGeckoMarkets(apiKey = "") {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "250");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  url.searchParams.set("price_change_percentage", "1h,24h,7d");

  const headers = {};
  if (apiKey) headers["x-cg-pro-api-key"] = apiKey;

  const r = await fetch(url, { headers, cache: "no-store" });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const raw = ct.includes("application/json") ? await r.json() : JSON.parse(await r.text());
  if (!Array.isArray(raw)) throw new Error("CoinGecko markets invalid");
  return raw.map((x) => ({
    id: x.id,
    symbol: (x.symbol || "").toUpperCase(),
    name: x.name,
    image: x.image,
    current_price: toNum(x.current_price),
    market_cap: toNum(x.market_cap),
    total_volume: toNum(x.total_volume),
    price_change_percentage_1h_in_currency: toNum(x.price_change_percentage_1h_in_currency),
    price_change_percentage_24h_in_currency: toNum(x.price_change_percentage_24h_in_currency),
    price_change_percentage_7d_in_currency: toNum(x.price_change_percentage_7d_in_currency),
  }));
}

export async function fetchBinancePct(pair, interval, limit, lookbackBars) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return NaN;
  const data = await r.json();
  if (!Array.isArray(data) || data.length < 3) return NaN;
  const closes = data.map((row) => toNum(row[4]));
  const last = closes[closes.length - 1];
  const base = closes[closes.length - 1 - Math.max(1, lookbackBars)];
  if (!isFiniteNumber(last) || !isFiniteNumber(base) || base <= 0) return NaN;
  return ((last - base) / base) * 100;
}

export function resolveBinancePair(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (STABLES.has(s)) return null;
  if (BINANCE_SYMBOL_FIX[s]) return BINANCE_SYMBOL_FIX[s];
  return `${s}USDT`; // default: spot USDT par
}

export function votePack(d, T) {
  const m30 = voteOne(d.m30_pct, T.m30);
  const h1  = voteOne(d.h1_pct,  T.h1);
  const h4  = voteOne(d.h4_pct,  T.h4);
  const d24 = voteOne(d.d24_pct, T.d24);
  const d7  = voteOne(d.d7_pct,  T.d7);
  const sum = m30 + h1 + h4 + d24 + d7;
  return { m30, h1, h4, d24, d7, sum };
}
export function voteOne(x, thr) {
  if (!isFiniteNumber(x)) return 0;
  if (x >  +Math.abs(thr)) return +1;
  if (x <  -Math.abs(thr)) return -1;
  return 0;
}
export function confidenceFrom(d, signal, votes) {
  const w = { m30: 0.15, h1: 0.30, h4: 0.25, d24: 0.20, d7: 0.10 };
  const norm = (x, s) => Math.tanh(toNum(x,0) / s);
  const s = { m30: 0.8, h1: 1.2, h4: 2.0, d24: 3.0, d7: 5.0 };
  const dir = (signal === "LONG") ? +1 : -1;
  const score =
    w.m30 * norm(dir * d.m30_pct, s.m30) +
    w.h1  * norm(dir * d.h1_pct,  s.h1)  +
    w.h4  * norm(dir * d.h4_pct,  s.h4)  +
    w.d24 * norm(dir * d.d24_pct, s.d24) +
    w.d7  * norm(dir * d.d7_pct,  s.d7);
  let conf = 55 + 40 * clamp01((score + 1) / 2);
  if (Math.abs(votes.sum) === 5) conf = Math.max(conf, 85);
  return Math.round(conf);
}

/* -------- small utils -------- */
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function round2(x){ const n = Number(x); return Number.isFinite(n) ? Math.round(n*100)/100 : null; }
function isFiniteNumber(x){ return typeof x==="number" && Number.isFinite(x); }
