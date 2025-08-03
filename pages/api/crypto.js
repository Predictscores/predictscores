// pages/api/crypto.js

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
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

async function fetchTopCoins() {
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=volume_desc&per_page=30&page=1&sparkline=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko top coins failed ${res.status}`);
    return res.json();
  } catch (e) {
    console.warn('fetchTopCoins error', e.message);
    return [];
  }
}

async function fetchMarketChart(id, days = 1) {
  try {
    const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(
      id
    )}/market_chart?vs_currency=usd&days=${days}&interval=minute`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('fetchMarketChart not ok', id, res.status);
      return null;
    }
    return res.json();
  } catch (e) {
    console.warn('fetchMarketChart error', id, e.message);
    return null;
  }
}

function deriveSignal(priceSeries, timeframeMin) {
  if (!priceSeries || priceSeries.length === 0) return null;
  const now = Date.now();
  // Extract price array
  const prices = priceSeries.map(([, p]) => p);
  // Get price timeframeMin minutes ago
  const targetAgo = now - timeframeMin * 60 * 1000;
  let priceAgo = priceSeries[0][1];
  let minDiff = Math.abs(priceSeries[0][0] - targetAgo);
  for (const [ts, price] of priceSeries) {
    const diff = Math.abs(ts - targetAgo);
    if (diff < minDiff) {
      minDiff = diff;
      priceAgo = price;
    }
  }
  const latestPrice = priceSeries[priceSeries.length - 1][1];
  const priceChange = pctChange(priceAgo, latestPrice); // in %

  // Momentum score (scaled)
  const momentumScore = clamp((Math.abs(priceChange) / 10) * 50, 0, 50);

  // RSI over last N = min(prices.length, timeframeMin * 2) to give some window
  const windowSize = Math.min(prices.length, Math.max(5, timeframeMin));
  const recent = prices.slice(-windowSize - 1);
  const rsi = computeRSI(recent, Math.min(14, windowSize));
  const rsiScore = clamp((Math.abs(rsi - 50) / 50) * 50, 0, 50);

  const confidence = clamp(momentumScore + rsiScore, 0, 100);
  let direction;
  if (priceChange > 0 && rsi > 50) direction = 'LONG';
  else if (priceChange < 0 && rsi < 50) direction = 'SHORT';
  else direction = priceChange >= 0 ? 'LONG' : 'SHORT';

  // Volatility: std dev of returns over last few points
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(pctChange(prices[i - 1], prices[i]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length || 1);
  const stdDev = Math.sqrt(variance);

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
  const best = {};
  Object.entries(signalsByTf).forEach(([tf, arr]) => {
    arr.forEach((it) => {
      const key = it.symbol;
      if (!best[key] || it.confidence > best[key].confidence) {
        best[key] = { ...it, timeframe: tf };
      }
    });
  });
  return Object.values(best)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
}

const STUB = [
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    direction: 'LONG',
    confidence: 90,
    priceChangePercent: 1.2,
    rsi: 55,
    volatility: 0.8,
    expected_range: '0.80%',
    stop_loss: '-1.20%',
    take_profit: '1.60%',
    current_price: 50000,
    price_history_24h: Array(1440).fill(50000).map((v, i) => v + Math.sin(i / 50)),
    timeframe: '4h',
  },
  {
    symbol: 'ETH',
    name: 'Ethereum',
    direction: 'SHORT',
    confidence: 85,
    priceChangePercent: -0.9,
    rsi: 42,
    volatility: 1.1,
    expected_range: '1.10%',
    stop_loss: '1.65%',
    take_profit: '-2.20%',
    current_price: 3200,
    price_history_24h: Array(1440).fill(3200).map((v, i) => v + Math.cos(i / 40)),
    timeframe: '4h',
  },
];

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    // Fetch coins
    const topCoins = await fetchTopCoins(); // CoinGecko
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

    await Promise.all(
      topCoins.map(async (coin) => {
        try {
          const chart = await fetchMarketChart(coin.id);
          if (!chart || !chart.prices || chart.prices.length < 100) return;

          // For each timeframe derive signal
          Object.entries(timeframeDefs).forEach(([label, mins]) => {
            const sig = deriveSignal(chart.prices, mins);
            if (!sig) return;
            const item = {
              symbol: coin.symbol.toUpperCase(),
              name: coin.name,
              current_price: Number(sig.latest_price?.toFixed ? sig.latest_price.toFixed(6) : sig.latest_price),
              ...sig,
              price_history_24h: chart.prices
                .slice(-1440)
                .map(([, p]) => Number(p.toFixed ? p.toFixed(6) : p)),
            };
            byTimeframe[label].push(item);
          });
        } catch (e) {
          console.warn('per coin error', coin.id, e.message);
        }
      })
    );

    // sort & trim
    Object.keys(byTimeframe).forEach((tf) => {
      byTimeframe[tf].sort((a, b) => b.confidence - a.confidence);
      byTimeframe[tf] = byTimeframe[tf].slice(0, 10);
    });

    // combined top (best per coin)
    const combined = mergeBestPerCoin(byTimeframe);

    // For backward compatibility with UI expecting cryptoTop:
    const cryptoTop = combined;

    const payload = {
      byTimeframe,
      combined,
      cryptoTop,
      generated_at: new Date().toISOString(),
    };

    cache = {
      timestamp: now,
      data: payload,
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('Crypto signal error:', err);
    // fallback stub
    const fallback = {
      byTimeframe: { '15m': [], '30m': [], '1h': [], '4h': [] },
      combined: STUB,
      cryptoTop: STUB,
      generated_at: new Date().toISOString(),
      error: 'fallback due to internal error',
    };
    return res.status(200).json(fallback);
  }
}
