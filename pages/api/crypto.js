// FILE: pages/api/crypto.js

// ── Helper functions ──────────────────────────────────────────────────────────
function calcDelta(data, minutesAgo) {
  if (data.length <= minutesAgo) return 0;
  const latest = data[data.length - 1].close;
  const past   = data[data.length - 1 - minutesAgo].close;
  return ((latest - past) / past) * 100;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function rsi(data, period = 14) {
  if (data.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (gains + losses === 0) return 50;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    // 1) Fetch top 50 coins by market cap + 1h/24h changes
    const listRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&order=market_cap_desc&per_page=50&page=1' +
      '&price_change_percentage=1h%2C24h'
    );
    const list = await listRes.json();

    // 2) Compute signals for each coin
    const items = await Promise.all(
      list.map(async coin => {
        try {
          const symbol     = coin.symbol.toUpperCase();
          const entryPrice = coin.current_price;
          const change1h   = coin.price_change_percentage_1h_in_currency  || 0;
          const change24h  = coin.price_change_percentage_24h_in_currency || 0;

          // 3) Get 1-minute bars for last 240 minutes
          let histRes = await fetch(
            `https://min-api.cryptocompare.com/data/v2/histominute?` +
            `fsym=${symbol}&tsym=USD&limit=240&aggregate=1`
          );
          let histJson = await histRes.json();
          let bars     = histJson.Data?.Data || [];

          // fallback to CoinGecko OHLC if too few bars
          if (bars.length < 10) {
            const cgOhlc = await fetch(
              `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/ohlc` +
              `?vs_currency=usd&days=1`
            ).then(r => r.json());
            bars = cgOhlc.map(([t,o,h,l,c]) => ({
              time:  t/1000,
              open:  o,
              high:  h,
              low:   l,
              close: c
            }));
          }

          // 4) Price deltas
          const delta15  = calcDelta(bars, 15);
          const delta30  = calcDelta(bars, 30);
          const delta60  = calcDelta(bars, 60);
          const delta240 = calcDelta(bars, 240);

          // 5) RSI per TF
          const rsi15  = rsi(bars.slice(-Math.max(15,14)));
          const rsi30  = rsi(bars.slice(-Math.max(30,14)));
          const rsi60  = rsi(bars.slice(-Math.max(60,14)));
          const rsi240 = rsi(bars);

          // 6) SMA crossovers per TF
          function crossover(dataPts, shortLen, longLen) {
            if (dataPts.length < longLen) return 0;
            const closes    = dataPts.map(d => d.close);
            const shortSMA  = sma(closes.slice(-shortLen), shortLen) || 0;
            const longSMA   = sma(closes.slice(-longLen), longLen)   || 0;
            return shortSMA > longSMA ? 1 : -1;
          }
          const co15  = crossover(bars.slice(-15), 5, 10);
          const co30  = crossover(bars.slice(-30), 5, 20);
          const co60  = crossover(bars.slice(-60), 5, 20);
          const co240 = crossover(bars,          5, 20);

          // 7) Aggregate into score/confidence
          let score = 0, maxScore = 0;
          [[delta15,15],[delta30,30],[delta60,60],[delta240,240]].forEach(
            ([d,w]) => {
              const sign = d >= 0 ? 1 : -1;
              score    += sign * Math.abs(d) * (w/240);
              maxScore += Math.abs(d)  * (w/240);
            }
          );
          [[rsi15],[rsi30],[rsi60],[rsi240]].forEach(
            ([r]) => {
              const sign = r < 30 ? 1 : r > 70 ? -1 : 0;
              score    += sign * 10;
              maxScore += 10;
            }
          );
          [co15,co30,co60,co240].forEach(sign => {
            score    += sign * 15;
            maxScore += 15;
          });

          const signal     = score >= 0 ? 'LONG' : 'SHORT';
          const confidence = Math.min(100, Math.max(0, (Math.abs(score)/maxScore)*100));

          // 8) Fetch 1h bars for ATR
          let hourlyData = [];
          try {
            const hrRes  = await fetch(
              `https://min-api.cryptocompare.com/data/v2/histohour?` +
              `fsym=${symbol}&tsym=USD&limit=24`
            );
            const hrJson = await hrRes.json();
            hourlyData   = hrJson.Data?.Data || [];
          } catch {}

          // 9) Compute ATR(14)
          const trueRanges = hourlyData.map((h,i,arr) => {
            if (i === 0) return h.high - h.low;
            const pc = arr[i-1].close;
            return Math.max(
              h.high - h.low,
              Math.abs(h.high - pc),
              Math.abs(h.low  - pc)
            );
          });
          const atr = sma(trueRanges.slice(-14), 14)
                   ?? (hourlyData.length
                       ? hourlyData[0].high - hourlyData[0].low
                       : 0);

          // 10) SL/TP based on ATR
          let slPrice, tpPrice;
          if (signal === 'LONG') {
            slPrice = entryPrice - atr;
            tpPrice = entryPrice + atr * 2;
          } else {
            slPrice = entryPrice + atr;
            tpPrice = entryPrice - atr * 2;
          }

          return {
            symbol,
            price:        entryPrice,
            signal,
            confidence:   +confidence.toFixed(2),
            change1h,
            change24h,
            entryPrice,
            sl:           +slPrice.toFixed(4),
            tp:           +tpPrice.toFixed(4),
            expectedMove: +((Math.abs(tpPrice - entryPrice)/entryPrice)*100).toFixed(2)
          };
        } catch {
          return null;
        }
      })
    );

    // 11) Filter failures
    const results = items.filter(x => x);

    // 12) Split LONG/SHORT, sort, take top 10 each
    const longSignals  = results
      .filter(r => r.signal === 'LONG')
      .sort((a,b) => b.confidence - a.confidence)
      .slice(0,10);

    const shortSignals = results
      .filter(r => r.signal === 'SHORT')
      .sort((a,b) => b.confidence - a.confidence)
      .slice(0,10);

    // 13) Respond with 10-minute cache
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json({ long: longSignals, short: shortSignals });
  } catch (err) {
    console.error('API error', err);
    res.status(500).json({ error: 'Server error' });
  }
}
