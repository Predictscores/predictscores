// lib/sources/coingecko.js
// Fetch price data from CoinGecko with simple in-memory caching

let cache = {
  data: null,
  timestamp: 0
};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

/**
 * Fetches current prices for given CoinGecko IDs.
 * @param {string[]} ids - Array of CoinGecko IDs (e.g., ['bitcoin','ethereum']).
 * @returns {Promise<Object>} - Mapping of id to { usd: price }.
 */
export async function fetchCoinGeckoPrices(ids) {
  const now = Date.now();
  // Return cached data if still valid
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return cache.data;
  }

  // Build query string
  const idsParam = encodeURIComponent(ids.join(','));
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idsParam}&vs_currencies=usd`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CoinGecko fetch error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  // Update cache
  cache = { data: result, timestamp: now };
  return result;
}
