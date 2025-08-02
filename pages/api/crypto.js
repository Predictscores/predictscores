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
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function deriveAggregateSignal(priceSeriesMinutes) {
  // priceSeriesMinutes: full minute-level price array [[ts, price], ...], newest last
  const now = Date.now();
  // build hourly series for last ~24h: pick closest to each hour mark
  const hourly = [];
  for (let h = 24; h >= 1; h--) {
    const target = now - h * 3600 * 1000;
    // find closest timestamp
    let closest = priceSeriesMinutes[0];
    let minDiff = Math.abs(priceSeriesMinutes[0][0] - target);
    for (const point of priceSeriesMinutes) {
      const diff = Math.abs(point[0] - target);
      if (diff < minDiff) {
        minDiff = diff;
        closest = point;
      }
    }
    hourly.push(closest[1]);
  }

  if (hourly.length < 5) return null; // nema dovoljno da se radi trend

  // RSI on hourly (period 14 requires 15 points; if less, fallback handled in computeRSI)
  const rsi = computeRSI(hourly, 14);

  // 4h momentum: find price ~4h ago and latest
  const target4h = now - 4 * 3600 * 1000;
  let price4hAgo = priceSeriesMinutes[0][1];
  let minDiff4h = Math.abs(priceSeriesMinutes[0][0] - target4h);
  for (const point of priceSeriesMinutes) {
    const diff = Math.abs(point[0] - target4h);
    if (diff < minDiff4h) {
      minDiff4h = diff;
      price4hAgo = point[1];
    }
  }
  const latestPrice = priceSeriesMinutes[priceSeriesMinutes.length - 1][1];
  const priceChange4h = pctChange(price4hAgo, latestPrice);

  // momentumScore scaled: očekujemo da ~10% move u 4h bude jak, skaliramo prema tome
  const momentumScore = clamp((Math.abs(priceChange4h) / 10) * 50, 0, 50);
  const rsiScore = clamp((Math.abs(rsi - 50) / 50) * 50, 0, 50);
  const confidence = clamp(momentumScore + rsiScore, 0, 100);

  let direction;
  if (priceChange4h > 0 && rsi > 50) direction = 'LONG';
  else if (priceChange4h < 0 && rsi < 50) direction = 'SHORT';
  else direction = priceChange4h >= 0 ? 'LONG' : 'SHORT';

  // volatility using hourly returns
  const returns = [];
  for (let i = 1; i < hourly.length; i++) {
    returns.push(pctChange(hourly[i - 1], hourly[i]));
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
    priceChangePercent: Number(priceChange4h.toFixed(2)),
    rsi: Number(rsi.toFixed(1)),
    volatility: Number(stdDev.toFixed(2)),
    expected_range: `${expectedMove.toFixed(2)}%`,
    stop_loss: `${stopLoss.toFixed(2)}%`,
    take_profit: `${takeProfit.toFixed(2)}%`,
    latest_price: Number(latestPrice.toFixed(6)),
    price_history_24h: priceSeriesMinutes
      .slice(-1440)
      .map(([, price]) => Number(price.toFixed(6)))
  };
}

async function fetchTopCoins() {
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=volume_desc&per_page=30&page=1&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('CoinGecko top coins failed');
  return res.json(); // array with id, symbol, name
}

async function fetchMarketChart(id, days = 1) {
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(
    id
  )}/market_chart?vs_currency=usd&days=${days}&interval=minute`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    const topCoins = await fetchTopCoins(); // get top 30 by volume

    const signals = [];

    await Promise.all(
      topCoins.map(async (coin) => {
        const chart = await fetchMarketChart(coin.id, 1);
        if (!chart || !chart.prices || chart.prices.length < 300) return; // insufficient data

        const agg = deriveAggregateSignal(chart.prices);
        if (!agg) return;

        signals.push({
          symbol: coin.symbol.toUpperCase(),
          name: coin.name,
          current_price: agg.latest_price,
          ...agg,
          last_updated: new Date().toISOString()
        });
      })
    );

    signals.sort((a, b) => b.confidence - a.confidence);
    const cryptoTop = signals.slice(0, 3); // top 3

    const payload = {
      cryptoTop,
      footballTop: [], // placeholder until football source is integrated
      generated_at: new Date().toISOString()
    };

    cache = {
      timestamp: now,
      data: payload
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('Crypto signal error:', err);
    return res
      .status(500)
      .json({ error: 'Failed to compute crypto signals', detail: err.message });
  }
}
