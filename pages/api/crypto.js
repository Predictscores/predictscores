// FILE: pages/api/crypto.js

// Simple SMA helper
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

export default async function handler(req, res) {
  const symbols = [
    'BTC','ETH','BNB','SOL','XRP','ADA','DOGE','MATIC','DOT','AVAX',
    'UNI','LINK','LTC','ATOM','ALGO','TRX','VET','ICP','FIL','EOS',
    'AAVE','XTZ','SUSHI','MKR','SNX','ZEC','COMP','ENJ','KSM','OMG',
    'CHZ','AXS','GRT','MANA','THETA','FTT','NEO','DASH','ZIL','QTUM',
    'XLM','BAT','YFI','IBC','WAVES','KLAY','AR','IOST','REN','CELO'
  ];

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        // 1) Minute bars (15m aggregate)
        let rMin = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USD&limit=96&aggregate=15`
        );
        let jMin = await rMin.json();
        let bars = jMin.Data?.Data || [];
        if (bars.length < 10) {
          console.warn(`Few minute bars for ${symbol}, falling back to CG OHLC`);
          const cg = await fetch(
            `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/ohlc?vs_currency=usd&days=1`
          ).then((r) => r.json());
          bars = cg.map(([t, o, h, l, c]) => ({
            time: t / 1000,
            open: o,
            high: h,
            low: l,
            close: c,
          }));
        }

        // 2) Hourly data for ATR
        let hourlyData = [];
        try {
          const rHr = await fetch(
            `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=24`
          );
          const jHr = await rHr.json();
          hourlyData = jHr.Data?.Data || [];
        } catch (e) {
          console.warn(`CC histohour error for ${symbol}:`, e.message);
        }
        if (hourlyData.length < 5) {
          console.warn(`Few hourly bars for ${symbol}, falling back to CG OHLC`);
          const cgO = await fetch(
            `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/ohlc?vs_currency=usd&days=1`
          ).then((r) => r.json());
          hourlyData = cgO.map(([t, o, h, l, c]) => ({
            high: h,
            low: l,
            close: c,
          }));
        }

        // ATR calculation
        const trueRanges = hourlyData.map((h, i, arr) => {
          if (i === 0) return h.high - h.low;
          const prev = arr[i - 1].close;
          return Math.max(
            h.high - h.low,
            Math.abs(h.high - prev),
            Math.abs(h.low - prev)
          );
        });
        const atr = sma(trueRanges.slice(-14), 14) ?? 0;

        // Signal logic (delta over 24h)
        const latest = bars[bars.length - 1];
        const first = bars[0];
        const deltaPct = ((latest.close - first.open) / first.open) * 100;

        const signal = deltaPct > 0 ? 'LONG' : 'SHORT';
        const entryPrice = latest.close;
        const sl = signal === 'LONG'
          ? entryPrice - atr * 0.5
          : entryPrice + atr * 0.5;
        const tp = signal === 'LONG'
          ? entryPrice + atr * 1
          : entryPrice - atr * 1;
        const expectedMove = (Math.abs(tp - entryPrice) / entryPrice) * 100;

        return {
          symbol,
          price: entryPrice,
          signal,
          confidence: Math.min(Math.abs(deltaPct), 100),
          change1h: bars.length > 5
            ? ((latest.close - bars[bars.length - 5].open) / bars[bars.length - 5].open) * 100
            : 0,
          change24h: ((latest.close - first.open) / first.open) * 100,
          entryPrice,
          sl,
          tp,
          expectedMove,
        };
      } catch (err) {
        console.error('Crypto signal failed for', symbol, err.message);
        return null;
      }
    })
  );

  const filtered = results
    .filter((x) => x !== null)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  res.status(200).json({ crypto: filtered });
}
