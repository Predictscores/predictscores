// lib/crypto-core.js
// Real-exchange core: OKX (primary) + Bybit (fallback) OHLC (30m/1H/4H) + tickSize → ATR(14) Entry/SL/TP.
// CG "markets" se koristi samo za shortlist (mcap/vol/1h/24h/7d). Fudbal se ne dotiče.

export const STABLES = new Set([
  "USDT","USDC","DAI","TUSD","USDD","FDUSD","PYUSD","EUR","EURS","PAX","PAXG","GUSD","BUSD","LUSD","USDP"
]);

/* ---------------- env helpers ---------------- */
function envNum(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }
function envInt(name, def) { const n = parseInt(process.env[name] || "", 10); return Number.isFinite(n) ? n : def; }
function envBool(name, def=false) {
  const s = String(process.env[name] || "").toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  return def;
}
function envList(name, def) {
  const s = String(process.env[name] || "").trim();
  if (!s) return def;
  return s.split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
}

/* ---------------- main ---------------- */
export async function buildSignals(opts = {}) {
  // ---- konfiguracija ----
  const cgApiKey = opts.cgApiKey || (process.env.COINGECKO_API_KEY || "");
  const minVol = Number(opts.minVol ?? envNum("CRYPTO_MIN_VOL_USD", 50_000_000));
  const minMcap = Number(opts.minMcap ?? envNum("CRYPTO_MIN_MCAP_USD", 200_000_000));
  const quorum = Number(opts.quorum ?? envInt("CRYPTO_QUORUM_VOTES", 3));
  const cgTop = Number(opts.binanceTop ?? envInt("CRYPTO_BINANCE_TOP", 150)); // koristi se kao top-N po MCAP
  const thresh = opts.thresh || { m30: 0.2, h1: 0.3, h4: 0.5, d24: 0.0, d7: 0.0 };

  const levelsEnable = envBool("CRYPTO_LEVELS_ENABLE", true);
  const atrPeriod = envInt("CRYPTO_ATR_PERIOD", 14);
  const atrSL = envNum("CRYPTO_ATR_SL_MULT", 1.0);
  const atrTP = envNum("CRYPTO_ATR_TP_MULT", 1.8);
  const levelsValidMin = envInt("CRYPTO_LEVELS_VALID_MIN", 90);
  const requireIntraday = envBool("CRYPTO_REQUIRE_INTRADAY", true);

  const exOrder = envList("CRYPTO_XCHG_ORDER", ["OKX","BYBIT"]);
  const okxEnabled = envBool("CRYPTO_OKX_ENABLE", true);
  const bybitEnabled = envBool("CRYPTO_BYBIT_ENABLE", true);

  // ---- CG markets za shortlist ----
  const cg = await fetchCoinGeckoMarkets(cgApiKey);

  // BTC gate (24h)
  const btc = cg.find((c) => (c.symbol || "").toUpperCase() === "BTC");
  const btc24 = toNum(btc?.price_change_percentage_24h_in_currency, 0);

  // kandidati
  let candidates = cg.filter((c) => {
    const sym = (c.symbol || "").toUpperCase();
    if (STABLES.has(sym)) return false;
    if (!isFiniteNumber(c.market_cap) || c.market_cap < minMcap) return false;
    if (!isFiniteNumber(c.total_volume) || c.total_volume < minVol) return false;
    return true;
  });

  candidates = candidates
    .sort((a, b) => b.market_cap - a.market_cap)
    .slice(0, cgTop)
    .filter((c) => {
      const h1 = Math.abs(toNum(c.price_change_percentage_1h_in_currency));
      const d24 = Math.abs(toNum(c.price_change_percentage_24h_in_currency));
      const d7 = Math.abs(toNum(c.price_change_percentage_7d_in_currency));
      return h1 >= 0.25 || d24 >= 1.0 || d7 >= 1.0;
    });

  // prefetch OKX instruments (jednom)
  let okxInst = null;
  if (okxEnabled && exOrder.includes("OKX")) {
    okxInst = await fetchOKXInstruments().catch(() => null);
  }

  const conc = 8;
  const out = [];
  for (let i = 0; i < candidates.length; i += conc) {
    const slice = candidates.slice(i, i + conc);
    const parts = await Promise.all(slice.map(c => processOne(c)));
    for (const it of parts) if (it) out.push(it);
  }
  return out;

  async function processOne(c) {
    const symbolU = (c.symbol || "").toUpperCase();
    // probaj izvore u definisanom redu
    let ex = null;
    for (const name of exOrder) {
      if (name === "OKX" && okxEnabled) {
        const got = await fromOKX(symbolU, c, okxInst).catch(() => null);
        if (got) { ex = got; break; }
      }
      if (name === "BYBIT" && bybitEnabled) {
        const got = await fromBybit(symbolU, c).catch(() => null);
        if (got) { ex = got; break; }
      }
    }
    if (!ex) return null;

    // quorum votes (m30/h1/h4 sa berze, d24/d7 sa CG)
    const deltas = {
      m30_pct: ex.m30_pct,
      h1_pct:  ex.h1_pct,
      h4_pct:  ex.h4_pct,
      d24_pct: toNum(c.price_change_percentage_24h_in_currency),
      d7_pct:  toNum(c.price_change_percentage_7d_in_currency),
    };
    if (requireIntraday && (!isFiniteNumber(deltas.m30_pct) || !isFiniteNumber(deltas.h4_pct))) return null;

    const votes = votePack(deltas, thresh);
    const available = [deltas.m30_pct, deltas.h1_pct, deltas.h4_pct, deltas.d24_pct, deltas.d7_pct].filter(isFiniteNumber).length;
    const need = Math.max(3, Math.min(quorum, available));
    const pos = [votes.m30, votes.h1, votes.h4, votes.d24, votes.d7].filter(v => v === +1).length;
    const neg = [votes.m30, votes.h1, votes.h4, votes.d24, votes.d7].filter(v => v === -1).length;

    let signal = "NONE";
    if (pos >= need) signal = "LONG";
    else if (neg >= need) signal = "SHORT";
    else return null;

    // BTC gate
    if (signal === "LONG" && btc24 <= -0.3) return null;
    if (signal === "SHORT" && btc24 >= +1.0) return null;

    const confidence_pct = confidenceFrom(deltas, signal, votes);

    // ATR nivo (30m sa berze) + tickSize rounding sa iste berze
    let entry=null, sl=null, tp=null, rr=null, expectedMove=null, valid_until=null;
    if (levelsEnable && ex.k30 && ex.k30.length >= atrPeriod + 2) {
      const atr = computeATRFromKlines(ex.k30, atrPeriod);
      if (isFiniteNumber(atr) && isFiniteNumber(ex.lastClose)) {
        const mult = pickMultipliers(confidence_pct, atrSL, atrTP);
        entry = roundToTick(ex.lastClose, ex.tickSize);
        const rawSL = signal === "LONG" ? (entry - mult.sl * atr) : (entry + mult.sl * atr);
        const rawTP = signal === "LONG" ? (entry + mult.tp * atr) : (entry - mult.tp * atr);
        sl = roundToTick(rawSL, ex.tickSize);
        tp = roundToTick(rawTP, ex.tickSize);
        const risk = Math.abs(entry - sl);
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
      price: toNum(c.current_price),
      market_cap: toNum(c.market_cap),
      total_volume: toNum(c.total_volume),

      // exchange meta
      exchange: ex.exchange,
      pair: ex.pair,
      tickSize: ex.tickSize,

      // deltas
      m30_pct: round2(deltas.m30_pct),
      h1_pct:  round2(deltas.h1_pct),
      h4_pct:  round2(deltas.h4_pct),
      d24_pct: round2(deltas.d24_pct),
      d7_pct:  round2(deltas.d7_pct),

      votes,
      signal,
      confidence_pct,

      // levels
      entry, sl, tp, rr, expectedMove, valid_until,
    };
  }
}

/* ---------------- CoinGecko markets ---------------- */
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

/* ---------------- OKX ---------------- */
async function fetchOKXInstruments() {
  const url = "https://www.okx.com/api/v5/public/instruments?instType=SPOT";
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`OKX instruments ${r.status}`);
  const j = await r.json();
  if (String(j.code) !== "0" || !Array.isArray(j.data)) throw new Error("OKX instruments invalid");
  const mapByBase = new Map(); // baseCcy -> record (USDT)
  for (const s of j.data) {
    if (s.instType !== "SPOT") continue;
    if (s.quoteCcy !== "USDT") continue;
    // prefer EXACT baseCcy match; store the one with baseCcy key
    if (!mapByBase.has(s.baseCcy)) mapByBase.set(s.baseCcy, s);
  }
  return { list: j.data, byBase: mapByBase };
}

async function fetchOKXCandles(instId, bar, limit = 200) {
  // OKX returns newest first; we'll reverse.
  const url = new URL("https://www.okx.com/api/v5/market/candles");
  url.searchParams.set("instId", instId);
  url.searchParams.set("bar", bar); // "30m" | "1H" | "4H"
  url.searchParams.set("limit", String(limit));
  const r = await timedFetch(url.toString(), 12000);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || String(j.code) !== "0" || !Array.isArray(j.data)) return null;
  const rows = j.data.map(a => ({
    openTime: +a[0],
    open: toNum(a[1]),
    high: toNum(a[2]),
    low:  toNum(a[3]),
    close: toNum(a[4]),
  })).filter(k => isFiniteNumber(k.close));
  rows.reverse();
  return rows;
}

async function fromOKX(symbolU, c, okxInst) {
  if (!okxInst) return null;
  const rec = okxInst.byBase.get(symbolU);
  if (!rec) return null;
  const instId = rec.instId;                 // e.g. "BTC-USDT"
  const tickSize = toNum(rec.tickSz);        // string → number

  const [k30, k1h, k4h] = await Promise.all([
    fetchOKXCandles(instId, "30m", 200),
    fetchOKXCandles(instId, "1H",  200),
    fetchOKXCandles(instId, "4H",   60),
  ]);
  if (!k30 || !k1h || !k4h) return null;

  const lastClose = toNum(k30[k30.length - 1]?.close);
  const m30_pct = pctFromSeries(k30, 1);
  const h1_pct  = pctFromSeries(k1h, 1);
  const h4_pct  = pctFromSeries(k4h, 1);

  if (!isFiniteNumber(m30_pct) || !isFiniteNumber(h1_pct) || !isFiniteNumber(h4_pct)) return null;

  return { exchange: "OKX", pair: instId, tickSize, k30, lastClose, m30_pct, h1_pct, h4_pct };
}

/* ---------------- Bybit ---------------- */
async function fetchBybitInstrument(symbol) {
  // symbol npr. "BTCUSDT"
  const url = new URL("https://api.bybit.com/v5/market/instruments-info");
  url.searchParams.set("category", "spot");
  url.searchParams.set("symbol", symbol);
  const r = await timedFetch(url.toString(), 12000);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || j.retCode !== 0) return null;
  const rec = j?.result?.list?.[0];
  if (!rec || rec.status !== "Trading") return null;
  const tickSize = toNum(rec?.priceFilter?.tickSize);
  return { tickSize };
}

async function fetchBybitCandles(symbol, interval, limit = 200) {
  // interval: 30 | 60 | 240
  const url = new URL("https://api.bybit.com/v5/market/kline");
  url.searchParams.set("category", "spot");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", String(interval));
  url.searchParams.set("limit", String(limit));
  const r = await timedFetch(url.toString(), 12000);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || j.retCode !== 0) return null;
  const arr = j?.result?.list;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const rows = arr.map(a => ({
    openTime: +a[0],
    open: toNum(a[1]),
    high: toNum(a[2]),
    low:  toNum(a[3]),
    close: toNum(a[4]),
  })).filter(k => isFiniteNumber(k.close));
  rows.reverse();
  return rows;
}

async function fromBybit(symbolU, c) {
  const sym = `${symbolU}USDT`;
  const meta = await fetchBybitInstrument(sym);
  if (!meta) return null;

  const [k30, k1h, k4h] = await Promise.all([
    fetchBybitCandles(sym, 30, 200),
    fetchBybitCandles(sym, 60, 200),
    fetchBybitCandles(sym, 240, 60),
  ]);
  if (!k30 || !k1h || !k4h) return null;

  const lastClose = toNum(k30[k30.length - 1]?.close);
  const m30_pct = pctFromSeries(k30, 1);
  const h1_pct  = pctFromSeries(k1h, 1);
  const h4_pct  = pctFromSeries(k4h, 1);

  if (!isFiniteNumber(m30_pct) || !isFiniteNumber(h1_pct) || !isFiniteNumber(h4_pct)) return null;

  return { exchange: "BYBIT", pair: sym, tickSize: meta.tickSize, k30, lastClose, m30_pct, h1_pct, h4_pct };
}

/* ---------------- math & utils ---------------- */
function pctFromSeries(klines, lookbackBars = 1) {
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
  // Wilder RMA
  let atr = TR.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < TR.length; i++) {
    atr = (atr * (period - 1) + TR[i]) / period;
  }
  return atr;
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
  if (conf >= 90) return { sl: Math.max(0.8, baseSL * 0.9), tp: Math.max(baseTP, 1.8) };
  if (conf >= 80) return { sl: baseSL, tp: Math.max(baseTP, 1.9) };
  if (conf >= 75) return { sl: Math.max(baseSL, 1.1), tp: Math.max(baseTP, 2.0) };
  return { sl: baseSL, tp: baseTP };
}
function roundToTick(price, tickSize) {
  if (!isFiniteNumber(price)) return null;
  if (!isFiniteNumber(tickSize) || tickSize <= 0) return price;
  const decimals = decimalsFromTick(tickSize);
  const n = Math.round(price / tickSize) * tickSize;
  return Number(n.toFixed(decimals));
}
function decimalsFromTick(step) {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot >= 0 ? (s.length - dot - 1) : 0;
}
function timedFetch(url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 10000);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function round2(x){ const n = Number(x); return Number.isFinite(n) ? Math.round(n*100)/100 : null; }
function isFiniteNumber(x){ return typeof x==="number" && Number.isFinite(x); }
