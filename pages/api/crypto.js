// FILE: pages/api/crypto.js

// Keširanje 10 minuta
const CACHE_TTL = 10 * 60 * 1000;
let cached = { combined: null, crypto: null, timestamp: 0 };

const TF_CONFIGS = [
  { aggregate: 15, limit: 96 },
  { aggregate: 30, limit: 48 },
  { aggregate: 60, limit: 24 },
  { aggregate: 240, limit: 6 },
];

async function fetchTopCoins() {
  const url =
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd&order=market_cap_desc&per_page=50&page=1';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko markets fetch failed: ${res.status}`);
  const data = await res.json();
  return data.map((c) => c.symbol.toUpperCase());
}

async function fetchOHLC(symbol, aggregate, limit) {
  const url =
    `https://min-api.cryptocompare.com/data/v2/histominute` +
    `?fsym=${symbol}&tsym=USD&limit=${limit}&aggregate=${aggregate}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.Response !== 'Success') {
    throw new Error(`CC histominute failed: ${json.Message || json.Response}`);
  }
  return json.Data.Data.map((d) => d.close);
}

export default async function handler(req, res) {
  const debug = { symbols: [], processed: 0, errors: [] };

  try {
    // koristimo keš ako je svež
    if (
      cached.combined &&
      Date.now() - cached.timestamp < CACHE_TTL
    ) {
      return res
        .status(200)
        .setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate')
        .json({ combined: cached.combined, crypto: cached.crypto, debug: { cached: true } });
    }

    // 1) fetch top simbola
    let symbols;
    try {
      symbols = await fetchTopCoins();
      debug.symbols = symbols;
    } catch (e) {
      debug.errors.push(`fetchTopCoins: ${e.message}`);
      symbols = [];
    }

    const signals = [];
    // 2) za svaki simbol
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          // 2a) skupljanje closes na svim TF
          const changes = await Promise.all(
            TF_CONFIGS.map(async (cfg) => {
              const closes = await fetchOHLC(sym, cfg.aggregate, cfg.limit);
              const last = closes.length - 1;
              return (closes[last] - closes[last - 1]) / closes[last - 1];
            })
          );
          // 2b) prosečna promena
          const avgChange =
            changes.reduce((sum, ch) => sum + ch, 0) / changes.length;
          const signal = avgChange >= 0 ? 'LONG' : 'SHORT';
          const confidence = Math.min(Math.abs(avgChange) * 150, 100).toFixed(2);
          signals.push({ symbol: sym, signal, confidence: Number(confidence) });
          debug.processed++;
        } catch (e) {
          debug.errors.push(`${sym}: ${e.message}`);
        }
      })
    );

    // 3) sortiranje i top slice
    signals.sort((a, b) => b.confidence - a.confidence);
    const top10 = signals.slice(0, 10);
    const top3 = top10.slice(0, 3);

    // 4) keširanje
    cached = { combined: top3, crypto: top10, timestamp: Date.now() };

    res
      .status(200)
      .setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate')
      .json({ combined: top3, crypto: top10, debug });
  } catch (err) {
    debug.errors.push(`handler: ${err.message}`);
    console.error('API /crypto error', err);
    res.status(500).json({ error: 'Internal error', debug });
  }
}
