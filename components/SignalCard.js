// components/SignalCard.jsx
import React, { useEffect, useState } from 'react';

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
    expectedMove = 0
  } = data;

  const [chartUrl, setChartUrl] = useState('');

  useEffect(() => {
    async function buildChart() {
      try {
        // 24h history in 15-minute bars (96 bars)
        const res = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USD&limit=96&aggregate=15`
        );
        const json = await res.json();
        const raw = json.Data?.Data || [];
        const chartData = raw.map(d => ({
          x: d.time * 1000,
          o: d.open,
          h: d.high,
          l: d.low,
          c: d.close
        }));

        // Chart.js config with white background & TP/SL lines
        const config = {
          type: 'candlestick',
          data: {
            datasets: [{
              data: chartData,
              color: { up: '#4ade80', down: '#f87171', unchanged: '#888' }
            }]
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
                      color: '#000'
                    }
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
                      color: '#000'
                    }
                  }
                }
              }
            },
            scales: {
              x: { type: 'time', time: { unit: 'hour' } },
              y: { position: 'right' }
            },
            layout: { padding: 0 },
            elements: { point: { radius: 0 } }
          }
        };

        const encoded = encodeURIComponent(JSON.stringify(config));
        // bkg=ffffff for white chart background
        setChartUrl(
          `https://quickchart.io/chart?c=${encoded}&w=800&h=240&bkg=ffffff&version=3`
        );
      } catch {
        setChartUrl(null);
      }
    }
    buildChart();
  }, [symbol, tp, sl]);

  return (
    <div className="flex h-40 bg-[#23272f] rounded-2xl shadow overflow-hidden">
      {/* INFO (≈35%) */}
      <div className="w-1/3 p-3 flex flex-col justify-center space-y-1 break-words">
        <h3 className="text-xl font-bold">{symbol}</h3>
        <div className="text-sm">Current: ${price.toFixed(4)}</div>
        <div className="text-sm">
          Entry: ${entryPrice.toFixed(4)}{' '}
          <span className={signal === 'LONG' ? 'text-green-400' : 'text-red-400'}>
            {signal === 'LONG' ? '⇧' : '⇩'}
          </span>
        </div>
        <div className="text-sm">TP: ${tp} / SL: ${sl}</div>
        <div className="text-sm">
          Expected: {expectedMove.toFixed(2)}%
          <span className="ml-2">
            {confidence > 75 ? '🟢' : confidence > 50 ? '🔵' : '🟡'}
          </span>
        </div>
        <div className="text-xs text-gray-400">
          1h: {change1h.toFixed(2)}% • 24h: {change24h.toFixed(2)}%
        </div>
      </div>

      {/* EXTRA DETAILS (≈15%) */}
      <div className="w-1/6 p-3 border-l border-gray-700 flex flex-col justify-center items-center bg-[#1f2339]">
        <div className="text-sm">Signal TF: 15m</div>
        <div className="text-sm">R:R: {(tp - entryPrice) / (entryPrice - sl) || '-':.2f}</div>
      </div>

      {/* 24h Chart (≈50%) */}
      <div className="w-1/2 flex items-center justify-center bg-[#23272f]">
        {chartUrl === null ? (
          <div className="text-gray-500">No chart available</div>
        ) : chartUrl ? (
          <img
            src={chartUrl}
            alt={`${symbol} 24h candlestick`}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="text-gray-500">Loading chart…</div>
        )}
      </div>
    </div>
  );
}
