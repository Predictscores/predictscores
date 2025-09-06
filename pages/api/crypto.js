// pages/api/crypto.js
// Ekstremno "čisti" LONG/SHORT signali kroz multi-timeframe konsenzus (30m, 1h, 4h, 24h, 7d)
// + BTC market-regime, likvidnost/MCAP filteri, Top-N, anti-flip i Upstash KV keš.
// Optimizovano da radi kao osnova za automatski watchdog (vidi /api/cron/crypto-watchdog.js).

const {
  COINGECKO_API_KEY = "",
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRYPTO_TOP_N = "5",               // vrati najjačih N signala
  CRYPTO_MIN_VOL_USD = "100000000", // min 24h volumen
  CRYPTO_MIN_MCAP_USD = "500000000",// min market cap
  CRYPTO_COOLDOWN_MIN = "30",       // anti-flip period (min)
  CRYPTO_REFRESH_MINUTES = "45",    // keš TTL (min)
  CRYPTO_QUORUM_VOTES = "4",        // koliko glasova od 5 mora da se složi (30m,1h,4h,24h,7d)
  CRYPTO_BINANCE_TOP = "120",       // koliko top kovanica (po MCAP) šaljemo na Binance provere
} = process.env;

const CFG = {
  TOP_N: clampInt(CRYPTO_TOP_N, 5, 1, 10),
  MIN_VOL: toNum(CRYPTO_MIN_VOL_USD, 100_000_000),
  MIN_MCAP: toNum(CRYPTO_MIN_MCAP_USD, 500_000_000),
  COOLDOWN_MIN: clampInt(CRYPTO_COOLDOWN_MIN, 30, 0, 1440),
  REFRESH_MIN: clampInt(CRYPTO_REFRESH_MINUTES, 45, 5, 720),
  QUORUM: clampInt(CRYPTO_QUORUM_VOTES, 4, 3, 5),
  BINANCE_TOP: clampInt(CRYPTO_BINANCE_TOP, 120, 20, 250),
  // pragovi po timeframe-u (u procentnim poenima)
  THRESH: { m30: 0.2, h1: 0.3, h4: 0.5, d24: 0.0, d7: 0.0 },
};

const STABLES = new Set([
  "USDT","USDC","DAI","TUSD","USDD","FDUSD","PYUSD","EUR","EURS","PAX","PAXG","GUSD","BUSD","LUSD","USDP"
]);

const BINANCE_SYMBOL_FIX = {
  // primeri mapiranja ako zatreba: "IOTA": "IOTAUSDT"
};

export default async function handler(req, res) {
  try {
    const force = parseBool(req.query.force || "0");
    const n = clampInt(req.query.n, CFG.TOP_N, 1, 10);

    // 1) Keš provera
    const cacheKey = "crypto:signals:latest";
    if (!force) {
      const cached = await kvGetJSON(cacheKey);
      if (cached && Array.isArray(cached.items) && cached.items.length) {
        return res.status(200).json({
          ok: true,
          source: "cache",
          ts: cached.ts || Date.now(),
          ttl_min: cached.ttl_min || CFG.REFRESH_MIN,
          count: Math.min(n, cached.items.length),
          items: cached.items.slice(0, n),
        });
      }
    }

    // 2) CoinGecko markets (1h,24h,7d; price, mcap, vol)
    const cg = await fetchCoinGeckoMarkets();

    // 3) BTC režim (za gating)
    const btc = cg.find((c) => (c.symbol || "").toUpperCase() === "BTC");
    const btc24 = toNum(btc?.price_change_percentage_24h_in_currency, 0);

    // 4) Likvidnost/mcap + izbaci stable
    let candidates = cg.filter((c) => {
      const symbol = (c.symbol || "").toUpperCase();
      if (STABLES.has(symbol)) return false;
      if (!isFiniteNumber(c.market_cap) || c.market_cap < CFG.MIN_MCAP) return false;
      if (!isFiniteNumber(c.total_volume) || c.total_volume < CFG.MIN_VOL) return false;
      return true;
    });

    // 5) Smanji opseg za Binance: uzmi top po MCAP + mali CG pre-filter po pokretu
    candidates = candidates
      .sort((a, b) => b.market_cap - a.market_cap)
      .slice(0, CFG.BINANCE_TOP)
      .filter((c) => {
        const h1 = Math.abs(toNum(c.price_change_percentage_1h_in_currency));
        const d24 = Math.abs(toNum(c.price_change_percentage_24h_in_currency));
        const d7 = Math.abs(toNum(c.price_change_percentage_7d_in_currency));
        return h1 >= 0.25 || d24 >= 1.0 || d7 >= 1.0; // izbaci mrtav range pre Binance-a
      });

    // 6) Binance 30m i 4h + glasanje (30m,1h,4h,24h,7d)
    const enriched = await enrichWithBinanceAndVote(candidates);

    // 7) BTC regime gating
    const gated = enriched.filter((it) => {
      if (it.signal === "LONG" && btc24 < 0) return false;
      if (it.signal === "SHORT" && btc24 > 1.0) return false;
      return true;
    });

    // 8) Stickiness / anti-flip
    const stabilized = await applyStickiness(gated, CFG.COOLDOWN_MIN);

    // 9) Sortiraj po confidence i uzmi Top-N
    const top = stabilized
      .sort((a, b) => (b.confidence_pct - a.confidence_pct))
      .slice(0, n);

    // 10) Upisi keš (celu listu bez n-limit) sa TTL
    const payload = { ts: Date.now(), ttl_min: CFG.REFRESH_MIN, items: stabilized };
    await kvSetJSON(cacheKey, payload, CFG.REFRESH_MIN * 60);

    return res.status(200).json({
      ok: true,
      source: "live",
      ts: payload.ts,
      ttl_min: payload.ttl_min,
      count: top.length,
      items: top,
    });

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}

/* ---------------- CoinGecko ---------------- */

async function fetchCoinGeckoMarkets() {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "250");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  url.searchParams.set("price_change_percentage", "1h,24h,7d");

  const headers = {};
  if (COINGECKO_API_KEY) headers["x-cg-pro-api-key"] = COINGECKO_API_KEY;

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

/* ---------------- Binance ---------------- */

async function enrichWithBinanceAndVote(list) {
  const out = [];
  const CONC = 10; // paralelizam
  for (let i = 0; i < list.length; i += CONC) {
    const slice = list.slice(i, i + CONC);
    const parts = await Promise.all(slice.map(buildOne));
    for (const p of parts) if (p) out.push(p);
  }
  return out;

  async function buildOne(c) {
    const symbol = c.symbol;
    const pair = resolveBinancePair(symbol);
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

    const votes = votePack(deltas, CFG.THRESH);

    let signal = "NONE";
    if (votes.sum >= CFG.QUORUM) signal = "LONG";
    else if (votes.sum <= -CFG.QUORUM) signal = "SHORT";
    else return null; // mešovito → odbaci

    const conf = confidenceFrom(deltas, signal, votes);

    return {
      id: c.id,
      symbol,
      name: c.name,
      image: c.image,
      price: c.current_price,
      market_cap: c.market_cap,
      total_volume: c.total_volume,
      pair,
      signal,               // "LONG" | "SHORT"
      confidence_pct: conf, // 55–95
      m30_pct: round2(deltas.m30_pct),
      h1_pct:  round2(deltas.h1_pct),
      h4_pct:  round2(deltas.h4_pct),
      d24_pct: round2(deltas.d24_pct),
      d7_pct:  round2(deltas.d7_pct),
      votes, // { m30,h1,h4,d24,d7,sum }
    };
  }
}

async function fetchBinancePct(pair, interval, limit, lookbackBars) {
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

function resolveBinancePair(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (STABLES.has(s)) return null;
  if (BINANCE_SYMBOL_FIX[s]) return BINANCE_SYMBOL_FIX[s];
  return `${s}USDT`; // default: spot USDT par
}

/* ---------------- Voting & Confidence ---------------- */

function votePack(d, T) {
  const m30 = voteOne(d.m30_pct, T.m30);
  const h1  = voteOne(d.h1_pct,  T.h1);
  const h4  = voteOne(d.h4_pct,  T.h4);
  const d24 = voteOne(d.d24_pct, T.d24);
  const d7  = voteOne(d.d7_pct,  T.d7);
  const sum = m30 + h1 + h4 + d24 + d7;
  return { m30, h1, h4, d24, d7, sum };
}
function voteOne(x, thr) {
  if (!isFiniteNumber(x)) return 0;
  if (x >  +Math.abs(thr)) return +1;
  if (x <  -Math.abs(thr)) return -1;
  return 0;
}

function confidenceFrom(d, signal, votes) {
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

/* ---------------- Stickiness (Anti-flip) ---------------- */

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

  function snap(x) {
    return { signal: x.signal, score: (x.confidence_pct - 55) / 40, confidence_pct: x.confidence_pct, ts: now };
  }
}

/* ---------------- Upstash KV ---------------- */

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

/* ---------------- Utils ---------------- */

function toNum(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function round2(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function parseBool(x) {
  return String(x).toLowerCase() === "1" || String(x).toLowerCase() === "true";
}
function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}
