// lib/crypto-core.js
// Crypto core: Binance listing filter + ATR(14) levels (Entry/SL/TP) + expectedMove + confidence + quorum
// Sve je izolovano na kripto (fudbal se ne dotiče).

export const STABLES = new Set([
  "USDT","USDC","DAI","TUSD","USDD","FDUSD","PYUSD","EUR","EURS","PAX","PAXG","GUSD","BUSD","LUSD","USDP"
]);

const BINANCE_SYMBOL_FIX = {
  // primer mapiranja ako treba: "IOTA": "IOTAUSDT",
};

function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function envInt(name, def) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def=false) {
  const s = String(process.env[name] || "").toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  return def;
}

export async function buildSignals(opts = {}) {
  // ---- konfiguracija (iz ENV + opcionalno iz opts) ----
  const cgApiKey = opts.cgApiKey || (process.env.COINGECKO_API_KEY || "");
  const minVol = Number(opts.minVol ?? envNum("CRYPTO_MIN_VOL_USD", 50_000_000));
  const minMcap = Number(opts.minMcap ?? envNum("CRYPTO_MIN_MCAP_USD", 200_000_000));
  const quorum = Number(opts.quorum ?? envInt("CRYPTO_QUORUM_VOTES", 3));
  const binanceTop = Number(opts.binanceTop ?? envInt("CRYPTO_BINANCE_TOP", 150));
  const thresh = opts.thresh || { m30: 0.2, h1: 0.3, h4: 0.5, d24: 0.0, d7: 0.0 };

  const levelsEnable = envBool("CRYPTO_LEVELS_ENABLE", true);
  const atrPeriod = envInt("CRYPTO_ATR_PERIOD", 14);
  const atrSL = envNum("CRYPTO_ATR_SL_MULT", 1.0);
  const atrTP = envNum("CRYPTO_ATR_TP_MULT", 1.8);
  const levelsValidMin = envInt("CRYPTO_LEVELS_VALID_MIN", 90);
  const priceDivMax = envNum("CRYPTO_PRICE_DIVERGENCE_MAX_PCT", 1.5);
  const requireIntraday = envBool("CRYPTO_REQUIRE_INTRADAY", true); // zahteva i m30 i h4

  // ---- učitaj listu Binance USDT spot parova + tickSize ----
  const listing = await fetchBinanceListing();
  const PAIRS = listing.pairs;     // Set("BTCUSDT", ...)
  const BASES = listing.bases;     // Set("BTC", "ETH", ...)
  const TICKS = listing.ticks;     // Map("BTCUSDT" -> { tickSize, stepSize })

  // ---- CoinGecko markets ----
  const cg = await fetchCoinGeckoMarkets(cgApiKey);

  // BTC režim (24h)
  const btc = cg.find((c) => (c.symbol || "").toUpperCase() === "BTC");
  const btc24 = toNum(btc?.price_change_percentage_24h_in_currency, 0);

  // ---- izbor kandidata ----
  let candidates = cg.filter((c) => {
    const sym = (c.symbol || "").toUpperCase();
    if (STABLES.has(sym)) return false;
    if (!BASES.has(sym)) return false; // tražimo spot USDT par na Binance-u
    if (!isFiniteNumber(c.market_cap) || c.market_cap < minMcap) return false;
    if (!isFiniteNumber(c.total_volume) || c.total_volume < minVol) return false;
    return true;
  });

  candidates = candidates
    .sort((a, b) => b.market_cap - a.market_cap)
    .slice(0, binanceTop)
    .filter((c) => {
      const h1 = Math.abs(toNum(c.price_change_percentage_1h_in_currency));
      const d24 = Math.abs(toNum(c.price_change_percentage_24h_in_currency));
      const d7 = Math.abs(toNum(c.price_change_percentage_7d_in_currency));
      // blagi pre-filter da smanjimo pozive
      return h1 >= 0.25 || d24 >= 1.0 || d7 >= 1.0;
    });

  // ---- obrada kandidata u paralelnim serijama ----
  const conc = 10;
  const out = [];
  for (let i = 0; i < candidates.length; i += conc) {
    const slice = candidates.slice(i, i + conc);
    const parts = await Promise.all(slice.map(async (c) => {
      const symbolU = (c.symbol || "").toUpperCase();
      const defPair = resolveBinancePair(symbolU);
      const pair = (defPair && PAIRS.has(defPair)) ? defPair : null;
      if (!pair) return null;

      // 30m klines (za m30 i ATR) + 4h klines (za h4)
      const [k30, k4h] = await Promise.all([
        fetchKlines(pair, "30m", 120).catch(() => null),
        fetchKlines(pair, "4h",  50).catch(() => null),
      ]);
      if (!k30 || k30.length < 20) return null;

      const last30Close = toNum(k30[k30.length - 1]?.close);
      const m30_pct = computePctFromKlines(k30, 2); // poslednja vs pre 2 sveće
      const h4_pct  = k4h && k4h.length >= 3 ? computePctFromKlines(k4h, 1) : NaN;

      // divergencija CG vs Binance (last 30m close)
      const cgPrice = toNum(c.current_price);
      const binancePrice = toNum(last30Close);
      const diffPct = (isFiniteNumber(cgPrice) && isFiniteNumber(binancePrice) && cgPrice > 0)
        ? Math.abs((binancePrice - cgPrice) / cgPrice * 100)
        : 0;
      if (isFiniteNumber(priceDivMax) && priceDivMax > 0 && diffPct > priceDivMax) {
        return null; // prljav feed/cena → odbaci
      }

      const deltas = {
        m30_pct,
        h1_pct:  toNum(c.price_change_percentage_1h_in_currency),
        h4_pct,
        d24_pct: toNum(c.price_change_percentage_24h_in_currency),
        d7_pct:  toNum(c.price_change_percentage_7d_in_currency),
      };

      const votes = votePack(deltas, thresh);

      // adaptivni quorum: trebamo min(quorum, dostupno), ali makar 3
      const available = [deltas.m30_pct, deltas.h1_pct, deltas.h4_pct, deltas.d24_pct, deltas.d7_pct]
        .filter(isFiniteNumber).length;
      const need = Math.max(3, Math.min(quorum, available));
      const pos = [votes.m30, votes.h1, votes.h4, votes.d24, votes.d7].filter(v => v === +1).length;
      const neg = [votes.m30, votes.h1, votes.h4, votes.d24, votes.d7].filter(v => v === -1).length;

      let signal = "NONE";
      if (pos >= need) signal = "LONG";
      else if (neg >= need) signal = "SHORT";
      else return null;

      // BTC gating
      if (signal === "LONG" && btc24 <= -0.3) return null;
      if (signal === "SHORT" && btc24 >= +1.0) return null;

      // UI guard: zahtevaj m30 & h4 ako je uključeno
      if (requireIntraday) {
        if (!isFiniteNumber(deltas.m30_pct) || !isFiniteNumber(deltas.h4_pct)) return null;
      }

      const confidence_pct = confidenceFrom(deltas, signal, votes);

      // ATR i nivoi
      let entry = null, sl = null, tp = null, rr = null, expectedMove = null, valid_until = null;
      const tick = TICKS.get(pair) || { tickSize: null, stepSize: null };
      if (levelsEnable) {
        const atr = computeATRFromKlines(k30, atrPeriod);
        if (isFiniteNumber(atr) && isFiniteNumber(last30Close)) {
          const mult = pickMultipliers(confidence_pct, atrSL, atrTP);
          const baseEntry = last30Close;
          let rawSL, rawTP;
          if (signal === "LONG") {
            rawSL = baseEntry - mult.sl * atr;
            rawTP = baseEntry + mult.tp * atr;
          } else {
            rawSL = baseEntry + mult.sl * atr;
            rawTP = baseEntry - mult.tp * atr;
          }
          entry = roundToTick(baseEntry, tick.tickSize);
          sl    = roundToTick(rawSL, tick.tickSize);
          tp    = roundToTick(rawTP, tick.tickSize);
          const risk  = Math.abs(entry - sl);
          const reward = Math.abs(tp - entry);
          rr = (risk > 0 && isFiniteNumber(reward)) ? round2(reward / risk) : null;
          expectedMove = isFiniteNumber(entry) && isFiniteNumber(tp) && entry > 0
            ? round2(Math.abs(tp - entry) / entry * 100)
            : null;
          valid_until = Date.now() + (Math.max(15, levelsValidMin) * 60_000);
        }
      }

      return {
        id: c.id,
        symbol: symbolU,
        name: c.name,
        image: c.image,
        price: cgPrice,
        price_binance: binancePrice,
        price_divergence_pct: round2(diffPct),
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
        votes,
        entry, sl, tp, rr, expectedMove, valid_until,
      };
    }));
    for (const p of parts) if (p) out.push(p);
  }

  return out;
}

/* ---------------- helpers ---------------- */

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

export async function fetchBinanceListing() {
  const url = "https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT";
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Binance exchangeInfo ${r.status}`);
  const j = await r.json();
  const pairs = new Set();
  const bases = new Set();
  const ticks = new Map();
  for (const s of j.symbols || []) {
    if (s.status !== "TRADING") continue;
    if (s.quoteAsset !== "USDT") continue;
    const name = `${s.baseAsset}USDT`;
    pairs.add(name);
    bases.add(s.baseAsset);
    // PRICE_FILTER -> tickSize
    const pf = (s.filters || []).find(f => f.filterType === "PRICE_FILTER");
    const lot = (s.filters || []).find(f => f.filterType === "LOT_SIZE");
    const tickSize = pf ? toNum(pf.tickSize) : null;
    const stepSize = lot ? toNum(lot.stepSize) : null;
    ticks.set(name, { tickSize, stepSize });
  }
  return { pairs, bases, ticks };
}

async function fetchKlines(pair, interval, limit) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // map to compact objects
    return rows.map(x => ({
      openTime: x[0],
      open: toNum(x[1]),
      high: toNum(x[2]),
      low:  toNum(x[3]),
      close: toNum(x[4]),
    }));
  } finally {
    clearTimeout(to);
  }
}

function computePctFromKlines(klines, lookbackBars = 1) {
  if (!Array.isArray(klines) || klines.length <= lookbackBars) return NaN;
  const last = toNum(klines[klines.length - 1]?.close);
  const base = toNum(klines[klines.length - 1 - lookbackBars]?.close);
  if (!isFiniteNumber(last) || !isFiniteNumber(base) || base <= 0) return NaN;
  return ((last - base) / base) * 100;
}

function computeATRFromKlines(klines, period = 14) {
  if (!Array.isArray(klines) || klines.length < period + 2) return NaN;
  const H = klines.map(k => k.high);
  const L = klines.map(k => k.low);
  const C = klines.map(k => k.close);
  const TR = [];
  for (let i = 0; i < klines.length; i++) {
    const high = H[i], low = L[i], prevClose = i > 0 ? C[i-1] : C[i];
    TR.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  // Wilder's RMA
  let atr = TR.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < TR.length; i++) {
    atr = (atr * (period - 1) + TR[i]) / period;
  }
  return atr;
}

export function resolveBinancePair(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (STABLES.has(s)) return null;
  if (BINANCE_SYMBOL_FIX[s]) return BINANCE_SYMBOL_FIX[s];
  return `${s}USDT`;
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
  const t = Math.abs(thr);
  if (x >  +t) return +1;
  if (x <  -t) return -1;
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

function pickMultipliers(conf, baseSL, baseTP) {
  // adaptivni ladder po confidence
  if (conf >= 90) return { sl: Math.max(0.8, baseSL * 0.9), tp: Math.max(baseTP, 1.8) };
  if (conf >= 80) return { sl: baseSL, tp: Math.max(baseTP, 1.9) };
  if (conf >= 75) return { sl: Math.max(baseSL, 1.1), tp: Math.max(baseTP, 2.0) };
  return { sl: baseSL, tp: baseTP };
}

function roundToTick(price, tickSize) {
  if (!isFiniteNumber(price)) return null;
  if (!isFiniteNumber(tickSize) || tickSize <= 0) {
    // heuristika ako nemamo tickSize
    return roundHeuristic(price);
  }
  const n = Math.round(price / tickSize) * tickSize;
  return Number(n.toFixed(decimalsFromStep(tickSize)));
}
function decimalsFromStep(step) {
  if (!isFiniteNumber(step)) return 4;
  const s = String(step);
  const dot = s.indexOf(".");
  return dot >= 0 ? (s.length - dot - 1) : 0;
}
function roundHeuristic(x) {
  if (!isFiniteNumber(x)) return null;
  const v = Math.abs(x);
  if (v >= 100) return Math.round(x * 100) / 100;
  if (v >= 1)   return Math.round(x * 1000) / 1000;
  return Math.round(x * 100000) / 100000;
}

/* small utils */
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function round2(x){ const n = Number(x); return Number.isFinite(n) ? Math.round(n*100)/100 : null; }
function isFiniteNumber(x){ return typeof x==="number" && Number.isFinite(x); }
