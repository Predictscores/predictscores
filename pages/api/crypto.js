// FILE: pages/api/crypto.js

// Keširanje 10 minuta
const CACHE_TTL = 10 * 60 * 1000;
let cached = { combined: null, crypto: null, timestamp: 0 };

export default async function handler(req, res) {
  try {
    // 1) Keš check
    if (cached.combined && Date.now() - cached.timestamp < CACHE_TTL) {
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return res.status(200).json({ combined: cached.combined, crypto: cached.crypto });
    }

    // 2) Povuci prvih 100 coina sa CoinGecko, zajedno sa 1h i 24h % promenom
    const url =
      'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd' +
      '&order=market_cap_desc' +
      '&per_page=100&page=1' +
      '&price_change_percentage=1h%2C24h';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CG markets fetch failed: ${r.status}`);
    const list = await r.json();

    // 3) Mapiraj na naše signale
    const signals = list.map((c) => {
      const change1h  = c.price_change_percentage_1h_in_currency  ?? 0;
      const change24h = c.price_change_percentage_24h_in_currency ?? 0;
      const avgChange = (change1h + change24h) / 2;            // srednja promena
      const signal    = avgChange >= 0 ? 'LONG' : 'SHORT';
      const confidence= Math.min(Math.abs(avgChange), 100).toFixed(2); // direktno %
      return {
        symbol:     c.symbol.toUpperCase(),
        price:      c.current_price,
        signal,
        confidence: Number(confidence),
        change1h,
        change24h
      };
    });

    // 4) Sortiraj po confidence (jačini) i uzmi top10 + top3
    signals.sort((a, b) => b.confidence - a.confidence);
    const top10 = signals.slice(0, 10);
    const top3  = top10.slice(0, 3);

    // 5) Keširaj i vrati
    cached = { combined: top3, crypto: top10, timestamp: Date.now() };
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json({ combined: top3, crypto: top10 });
  } catch (err) {
    console.error('API /crypto error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
