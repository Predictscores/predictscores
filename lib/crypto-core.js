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
function positiveOrDefault(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
}

const CONFIDENCE_KV_KEY = process.env.CRYPTO_CONFIDENCE_KV_KEY || "crypto:confidence:calib";
const CONFIDENCE_CACHE_MS = Math.max(30_000, Number(process.env.CRYPTO_CONFIDENCE_CACHE_MS) || 5 * 60 * 1000);
let confidenceCache = { ts: 0, value: null };

/* ---------------- main ---------------- */
export async function buildSignals(opts = {}) {
  // ---- konfiguracija ----
  const cgApiKey = opts.cgApiKey || (process.env.COINGECKO_API_KEY || "");
  const minVol = Number(opts.minVol ?? envNum("CRYPTO_MIN_VOL_USD", 50_000_000));
  const minMcap = Number(opts.minMcap ?? envNum("CRYPTO_MIN_MCAP_USD", 200_000_000));
  const quorum = Number(opts.quorum ?? envInt("CRYPTO_QUORUM_VOTES", 3));
  const cgTop = Number(opts.binanceTop ?? envInt("CRYPTO_BINANCE_TOP", 150)); // koristi se kao top-N po MCAP
  const baseThresh = opts?.thresh || {};
  const fallbackThresh = {
    m30: toNum(baseThresh.m30, 0.2),
    h1: toNum(baseThresh.h1, 0.3),
    h4: toNum(baseThresh.h4, 0.5),
    d24: toNum(baseThresh.d24, 0.0),
    d7: toNum(baseThresh.d7, 0.0),
  };
  const envVolMult = {
    m30: envNum("CRYPTO_VOL_MULT_M30", 0.35),
    h1: envNum("CRYPTO_VOL_MULT_H1", 0.3),
    h4: envNum("CRYPTO_VOL_MULT_H4", 0.25),
  };
  const volMultipliers = {
    m30: positiveOrDefault(opts?.volMultipliers?.m30, envVolMult.m30),
    h1: positiveOrDefault(opts?.volMultipliers?.h1, envVolMult.h1),
    h4: positiveOrDefault(opts?.volMultipliers?.h4, envVolMult.h4),
  };

  const levelsEnable = envBool("CRYPTO_LEVELS_ENABLE", true);
  const atrPeriod = envInt("CRYPTO_ATR_PERIOD", 14);
  const atrSL = envNum("CRYPTO_ATR_SL_MULT", 1.0);
  const atrTP = envNum("CRYPTO_ATR_TP_MULT", 1.8);
  const levelsValidMin = envInt("CRYPTO_LEVELS_VALID_MIN", 90);
  const requireIntraday = envBool("CRYPTO_REQUIRE_INTRADAY", true);

  const exOrder = envList("CRYPTO_XCHG_ORDER", ["OKX","BYBIT"]);
  const okxEnabled = envBool("CRYPTO_OKX_ENABLE", true);
  const bybitEnabled = envBool("CRYPTO_BYBIT_ENABLE", true);

  const confidenceConfig = await getConfidenceConfig().catch(() => defaultConfidenceConfig());

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

    const structure = {
      m30: computeTimeframeStructure(ex.k30, { adxPeriod, volLookback: 60, hurstLookback: 120 }),
      h1:  computeTimeframeStructure(ex.k1h, { adxPeriod, volLookback: 60, hurstLookback: 150 }),
      h4:  computeTimeframeStructure(ex.k4h, { adxPeriod, volLookback: 60, hurstLookback: 180 }),
    };
    const regimeInfo = deriveRegimeFromStructure(structure);
    const regime = regimeInfo.regime;

    // quorum votes (m30/h1/h4 sa berze, d24/d7 sa CG)
    const deltas = {
      m30_pct: ex.m30_pct,
      h1_pct:  ex.h1_pct,
      h4_pct:  ex.h4_pct,
      d24_pct: toNum(c.price_change_percentage_24h_in_currency),
      d7_pct:  toNum(c.price_change_percentage_7d_in_currency),
    };
    if (requireIntraday && (!isFiniteNumber(deltas.m30_pct) || !isFiniteNumber(deltas.h4_pct))) return null;

    const realizedVol = {
      m30: computeLogReturnVolatilityFromKlines(ex.k30, 60),
      h1: computeLogReturnVolatilityFromKlines(ex.k1h, 60),
      h4: computeLogReturnVolatilityFromKlines(ex.k4h, 60),
    };
    const thresholds = deriveVolatilityThresholds(realizedVol, volMultipliers, fallbackThresh);
    const votes = votePack(deltas, thresholds);
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

    let confidence_pct = confidenceFrom(deltas, signal, votes, confidenceConfig);
    const regimeAdjusted = adjustSignalForRegime(signal, votes, structure, regimeInfo, confidence_pct);
    if (!regimeAdjusted || regimeAdjusted.signal === "NONE") return null;
    signal = regimeAdjusted.signal;
    confidence_pct = clampPercent(confidence_pct + (regimeAdjusted.confidenceAdj || 0));

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

      regime,
      regime_meta: {
        focus: regimeInfo.focus,
        low_vol: !!regimeInfo.lowVol,
        event_tf: regimeInfo.eventTf || null,
        best_adx: Number.isFinite(regimeInfo.bestAdx) ? round2(regimeInfo.bestAdx) : null,
      },
      structure,
      market_structure: structure,
      adx: extractStructureField(structure, "adx"),
      volatility: extractStructureField(structure, "vol"),
      hurst: extractStructureField(structure, "hurst"),
      directional_index: extractDirectionalIndex(structure),

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
function computeADXFromKlines(klines, period = 14) {
  if (!Array.isArray(klines) || klines.length < period + 1) return { adx: NaN, plusDI: NaN, minusDI: NaN };
  const highs = klines.map((k) => toNum(k.high));
  const lows = klines.map((k) => toNum(k.low));
  const closes = klines.map((k) => toNum(k.close));
  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < klines.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevHigh = highs[i - 1];
    const prevLow = lows[i - 1];
    const prevClose = closes[i - 1];
    if (!isFiniteNumber(high) || !isFiniteNumber(low) || !isFiniteNumber(prevHigh) || !isFiniteNumber(prevLow) || !isFiniteNumber(prevClose)) continue;
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDM.push((upMove > downMove && upMove > 0) ? upMove : 0);
    minusDM.push((downMove > upMove && downMove > 0) ? downMove : 0);
    const trueRange = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    tr.push(trueRange);
  }
  if (tr.length < period) return { adx: NaN, plusDI: NaN, minusDI: NaN };
  let trAvg = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusAvg = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusAvg = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  if (trAvg <= 0) return { adx: NaN, plusDI: NaN, minusDI: NaN };
  let plusDI = (plusAvg / trAvg) * 100;
  let minusDI = (minusAvg / trAvg) * 100;
  const dxInit = Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 1e-9) * 100;
  let adx = dxInit;
  for (let i = period; i < tr.length; i++) {
    trAvg = trAvg - (trAvg / period) + tr[i];
    plusAvg = plusAvg - (plusAvg / period) + plusDM[i];
    minusAvg = minusAvg - (minusAvg / period) + minusDM[i];
    if (trAvg <= 0) continue;
    plusDI = (plusAvg / trAvg) * 100;
    minusDI = (minusAvg / trAvg) * 100;
    const dx = Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 1e-9) * 100;
    adx = (adx * (period - 1) + dx) / period;
  }
  return {
    adx: Number.isFinite(adx) ? adx : NaN,
    plusDI: Number.isFinite(plusDI) ? plusDI : NaN,
    minusDI: Number.isFinite(minusDI) ? minusDI : NaN,
  };
}
function computeRealizedVolatilityFromKlines(klines, lookback = 30) {
  if (!Array.isArray(klines) || klines.length < 2) return NaN;
  const closes = klines.map((k) => toNum(k.close)).filter((v) => isFiniteNumber(v) && v > 0);
  if (closes.length < 2) return NaN;
  const effectiveLookback = Math.max(1, Math.min(lookback, closes.length - 1));
  const start = Math.max(1, closes.length - effectiveLookback);
  const rets = [];
  for (let i = start; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!isFiniteNumber(prev) || !isFiniteNumber(curr) || prev <= 0) continue;
    rets.push((curr - prev) / prev);
  }
  if (rets.length < 2) return NaN;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let variance = 0;
  for (const r of rets) variance += (r - mean) ** 2;
  variance = variance / Math.max(1, rets.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return NaN;
  return Math.sqrt(variance) * 100;
}
function computeLogReturnVolatilityFromKlines(klines, lookback = 60) {
  if (!Array.isArray(klines) || klines.length < 2) return NaN;
  const closes = klines.map((k) => toNum(k.close)).filter((v) => isFiniteNumber(v) && v > 0);
  if (closes.length < 2) return NaN;
  const effectiveLookback = Math.max(1, Math.min(lookback, closes.length - 1));
  const start = closes.length - effectiveLookback;
  const rets = [];
  for (let i = start; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!isFiniteNumber(prev) || !isFiniteNumber(curr) || prev <= 0) continue;
    const r = Math.log(curr / prev);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 2) return NaN;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let variance = 0;
  for (const r of rets) variance += (r - mean) ** 2;
  variance = variance / Math.max(1, rets.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return NaN;
  return Math.sqrt(variance) * 100;
}
function computeHurstExponentFromKlines(klines, lookback = 120) {
  if (!Array.isArray(klines) || klines.length < 20) return NaN;
  const closes = klines.map((k) => toNum(k.close)).filter((v) => isFiniteNumber(v) && v > 0);
  if (closes.length < 20) return NaN;
  const slice = closes.slice(-Math.max(lookback, 20));
  const logPrices = slice.map((p) => Math.log(p)).filter((v) => Number.isFinite(v));
  if (logPrices.length < 20) return NaN;
  const scales = [5, 10, 15, 20, 30, 45, 60, 90, 120, 150].filter((s) => s < logPrices.length && Math.floor(logPrices.length / s) >= 2);
  if (!scales.length) return NaN;
  const points = [];
  for (const scale of scales) {
    const segments = Math.floor(logPrices.length / scale);
    if (segments < 2) continue;
    let rsSum = 0;
    let count = 0;
    for (let seg = 0; seg < segments; seg++) {
      const start = seg * scale;
      const end = start + scale;
      const segment = logPrices.slice(start, end);
      if (segment.length < 2) continue;
      const mean = segment.reduce((a, b) => a + b, 0) / segment.length;
      let cumulative = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      let variance = 0;
      for (let i = 0; i < segment.length; i++) {
        const dev = segment[i] - mean;
        cumulative += dev;
        if (cumulative > maxCum) maxCum = cumulative;
        if (cumulative < minCum) minCum = cumulative;
        variance += dev * dev;
      }
      const std = Math.sqrt(variance / Math.max(1, segment.length - 1));
      if (!Number.isFinite(std) || std <= 0) continue;
      const range = maxCum - minCum;
      if (!Number.isFinite(range) || range <= 0) continue;
      const rs = range / std;
      if (Number.isFinite(rs) && rs > 0) {
        rsSum += rs;
        count += 1;
      }
    }
    if (count > 0) {
      const avg = rsSum / count;
      if (Number.isFinite(avg) && avg > 0) points.push({ scale, value: avg });
    }
  }
  if (points.length < 2) return NaN;
  const logScale = points.map((p) => Math.log(p.scale));
  const logRS = points.map((p) => Math.log(p.value));
  const slope = linearRegressionSlope(logScale, logRS);
  if (!Number.isFinite(slope)) return NaN;
  return clamp01(slope);
}
function linearRegressionSlope(xArr, yArr) {
  const n = Math.min(xArr.length, yArr.length);
  if (n < 2) return NaN;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = xArr[i];
    const y = yArr[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return NaN;
  return (n * sumXY - sumX * sumY) / denom;
}
function computeTimeframeStructure(klines, opts = {}) {
  const out = { adx: null, plusDI: null, minusDI: null, vol: null, hurst: null };
  if (!Array.isArray(klines) || klines.length < 5) return out;
  const adxPeriod = Number.isFinite(opts.adxPeriod) ? opts.adxPeriod : 14;
  const volLookback = Number.isFinite(opts.volLookback) ? opts.volLookback : 30;
  const hurstLookback = Number.isFinite(opts.hurstLookback) ? opts.hurstLookback : 120;
  const adxPack = computeADXFromKlines(klines, adxPeriod);
  const vol = computeRealizedVolatilityFromKlines(klines, volLookback);
  const hurst = computeHurstExponentFromKlines(klines, hurstLookback);
  const adxVal = Number.isFinite(adxPack.adx) ? round2(adxPack.adx) : null;
  const plusVal = Number.isFinite(adxPack.plusDI) ? round2(adxPack.plusDI) : null;
  const minusVal = Number.isFinite(adxPack.minusDI) ? round2(adxPack.minusDI) : null;
  const volVal = Number.isFinite(vol) ? round2(vol) : null;
  const hurstVal = Number.isFinite(hurst) ? round2(hurst) : null;
  if (adxVal != null) out.adx = adxVal;
  if (plusVal != null) out.plusDI = plusVal;
  if (minusVal != null) out.minusDI = minusVal;
  if (volVal != null) out.vol = volVal;
  if (hurstVal != null) out.hurst = hurstVal;
  return out;
}
function deriveRegimeFromStructure(structure) {
  const base = { regime: "range", focus: "h1", lowVol: false, eventTf: null, bestAdx: null };
  if (!structure || typeof structure !== "object") return base;
  const thresholds = {
    adxTrend: 22,
    volHigh: { m30: 1.6, h1: 1.8, h4: 2.2 },
    volLow: { m30: 0.55, h1: 0.75, h4: 0.95 },
  };

  let highVolTf = null;
  let highVolValue = -Infinity;
  for (const tf of ["m30", "h1", "h4"]) {
    const vol = structure?.[tf]?.vol;
    if (Number.isFinite(vol) && vol >= thresholds.volHigh[tf]) {
      if (vol > highVolValue) {
        highVolValue = vol;
        highVolTf = tf;
      }
    }
  }
  if (highVolTf) {
    base.regime = "event";
    base.focus = highVolTf;
    base.eventTf = highVolTf;
    const adxVal = structure?.[highVolTf]?.adx;
    if (Number.isFinite(adxVal)) base.bestAdx = adxVal;
    return base;
  }

  let best = { tf: null, value: -Infinity };
  for (const tf of ["h4", "h1", "m30"]) {
    const adx = structure?.[tf]?.adx;
    if (Number.isFinite(adx) && adx > best.value) {
      best = { tf, value: adx };
    }
  }
  if (best.tf) {
    base.focus = best.tf;
    base.bestAdx = best.value;
    if (best.value >= thresholds.adxTrend) {
      base.regime = "trend";
      return base;
    }
  }

  let lowVolCount = 0;
  for (const tf of ["m30", "h1", "h4"]) {
    const vol = structure?.[tf]?.vol;
    if (Number.isFinite(vol) && vol <= thresholds.volLow[tf]) lowVolCount += 1;
  }
  base.lowVol = lowVolCount >= 2;
  base.regime = base.lowVol ? "range" : "range";
  if (!base.lowVol && best.tf) base.focus = best.tf;
  return base;
}
function adjustSignalForRegime(signal, votes, structure, regimeInfo, baseConfidence) {
  if (!signal || signal === "NONE") return { signal: "NONE", confidenceAdj: 0 };
  const info = regimeInfo || { regime: "range", focus: "h1", lowVol: false };
  const node = selectStructureNode(structure, info.focus);
  let confidenceAdj = 0;

  if (info.regime === "trend") {
    if (node) {
      const plus = node.plusDI;
      const minus = node.minusDI;
      if (Number.isFinite(plus) && Number.isFinite(minus)) {
        if (signal === "LONG" && plus <= minus) return { signal: "NONE" };
        if (signal === "SHORT" && minus <= plus) return { signal: "NONE" };
      }
    }
    confidenceAdj += 6;
  } else if (info.regime === "range") {
    confidenceAdj -= info.lowVol ? 6 : 3;
    if (node) {
      const hurst = node.hurst;
      if (Number.isFinite(hurst)) {
        if (hurst < 0.45) confidenceAdj += 2;
        if (hurst > 0.65) confidenceAdj -= 4;
      }
    }
  } else if (info.regime === "event") {
    if (!Number.isFinite(baseConfidence) || baseConfidence < 70 || Math.abs(votes?.sum ?? 0) < 3) {
      return { signal: "NONE" };
    }
    confidenceAdj -= 5;
  }

  return { signal, confidenceAdj };
}
function selectStructureNode(structure, focus) {
  if (!structure || typeof structure !== "object") return null;
  if (focus && structure[focus]) return structure[focus];
  if (structure.h1) return structure.h1;
  if (structure.m30) return structure.m30;
  if (structure.h4) return structure.h4;
  return null;
}
function extractStructureField(structure, key) {
  const out = { m30: null, h1: null, h4: null };
  if (!structure || typeof structure !== "object") return out;
  for (const tf of ["m30", "h1", "h4"]) {
    const val = structure?.[tf]?.[key];
    out[tf] = Number.isFinite(val) ? val : null;
  }
  return out;
}
function extractDirectionalIndex(structure) {
  const out = {
    m30: { plus: null, minus: null },
    h1: { plus: null, minus: null },
    h4: { plus: null, minus: null },
  };
  if (!structure || typeof structure !== "object") return out;
  for (const tf of ["m30", "h1", "h4"]) {
    const node = structure[tf] || {};
    out[tf] = {
      plus: Number.isFinite(node.plusDI) ? node.plusDI : null,
      minus: Number.isFinite(node.minusDI) ? node.minusDI : null,
    };
  }
  return out;
}
function clampPercent(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function deriveVolatilityThresholds(volMap, multipliers, fallback) {
  const base = typeof fallback === "object" && fallback ? { ...fallback } : {};
  for (const tf of ["m30", "h1", "h4"]) {
    const vol = Number(volMap?.[tf]);
    const mult = Number(multipliers?.[tf]);
    if (Number.isFinite(vol) && vol >= 0 && Number.isFinite(mult) && mult > 0) {
      const thr = vol * mult;
      if (Number.isFinite(thr) && thr >= 0) {
        base[tf] = thr;
        continue;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(base, tf)) base[tf] = 0;
  }
  if (!Object.prototype.hasOwnProperty.call(base, "d24")) base.d24 = 0;
  if (!Object.prototype.hasOwnProperty.call(base, "d7")) base.d7 = 0;
  return base;
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
  const t = Number.isFinite(thr) ? Math.abs(thr) : 0;
  if (x >  +t) return +1;
  if (x <  -t) return -1;
  return 0;
}
export function defaultConfidenceConfig() {
  return {
    weights: { m30: 0.15, h1: 0.30, h4: 0.25, d24: 0.20, d7: 0.10 },
    scales: { m30: 0.8, h1: 1.2, h4: 2.0, d24: 3.0, d7: 5.0 },
  };
}

export async function getConfidenceConfig(force = false) {
  const now = Date.now();
  if (!force && confidenceCache.value && now - confidenceCache.ts < CONFIDENCE_CACHE_MS) {
    return confidenceCache.value;
  }

  const envOverride = parseConfidenceOverride(process.env.CRYPTO_CONFIDENCE_PARAMS);
  if (envOverride) {
    const cfg = sanitizeConfidenceConfig(envOverride, "env");
    confidenceCache = { ts: now, value: cfg };
    return cfg;
  }

  const remote = await fetchConfidenceConfigFromKV().catch(() => null);
  if (remote) {
    const cfg = sanitizeConfidenceConfig(remote, remote?.source || "kv");
    confidenceCache = { ts: now, value: cfg };
    return cfg;
  }

  const fallback = sanitizeConfidenceConfig(defaultConfidenceConfig(), "default");
  confidenceCache = { ts: now, value: fallback };
  return fallback;
}

export function confidenceFrom(d, signal, votes, cfg) {
  const config = ensureConfidenceConfig(cfg);
  const weights = config.weights;
  const scales = config.scales;
  const norm = (x, s) => Math.tanh(toNum(x, 0) / (s || 1));
  const dir = (signal === "LONG") ? +1 : -1;
  const score =
    (weights.m30 || 0) * norm(dir * d.m30_pct, scales.m30) +
    (weights.h1  || 0) * norm(dir * d.h1_pct,  scales.h1)  +
    (weights.h4  || 0) * norm(dir * d.h4_pct,  scales.h4)  +
    (weights.d24 || 0) * norm(dir * d.d24_pct, scales.d24) +
    (weights.d7  || 0) * norm(dir * d.d7_pct,  scales.d7);
  let conf = 55 + 40 * clamp01((score + 1) / 2);
  if (Math.abs(votes?.sum) === 5) conf = Math.max(conf, 85);
  return Math.round(conf);
}

function ensureConfidenceConfig(cfg) {
  if (cfg && cfg.__normalized && cfg.weights && cfg.scales) return cfg;
  if (cfg && cfg.weights && cfg.scales) {
    return sanitizeConfidenceConfig({ weights: cfg.weights, scales: cfg.scales, meta: cfg.meta, source: cfg.meta?.source }, cfg.meta?.source);
  }
  return sanitizeConfidenceConfig(defaultConfidenceConfig(), "default");
}

function sanitizeConfidenceConfig(raw, sourceHint) {
  const base = defaultConfidenceConfig();
  const weights = { ...base.weights };
  const scales = { ...base.scales };
  const meta = {};
  if (sourceHint) meta.source = sourceHint;

  if (raw && typeof raw === "object") {
    const weightSrc = pickWeightSource(raw);
    if (weightSrc) {
      for (const key of Object.keys(weights)) {
        const val = Number(weightSrc[key]);
        if (Number.isFinite(val) && val >= 0) weights[key] = val;
      }
    }
    const scaleSrc = raw.scales && typeof raw.scales === "object" ? raw.scales : null;
    if (scaleSrc) {
      for (const key of Object.keys(scales)) {
        const val = Number(scaleSrc[key]);
        if (Number.isFinite(val) && val > 0) scales[key] = val;
      }
    }
    if (!meta.source && typeof raw.source === "string") meta.source = raw.source;
    if (raw.meta && typeof raw.meta === "object") {
      Object.assign(meta, raw.meta);
    }
    if (raw.ts) meta.ts = Number(raw.ts) || null;
    if (raw.sample_count) meta.sample_count = Number(raw.sample_count) || null;
    if (raw.loss != null) meta.loss = Number(raw.loss) || null;
    if (raw.evaluation && typeof raw.evaluation === "object") meta.evaluation = raw.evaluation;
    if (raw.stats && typeof raw.stats === "object") meta.stats = raw.stats;
  }

  let sum = 0;
  for (const key of Object.keys(weights)) {
    const val = Number(weights[key]);
    if (!Number.isFinite(val) || val < 0) {
      weights[key] = base.weights[key];
    }
    sum += weights[key];
  }
  if (!Number.isFinite(sum) || sum <= 0) {
    for (const key of Object.keys(weights)) weights[key] = base.weights[key];
    sum = Object.values(weights).reduce((a, b) => a + b, 0);
  }
  if (sum > 0) {
    for (const key of Object.keys(weights)) weights[key] = weights[key] / sum;
  }

  for (const key of Object.keys(scales)) {
    const val = Number(scales[key]);
    if (!Number.isFinite(val) || val <= 0) {
      scales[key] = base.scales[key];
    } else {
      const clamped = Math.max(0.2, Math.min(10, val));
      scales[key] = clamped;
    }
  }

  if (!meta.source) meta.source = sourceHint || "default";
  return { weights, scales, meta, __normalized: true };
}

function pickWeightSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.weights && typeof raw.weights === "object") return raw.weights;
  const keys = Object.keys(defaultConfidenceConfig().weights);
  const hasDirect = keys.some((k) => Object.prototype.hasOwnProperty.call(raw, k));
  return hasDirect ? raw : null;
}

function parseConfidenceOverride(raw) {
  if (!raw) return null;
  const txt = String(raw || "").trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function fetchConfidenceConfigFromKV() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !CONFIDENCE_KV_KEY) return null;
  try {
    const base = url.replace(/\/+$/, "");
    const u = `${base}/get/${encodeURIComponent(CONFIDENCE_KV_KEY)}`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!r.ok) return null;
    const raw = await r.json().catch(() => null);
    const val = raw?.result;
    if (!val) return null;
    try {
      if (typeof val === "string") return JSON.parse(val);
      if (typeof val === "object") return val;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
  return null;
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
