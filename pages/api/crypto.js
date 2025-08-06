// pages/api/crypto.js
// Keširanje 10 minuta
const CACHE_TTL = 10 * 60 * 1000;
let cache = { combined: null, crypto: null, ts: 0 };

export default async function handler(req, res) {
  try {
    if (Date.now() - cache.ts < CACHE_TTL) {
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return res.status(200).json({ combined: cache.combined, crypto: cache.crypto });
    }

    // Povlačimo top 100 coina + % promene
    const url =
      'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1' +
      '&price_change_percentage=1h%2C24h';
    const r = await fetch(url);
    const list = await r.json();

    // Mapiramo u signale
    const signals = list.map(c => {
      const change1h  = c.price_change_percentage_1h_in_currency  ?? 0;
      const change24h = c.price_change_percentage_24h_in_currency ?? 0;
      const avgChange = (change1h + change24h) / 2;
      const signal    = avgChange >= 0 ? 'LONG' : 'SHORT';
      const confidence= Math.min(Math.abs(avgChange), 100);

      const entryPrice = c.current_price;
      let sl, tp, expectedMove;
      if (signal === 'LONG') {
        sl = entryPrice * (1 - 0.02);
        tp = entryPrice * (1 + 0.04);
        expectedMove = ((tp - entryPrice) / entryPrice) * 100;
      } else {
        sl = entryPrice * (1 + 0.02);
        tp = entryPrice * (1 - 0.04);
        expectedMove = ((entryPrice - tp) / entryPrice) * 100;
      }

      return {
        symbol:       c.symbol.toUpperCase(),
        price:        entryPrice,
        signal,
        confidence:   +confidence.toFixed(2),
        change1h,
        change24h,
        entryPrice,
        sl:           +sl.toFixed(4),
        tp:           +tp.toFixed(4),
        expectedMove: +expectedMove.toFixed(2),
        patterns:     []  // naknadno dodati pattern detection
      };
    });

    // Sortiraj i slice
    signals.sort((a, b) => b.confidence - a.confidence);
    const top10 = signals.slice(0, 10);
    const top3  = top10.slice(0, 3);

    cache = { combined: top3, crypto: top10, ts: Date.now() };
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json({ combined: top3, crypto: top10 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
