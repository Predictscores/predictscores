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
  } = data;

  const [chartUrl, setChartUrl] = useState('');

  useEffect(() => {
    async function buildChart() {
      // 1) Uzmi 2h istoriju @30m → 4 sveće
      const res = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USD&limit=4&aggregate=30`
      );
      const json = await res.json();
      const chartData = json.Data.Data.map(d => ({
        x: d.time * 1000,
        o: d.open,
        h: d.high,
        l: d.low,
        c: d.close,
      }));

      // 2) Konfig za QuickChart
      const config = {
        type: 'candlestick',
        data: { datasets: [{ data: chartData, color: { up: '#4ade80', down: '#f87171' } }] },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { type: 'time', time: { unit: 'hour' } },
            y: { position: 'right' }
          },
          elements: { point: { radius: 0 } },
          layout: { padding: 0 }
        }
      };

      const encoded = encodeURIComponent(JSON.stringify(config));
      setChartUrl(`https://quickchart.io/chart?c=${encoded}&w=300&h=160&bkg=23272f`);
    }

    buildChart();
  }, [symbol]);

  return (
    <div className="bg-[#23272f] rounded-2xl shadow flex h-40 overflow-hidden">
      {/* INFO (35%) */}
      <div className="w-1/3 p-3 flex flex-col justify-center space-y-1">
        <h3 className="text-xl font-bold">{symbol}</h3>
        <div className="text-sm">Price: ${price.toFixed(2)}</div>
        <div className="text-sm">
          Signal:{' '}
          <span className={signal === 'LONG' ? 'text-green-400' : 'text-red-400'}>
            {signal === 'LONG' ? '⇧' : '⇩'} {signal}
          </span>
        </div>
        <div className="text-sm">Confidence: {confidence.toFixed(2)}%</div>
        <div className="text-xs text-gray-400">
          1h: {change1h.toFixed(2)}% • 24h: {change24h.toFixed(2)}%
        </div>
      </div>

      {/* CHART (65%) */}
      <div className="w-2/3 flex items-center justify-center bg-[#1f2339]">
        {chartUrl ? (
          <img
            src={chartUrl}
            alt={`${symbol} 2h candlestick`}
            className="h-full object-contain"
          />
        ) : (
          <div className="text-gray-500">Loading chart…</div>
        )}
      </div>
    </div>
  );
}
