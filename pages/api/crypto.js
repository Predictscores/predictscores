// pages/api/crypto.js

// Helpers for indicators
function calcDelta(data, minutesAgo) {
  if (data.length <= minutesAgo) return 0;
  const latest = data[data.length - 1].close;
  const past   = data[data.length - 1 - minutesAgo].close;
  return ((latest - past) / past) * 100;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((acc, v) => acc + v, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i].close - values[i - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (gains + losses === 0) return 50;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export default async function handler(req, res) {
  try {
    // 1) Fetch top 100 by market cap with current + 1h/24h %
    const listRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1' +
      '&price_change_percentage=1h%2C24h'
    );
    const list = await listRes.json();

    const results = await Promise.all(
      list.map(async c => {
        const symbol = c.symbol.toUpperCase();
        const entryPrice = c.current_price;
        const change1h = c.price_change_percentage_1h_in_currency || 0;
        const change24h = c.price_change_percentage_24h_in_currency || 0;

        // 2) Fetch last 240 minutes @1min bars
        const histRes = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histominute?` +
          `fsym=${symbol}&tsym=USD&limit=240&aggregate=1`
        );
        const histJson = await histRes.json();
        const bars = histJson.Data?.Data || [];

        // 3) Price deltas
        const delta15m = calcDelta(bars, 15);
        const delta30m = calcDelta(bars, 30);
        const delta60m = calcDelta(bars, 60);
        const delta240m= calcDelta(bars, 240);

        // 4) RSI on each TF
        const rsi15  = rsi(bars.slice(-Math.max(15, 14)));
        const rsi30  = rsi(bars.slice(-Math.max(30, 14)));
        const rsi60  = rsi(bars.slice(-Math.max(60, 14)));
        const rsi240 = rsi(bars);

        // 5) SMA crossover on each TF
        function crossover(pts, shortLen, longLen) {
          if (pts.length < longLen) return 0;
          const closes = pts.map(d => d.close);
          const s = sma(closes.slice(-shortLen), shortLen);
          const l = sma(closes.slice(-longLen),  longLen);
          return s > l ? 1 : -1;
        }
        const co15  = crossover(bars.slice(-15), 5, 10);
        const co30  = crossover(bars.slice(-30), 5, 20);
        const co60  = crossover(bars.slice(-60), 5, 20);
        const co240 = crossover(bars, 5, 20);

        // 6) Aggregate signals
        let score = 0, maxScore = 0;
        [[delta15m,15],[delta30m,30],[delta60m,60],[delta240m,240]].forEach(
          ([d,w]) => {
            const sign = d >= 0 ? 1 : -1;
            score += sign * Math.abs(d) * (w/240);
            maxScore += Math.abs(d)*(w/240);
          }
        );
        [[rsi15,15],[rsi30,30],[rsi60,60],[rsi240,240]].forEach(
          ([r]) => {
            const sign = r < 30 ? 1 : r > 70 ? -1 : 0;
            score += sign * 10; maxScore += 10;
          }
        );
        [co15,co30,co60,co240].forEach(sign => {
          score += sign * 15; maxScore += 15;
        });

        const signal = score >= 0 ? 'LONG' : 'SHORT';
        const confidence = Math.min(100, Math.max(0, (Math.abs(score)/maxScore)*100));

        // 7) ATR for SL/TP on 1h TF
        const hourly = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=24`
        ).then(r=>r.json()).then(j=>j.Data.Data);
        const trs = hourly.map((h,i,arr) => {
          if (i===0) return h.high - h.low;
          const pc = arr[i-1].close;
          return Math.max(h.high - h.low, Math.abs(h.high - pc), Math.abs(h.low - pc));
        });
        const atr = sma(trs.slice(-14), 14) || (hourly[0].high - hourly[0].low);
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
          price: entryPrice,
          signal,
          confidence: +confidence.toFixed(2),
          change1h,
          change24h,
          entryPrice,
          sl: +slPrice.toFixed(4),
          tp: +tpPrice.toFixed(4),
          expectedMove: +((Math.abs(tpPrice - entryPrice) / entryPrice) * 100).toFixed(2)
        };
      })
    );

    results.sort((a,b)=> b.confidence - a.confidence);
    const top10 = results.slice(0,10);
    const top3  = top10.slice(0,3);

    res.setHeader('Cache-Control','s-maxage=600,stale-while-revalidate');
    res.status(200).json({ combined: top3, crypto: top10 });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}
