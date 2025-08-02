// pages/api/crypto.js
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minuta
let cache = {
  timestamp: 0,
  data: null
};

function pctChange(oldP, newP) {
  if (oldP === 0) return 0;
  return ((newP - oldP) / oldP) * 100;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function deriveSignalAndConfidence(priceSeries) {
  const len = priceSeries.length;
  if (len < 2) return null;

  const latest = priceSeries[len - 1];
  const previous = priceSeries[0];
  const priceChangePercent = pctChange(previous, latest);

  const rsi = computeRSI(priceSeries);
  const momentumScore = clamp((Math.abs(priceChangePercent) / 5) * 50, 0, 50);
  const rsiScore = clamp((Math.abs(rsi - 50) / 50) * 50, 0, 50);
  const confidence = clamp(momentumScore + rsiScore, 0, 100);

  let direction;
  if (priceChangePercent > 0 && rsi > 50) direction = 'LONG';
  else if (priceChangePercent < 0 && rsi < 50) direction = 'SHORT';
  else direction = priceChangePercent >= 0 ? 'LONG' : 'SHORT';

  const returns = [];
  for (let i = 1; i < len; i++) {
    returns.push(pctChange(priceSeries[i - 1], priceSeries[i]));
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
    priceChangePercent: Number(priceChangePercent.toFixed(2)),
    rsi: Number(rsi.toFixed(1)),
    volatility: Number(stdDev.toFixed(2)),
    expected_range: `${expectedMove.toFixed(2)}%`,
    stop_loss: `${stopLoss.toFixed(2)}%`,
    take_profit: `${takeProfit.toFixed(2)}%`
  };
}

async function fetchTopCoins() {
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=volume_desc&per_page=30&page=1&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('CoinGecko top coins failed');
  return res.json();
}

async function fetchMarketChart(id, days = 1) {
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(
    id
  )}/market_chart?vs_currency=usd&days=${days}&interval=minute`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function sliceForTimeframe(minuteSeries, minutes) {
  const needed = minutes;
  const sliced = minuteSeries.slice(-needed).map(([, price]) => price);
  return sliced;
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    const topCoins = await fetchTopCoins();

    const promises = topCoins.map(async (coin) => {
      const chart = await fetchMarketChart(coin.id, 1);
      if (!chart || !chart.prices || chart.prices.length < 60) return null;
      const priceSeriesAll = chart.prices; // [ [ts, price], ... ]

      const frameDefs = {
        '15m': 15,
        '30m': 30,
        '1h': 60,
        '4h': 240
      };

      const perFrame = {};

      for (const [label, minutes] of Object.entries(frameDefs)) {
        const series = sliceForTimeframe(priceSeriesAll, minutes);
        const signal = deriveSignalAndConfidence(series);
        if (!signal) continue;
        perFrame[label] = {
          ...signal,
          timeframe: label,
          current_price: coin.current_price,
          symbol: coin.symbol.toUpperCase(),
          name: coin.name,
          last_updated: coin.last_updated || new Date().toISOString(),
          price_history_24h: priceSeriesAll
            .slice(-1440)
            .map(([, price]) => Number(price.toFixed(6)))
        };
      }

      return perFrame;
    });

    const raw = await Promise.all(promises);
    const filtered = raw.filter((x) => x);

    const byTimeframe = {
      '15m': [],
      '30m': [],
      '1h': [],
      '4h': []
    };

    filtered.forEach((coinFrames) => {
      for (const tf of Object.keys(byTimeframe)) {
        if (coinFrames[tf]) {
          byTimeframe[tf].push(coinFrames[tf]);
        }
      }
    });

    for (const tf of Object.keys(byTimeframe)) {
      byTimeframe[tf].sort((a, b) => b.confidence - a.confidence);
      byTimeframe[tf] = byTimeframe[tf].slice(0, 10);
    }

    const combinedMap = {};
    filtered.forEach((coinFrames) => {
      for (const tf of Object.keys(coinFrames)) {
        const item = coinFrames[tf];
        const key = item.symbol;
        if (!combinedMap[key] || item.confidence > combinedMap[key].confidence) {
          combinedMap[key] = item;
        }
      }
    });

    let combined = Object.values(combinedMap);
    combined.sort((a, b) => b.confidence - a.confidence);
    combined = combined.slice(0, 10);

    const payload = {
      byTimeframe,
      combined,
      generated_at: new Date().toISOString()
    };

    cache = {
      timestamp: now,
      data: payload
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('Error in /api/crypto:', err);
    return res
      .status(500)
      .json({ error: 'Failed to compute crypto signals', detail: err.message });
  }
}
