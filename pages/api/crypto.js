// FILE: pages/api/crypto.js

// Keširanje 10 minuta
const CACHE_TTL = 10 * 60 * 1000;
let cached = { combined: null, crypto: null, timestamp: 0 };

// TF konfiguracije: aggregate (minuta) i broj štapića
const TF_CONFIGS = [
  { aggregate: 15, limit: 96 },  // 24h @15m
  { aggregate: 30, limit: 48 },  // 24h @30m
  { aggregate: 60, limit: 24 },  // 24h @1h
  { aggregate: 240, limit: 6 },  // 24h @4h
];

// 1) Uzmi top 50 simbola po MC sa CoinGecko
async function fetchTopCoins() {
  const url =
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd&order=market_cap_desc&per_page=50&page=1';
  const res = await fetch(url);
  if (!res.ok) throw new Error('CoinGecko markets fetch failed');
  const data = await res.json();
  // vraćamo samo simbole (BTC, ETH, ...)
  return data.map((c) => c.symbol.toUpperCase());
}

// 2) Za dati symbol, TF i limit vrati niz closing cena
async function fetchOHLC(symbol, aggregate, limit) {
  const url =
    `https://min-api.cryptocompare.com/data/v2/histominute` +
    `?fsym=${symbol}&tsym=USD&limit=${limit}&aggregate=${aggregate}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.Response !== 'Success')
    throw new Error(`OHLC fetch failed for ${symbol}`);
  // iz json.Data.Data uzmem samo polje .close
  return json.Data.Data.map((d) => d.close);
}

// Glavni handler
export default async function handler(req, res) {
  try {
    // Ako je keš svež, samo ga vrati
    if (
      cached.combined &&
      Date.now() - cached.timestamp < CACHE_TTL
    ) {
      res.setHeader(
        'Cache-Control',
        's-maxage=600, stale-while-revalidate'
      );
      return res
        .status(200)
        .json({ combined: cached.combined, crypto: cached.crypto });
    }

    // 1) Pribavi simbole
    const symbols = await fetchTopCoins(); // npr. ['BTC','ETH',...]

    const signals = [];

    // 2) Za svaki simbol izračunaj prosečnu promenu po TF
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          // Skupi sve TF promene
          const changes = await Promise.all(
            TF_CONFIGS.map(async (cfg) => {
              const closes = await fetchOHLC(
                sym,
                cfg.aggregate,
                cfg.limit
              );
              const last = closes.length - 1;
              return (closes[last] - closes[last - 1]) /
                closes[last - 1];
            })
          );

          // Prosečna promena preko svih TF
          const avgChange =
            changes.reduce((sum, ch) => sum + ch, 0) /
            changes.length;

          // LONG ili SHORT po znaku avgChange
          const signal = avgChange >= 0 ? 'LONG' : 'SHORT';
          // škaluješ confidence na 0–100 (ovde *150 da dobije lep raspon,
          // ali slobodno prilagodiš)
          const confidence = Math.min(
            Math.abs(avgChange) * 100 * 1.5,
            100
          ).toFixed(2);

          signals.push({
            symbol: sym,
            signal,
            confidence: Number(confidence),
          });
        } catch (e) {
          console.error('Signal error for', sym, e);
        }
      })
    );

    // 3) Sortiraj po confidence desc i uzmi top10 & top3
    signals.sort((a, b) => b.confidence - a.confidence);
    const top10 = signals.slice(0, 10);
    const top3 = top10.slice(0, 3);

    // 4) Keširaj i vrati
    cached = {
      combined: top3,
      crypto: top10,
      timestamp: Date.now(),
    };
    res.setHeader(
      'Cache-Control',
      's-maxage=600, stale-while-revalidate'
    );
    res.status(200).json({ combined: top3, crypto: top10 });
  } catch (err) {
    console.error('API /crypto error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
