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
    expectedMove = 0,
    patterns = []
  } = data;

  const [chartUrl, setChartUrl] = useState('');

  useEffect(() => {
    async function buildChart() {
      // 24h istorija @1h = 24 sveće
      const res = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=23`
      );
      const json = await res.json();
      const chartData = json.Data.Data.map(d => ({
        x: d.time * 1000,
        o: d.open,
        h: d.high,
        l: d.low,
        c: d.close,
      }));

      const config = {
        type: 'candlestick',
        data: {
          datasets: [{
            data: chartData,
            color: { up: '#4ade80', down: '#f87171', unchanged: '#888' }
          }]
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { type: 'time', time: { unit: 'hour' } },
            y: { position: 'right' }
          },
          layout: { padding: 0 },
          elements: { point: { radius: 0 } }
        }
      };

      const encoded = encodeURIComponent(JSON.stringify(config));
      setChartUrl(`https://quickchart.io/chart?c=${encoded}&w=320&h=180&bkg=23272f&version=3`);
    }

    buildChart();
  }, [symbol]);

  return (
    <div className="bg-[#23272f] rounded-2xl shadow flex h-40 overflow-hidden">
      {/* INFO (35%) */}
      <div className="w-1/3 p-3 flex flex-col justify-center space-y-1">
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
        {patterns.length > 0 && (
          <div className="text-xs text-gray-400">
            Patterns: {patterns.join(', ')}
          </div>
        )}
      </div>

      {/* CHART (65%) */}
      <div className="w-2/3 flex items-center justify-center bg-[#1f2339]">
        {chartUrl ? (
          <img
            src={chartUrl}
            alt={`${symbol} 24h candlestick`}
            className="h-full object-contain"
          />
        ) : (
          <div className="text-gray-500">Loading chart…</div>
        )}
      </div>
    </div>
  );
}
