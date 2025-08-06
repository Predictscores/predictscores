// components/SignalCard.jsx
import React from 'react';
import TradingViewChart from './TradingViewChart';

export default function SignalCard({ data }) {
  // Destrukturiramo samo ono što API zaista vraća, sa default vrednostima
  const {
    symbol = '',
    price = 0,
    signal = '',
    confidence = 0,
    change1h = 0,
    change24h = 0
  } = data;

  return (
    <div className="bg-[#23272f] rounded-2xl shadow flex h-full overflow-hidden">
      {/* Levi deo: info (35% width) */}
      <div className="w-1/3 p-4 flex flex-col justify-center space-y-1">
        <h3 className="text-xl font-bold">{symbol}</h3>
        <div className="text-sm">Price: ${price.toFixed(2)}</div>
        <div className="text-sm">
          Signal:{' '}
          <span className={signal === 'LONG' ? 'text-green-400' : 'text-red-400'}>
            {signal}
          </span>
        </div>
        <div className="text-sm">Confidence: {confidence.toFixed(2)}%</div>
        <div className="text-xs text-gray-400">
          1h: {change1h.toFixed(2)}% • 24h: {change24h.toFixed(2)}%
        </div>
      </div>

      {/* Desni deo: chart (65% width) */}
      <div className="w-2/3">
        <TradingViewChart symbol={symbol} patternMarkers={[]} />
      </div>
    </div>
  );
}
