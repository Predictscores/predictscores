// FILE: components/SignalCard.jsx

import React, { useEffect, useState } from 'react';

// Simple SMA helper
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

export default function SignalCard({ data }) {
  const {
    symbol = '',
    price = 0,
    signal = '',
    confidence = 0,
    change1h = 0,
    change24h = 0,
    entryPrice = 0,
    sl = 0,
    tp = 0,
    expectedMove = 0,
  } = data;

  const rr =
    entryPrice !== sl
      ? ((tp - entryPrice) / Math.abs(entryPrice - sl)).toFixed(2)
      : '-';

  const [chartUrl, setChartUrl] = useState('');
  const [loadingChart, setLoadingChart] = useState(true);

  useEffect(() => {
    async function buildChart() {
      try {
        const res = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USD&limit=96&aggregate=15`
        );
        const json = await res.json();
        let bars = json.Data?.Data || [];

        if (bars.length < 10) {
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

        const chartData = bars.map((d) => ({
          x: d.time * 1000,
          o: d.open,
          h: d.high,
          l: d.low,
          c: d.close,
        }));

        let hourlyData = [];
        try {
          const hr = await fetch(
            `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=24`
          ).then((r) => r.json());
          hourlyData = hr.Data?.Data || [];
        } catch {}

        if (hourlyData.length < 5) {
          const cgOhlc = await fetch(
            `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/ohlc?vs_currency=usd&days=1`
          ).then((r) => r.json());
          hourlyData = cgOhlc.map(([t, o, h, l, c]) => ({
            high: h,
            low: l,
            close: c,
          }));
        }

        const trueRanges = hourlyData.map((h, i, arr) => {
          if (i === 0) return h.high - h.low;
          const prev = arr[i - 1].close;
          return Math.max(
            h.high - h.low,
            Math.abs(h.high - prev),
            Math.abs(h.low - prev)
          );
        });
        const atr =
          sma(trueRanges.slice(-14), 14) ??
          (hourlyData.length ? hourlyData[0].high - hourlyData[0].low : 0);

        const config = {
          type: 'candlestick',
          data: {
            datasets: [
              {
                data: chartData,
                color: { up: '#4ade80', down: '#f87171', unchanged: '#888' },
              },
            ],
          },
          options: {
            plugins: {
              legend: { display: false },
              annotation: {
                annotations: {
                  tpLine: {
                    type: 'line',
                    yMin: tp,
                    yMax: tp,
                    borderColor: 'green',
                    borderWidth: 2,
                    borderDash: [4, 2],
                    label: {
                      content: 'TP',
                      enabled: true,
                      position: 'end',
                      backgroundColor: 'rgba(0,255,0,0.7)',
                      color: '#000',
                    },
                  },
                  slLine: {
                    type: 'line',
                    yMin: sl,
                    yMax: sl,
                    borderColor: 'red',
                    borderWidth: 2,
                    borderDash: [4, 2],
                    label: {
                      content: 'SL',
                      enabled: true,
                      position: 'end',
                      backgroundColor: 'rgba(255,0,0,0.7)',
                      color: '#000',
                    },
                  },
                },
              },
            },
            scales: { x: { type: 'time', time: { unit: 'hour' } }, y: { position: 'right' } },
            layout: { padding: 0 },
            elements: { point: { radius: 0 } },
            backgroundColor: '#ffffff',
          },
        };

        const encoded = encodeURIComponent(JSON.stringify(config));
        setChartUrl(`https://quickchart.io/chart?c=${encoded}&w=800&h=240&bkg=ffffff&version=3`);
      } catch {
        setChartUrl(null);
      } finally {
        setLoadingChart(false);
      }
    }
    buildChart();
  }, [symbol, tp, sl]);

  return (
    <div className="grid grid-cols-[40%_60%] h-40 bg-[#23272f] rounded-2xl shadow overflow-hidden">
      {/* TEKST (40%) */}
      <div className="p-3 flex flex-col justify-center overflow-hidden break-words">
        <h3 className="text-xl font-bold truncate">{symbol}</h3>
        <div className="text-lg truncate">Current: ${price.toFixed(4)}</div>
        <div className="text-base truncate">
          Entry: ${entryPrice.toFixed(4)}{' '}
          <span className={signal === 'LONG' ? 'text-green-400' : 'text-red-400'}>
            {signal === 'LONG' ? '⇧' : '⇩'}
          </span>
        </div>
        <div className="flex gap-2 flex-wrap mt-1">
          <span className="px-2 py-1 bg-green-600 rounded-full truncate">
            TP: ${tp.toFixed(4)}
          </span>
          <span className="px-2 py-1 bg-red-600 rounded-full truncate">
            SL: ${sl.toFixed(4)}
          </span>
        </div>
        <div className="text-sm mt-1 truncate">
          Expected: {expectedMove.toFixed(2)}%{' '}
          <span>{confidence > 75 ? '🟢' : confidence > 50 ? '🔵' : '🟡'}</span>
        </div>
        <div className="text-xs text-gray-400 mt-1 truncate">
          1h: {change1h.toFixed(2)}% • 24h: {change24h.toFixed(2)}%
        </div>
        <div className="text-sm mt-1 truncate">R:R: {rr}</div>
        <div className="text-xs text-gray-500 mt-1 truncate">
          TF: 15m,30m,1h,4h
        </div>
      </div>

      {/* GRAFIKON (60%) */}
      <div className="flex items-center justify-center bg-[#23272f] p-2 overflow-hidden">
        {loadingChart ? (
          <div className="w-full h-full animate-pulse bg-gray-700 rounded" />
        ) : chartUrl ? (
          <img
            src={chartUrl}
            alt={`${symbol} 24h chart`}
            className="w-full h-full object-contain rounded-lg"
          />
        ) : (
          <div className="text-gray-500 italic">No chart available</div>
        )}
      </div>
    </div>
  );
}
