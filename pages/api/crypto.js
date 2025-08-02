// pages/api/crypto.js
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const COINPAPRIKA_SEARCH = 'https://api.coinpaprika.com/v1/search';
const COINPAPRIKA_TICKER = 'https://api.coinpaprika.com/v1/tickers';
const CRYPTOCOMPARE_HISTO = 'https://min-api.cryptocompare.com/data/v2/histominute'; // no key fallback
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minuta

let cache = {
  timestamp: 0,
  data: null,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pctChange(oldP, newP) {
  if (oldP === 0) return 0;
  return ((newP - oldP) / oldP) * 100;
}

// RSI calculation
function computeRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Fetch top coins from CoinGecko (by volume)
async function fetchTopCoins() {
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=volume_desc&per_page=30&page=1&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('CoinGecko top coins failed');
  return res.json(); // returns array with id, symbol, name
}

// Fetch market chart from CoinGecko (minute resolution for 1 day)
async function fetchGeckoHistory(id) {
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(
    id
  )}/market_chart?vs_currency=usd&days=1&interval=minute`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json(); // has .prices = [[ts, price], ...]
}

// Fetch minute history from CryptoCompare (limit 1440 = last 24h)
async function fetchCryptoCompareHistory(symbol) {
  // symbol like BTC, ETH
  const params = new URLSearchParams({
    fsym: symbol.toUpperCase(),
    tsyms: 'USD',
    limit: '1440',
    aggregate: '1',
  });
  const url = `${CRYPTOCOMPARE_HISTO}?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.Data?.Data) {
      // convert to [timestamp_ms, price]
      const arr = json.Data.Data.map((pt) => [pt.time * 1000, pt.close]);
      return { prices: arr };
    }
    return null;
  } catch {
    return null;
  }
}

// Search CoinPaprika for currency by symbol, then get its ticker
async function fetchPaprikaTicker(symbol) {
  try {
    // search currencies
    const searchParams = new URLSearchParams({
      q: symbol,
      c: 'currencies',
      limit: '5',
    });
    const searchRes = await fetch(`${COINPAPRIKA_SEARCH}?${searchParams.toString()}`);
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const currencies = searchJson.currencies || [];
    if (currencies.length === 0) return null;
    // pick first exact symbol match or first
    let match = currencies.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase());
    if (!match) match = currencies[0];
    const tickerRes = await fetch(`${COINPAPRIKA_TICKER}/${encodeURIComponent(match.id)}`);
    if (!tickerRes.ok) return null;
    const tickerJson = await tickerRes.json();
    // price in USD
    const price = tickerJson?.quotes?.USD?.price;
    const lastUpdated = new Date(tickerJson?.last_updated || Date.now()).getTime();
    if (price === undefined) return null;
    return { price, timestamp: lastUpdated };
  } catch {
    return null;
  }
}

// Build aggregated signal for a given price series (minute-level), using timeframe in minutes
function deriveSignalForTimeframe(priceSeriesMinutes, timeframeMin) {
  // priceSeriesMinutes expected sorted oldest->newest, elements: [ts_ms, price]
  if (!priceSeriesMinutes || priceSeriesMinutes.length === 0) return null;
  const now = Date.now();
  // extract prices only
  const pricesOnly = priceSeriesMinutes.map(([, p]) => p);
  // find price 'timeframeMin' minutes ago
  const targetAgo = now - timeframeMin * 60 * 1000;
  let priceAgo = priceSeriesMinutes[0][1];
  let minDiff = Math.abs(priceSeriesMinutes[0][0] - targetAgo);
  for (const point of priceSeriesMinutes) {
    const diff = Math.abs(point[0] - targetAgo);
    if (diff < minDiff) {
      minDiff = diff;
      priceAgo = point[1];
    }
  }
  const latestPrice = priceSeriesMinutes[priceSeriesMinutes.length - 1][1];
  const priceChange = pctChange(priceAgo, latestPrice); // in %

  // momentumScore: scaled so that ~10% move gives strong signal
  const momentumScore = clamp((Math.abs(priceChange) / 10) * 50, 0, 50);

  // RSI computed on the last (timeframe window) prices: take last N points where N = timeframeMin (approx minutes)
  const windowSize = Math.min(pricesOnly.length, Math.max(5, timeframeMin)); // ensure some minimum
  const recentSlice = pricesOnly.slice(-windowSize - 1); // to compute RSI with period <= windowSize
  const rsi = computeRSI(recentSlice, Math.min(14, windowSize));
  const rsiScore = clamp((Math.abs(rsi - 50) / 50) * 50, 0, 50);

  // Confidence combined
  const confidence = clamp(momentumScore + rsiScore, 0, 100);

  // Direction logic
  let direction;
  if (priceChange > 0 && rsi > 50) direction = 'LONG';
  else if (priceChange < 0 && rsi < 50) direction = 'SHORT';
  else direction = priceChange >= 0 ? 'LONG' : 'SHORT';

  // Volatility: compute stdDev of returns over last 4*timeframeMin minutes (or available)
  const volWindow = Math.min(pricesOnly.length, timeframeMin * 4);
  const volSlice = pricesOnly.slice(-volWindow);
  const returns = [];
  for (let i = 1; i < volSlice.length; i++) {
    returns.push(pctChange(volSlice[i - 1], volSlice[i]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length || 1);
  const stdDev = Math.sqrt(variance); // in percent

  const expectedMove = stdDev;
  let stopLoss, takeProfit;
  if (direction === 'LONG') {
    stopLoss = -1 * stdDev * 1.5;
    takeProfit = stdDev * 2;
  } else {
    stopLoss = stdDev * 1.5;
    takeProfit = -1 * stdDev * 2;
  }

  return {
    direction,
    confidence: Number(confidence.toFixed(1)),
    priceChangePercent: Number(priceChange.toFixed(2)),
    rsi: Number(rsi.toFixed(1)),
    volatility: Number(stdDev.toFixed(2)),
    expected_range: `${expectedMove.toFixed(2)}%`,
    stop_loss: `${stopLoss.toFixed(2)}%`,
    take_profit: `${takeProfit.toFixed(2)}%`,
    latest_price: Number(latestPrice.toFixed(6)),
  };
}

function mergeBestPerCoin(signalsByTf) {
  // signalsByTf: { '15m': [...], ... } each array contains items with symbol + confidence
  const bestMap = {};
  Object.entries(signalsByTf).forEach(([tf, arr]) => {
    arr.forEach((it) => {
      const key = it.symbol;
      if (!bestMap[key] || it.confidence > bestMap[key].confidence) {
        bestMap[key] = { ...it, timeframe: tf };
      }
    });
  });
  // return top 10 by confidence
  const combined = Object.values(bestMap)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
  return combined;
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    // Step 1: get top coins
    const topCoins = await fetchTopCoins(); // from CoinGecko
    const timeframeDefs = {
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '4h': 240,
    };
    const byTimeframe = {
      '15m': [],
      '30m': [],
      '1h': [],
      '4h': [],
    };

    // process each coin in parallel but with limit (simple)
    await Promise.all(
      topCoins.map(async (coin) => {
        try {
          // fetch multiple histories
          const [geckoHist, ccHist] = await Promise.all([
            fetchGeckoHistory(coin.id),
            fetchCryptoCompareHistory(coin.symbol),
          ]);

          // choose freshest history (based on latest timestamp)
          let chosenHist = null;
          if (geckoHist?.prices && geckoHist.prices.length) {
            chosenHist = { source: 'gecko', prices: geckoHist.prices };
          }
          if (ccHist?.prices && ccHist.prices.length) {
            // compare newest timestamp
            const geckoTs = chosenHist ? chosenHist.prices.slice(-1)[0][0] : 0;
            const ccTs = ccHist.prices.slice(-1)[0][0];
            if (!chosenHist || ccTs >= geckoTs) {
              chosenHist = { source: 'cc', prices: ccHist.prices };
            }
          }

          if (!chosenHist || !chosenHist.prices || chosenHist.prices.length < 60) return; // insufficient

          // Get best current price among sources (including CoinPaprika)
          const priceCandidates = [];
          // from chosen history latest
          const latestFromHistory = chosenHist.prices[chosenHist.prices.length - 1];
          if (latestFromHistory) {
            priceCandidates.push({
              price: latestFromHistory[1],
              timestamp: latestFromHistory[0],
              source: chosenHist.source,
            });
          }

          // CoinGecko current price (redundant but safe)
          if (coin.current_price !== undefined) {
            priceCandidates.push({
              price: coin.current_price,
              timestamp: Date.now(),
              source: 'gecko-spot',
            });
          }

          // CoinPaprika
          const paprika = await fetchPaprikaTicker(coin.symbol);
          if (paprika && paprika.price !== undefined) {
            priceCandidates.push({
              price: paprika.price,
              timestamp: paprika.timestamp,
              source: 'paprika',
            });
          }

          // choose most recent candidate
          priceCandidates.sort((a, b) => b.timestamp - a.timestamp);
          const chosenPriceObj = priceCandidates[0];
          const currentPrice = chosenPriceObj?.price ?? latestFromHistory[1];

          // for each timeframe compute signal
          Object.entries(timeframeDefs).forEach(([label, mins]) => {
            const sig = deriveSignalForTimeframe(chosenHist.prices, mins);
            if (!sig) return;
            // require some minimum data confidence (we display all anyway)
            const item = {
              symbol: coin.symbol.toUpperCase(),
              name: coin.name,
              current_price: Number(currentPrice.toFixed(6)),
              timeframe: label,
              ...sig,
              price_history_24h: chosenHist.prices
                .slice(-1440)
                .map(([, p]) => Number(p.toFixed(6))),
              source_history: chosenHist.source,
              last_updated: new Date().toISOString(),
            };
            byTimeframe[label].push(item);
          });
        } catch (e) {
          // ignore individual coin errors
          console.warn('coin processing error', coin.symbol, e.message);
        }
      })
    );

    // sort each timeframe by confidence desc and take top 10
    Object.keys(byTimeframe).forEach((tf) => {
      byTimeframe[tf].sort((a, b) => b.confidence - a.confidence);
      byTimeframe[tf] = byTimeframe[tf].slice(0, 10);
    });

    // combined top 10 best per coin across timeframes
    const combined = mergeBestPerCoin(byTimeframe);

    const payload = {
      byTimeframe,
      combined,
      generated_at: new Date().toISOString(),
    };

    cache = {
      timestamp: now,
      data: payload,
    };
    return res.status(200).json(payload);
  } catch (err) {
    console.error('Crypto signal error:', err);
    return res.status(500).json({
      error: 'Failed to compute crypto signals',
      detail: err.message,
    });
  }
}
