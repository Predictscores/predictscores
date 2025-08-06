// lib/sources/coinpaprika.js
// Fetch price data from CoinPaprika with simple in-memory caching

let cache = {
  data: null,
  timestamp: 0
};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

/**
 * Fetches current prices for given CoinPaprika IDs.
 * @param {string[]} ids - Array of CoinPaprika IDs (e.g., ['btc-bitcoin','eth-ethereum']).
 * @returns {Promise<Object>} - Mapping of id to { price_usd: price }.
 */
export async function fetchCoinPaprikaPrices(ids) {
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return cache.data;
  }

  const promises = ids.map(async id => {
    const url = `https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(id)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`CoinPaprika fetch error for ${id}: ${res.status}`);
    }
    const json = await res.json();
    return { id, price_usd: json.quotes.USD.price };
  });

  const entries = await Promise.all(promises);
  const result = entries.reduce((acc, { id, price_usd }) => {
    acc[id] = { price_usd };
    return acc;
  }, {});

  cache = { data: result, timestamp: now };
  return result;
}
