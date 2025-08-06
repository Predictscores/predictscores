// lib/sources/cryptocompare.js
// Fetch price data from CryptoCompare with simple in-memory caching

let cache = {
  data: null,
  timestamp: 0
};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds
const API_KEY = process.env.CRYPTOCOMPARE_API_KEY || ''; // optional, can be empty

/**
 * Fetches current prices for given symbols.
 * @param {string[]} symbols - Array of symbols (e.g., ['BTC','ETH']).
 * @returns {Promise<Object>} - Mapping of symbol to { USD: price }.
 */
export async function fetchCryptoComparePrices(symbols) {
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return cache.data;
  }

  const fsyms = encodeURIComponent(symbols.join(','));
  const tsyms = 'USD';
  let url = `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${fsyms}&tsyms=${tsyms}`;
  if (API_KEY) {
    url += `&api_key=${API_KEY}`;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CryptoCompare fetch error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  cache = { data: result, timestamp: now };
  return result;
}
