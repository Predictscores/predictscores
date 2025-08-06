// components/SignalCard.js
import React from 'react';
import TradingViewChart from './TradingViewChart';

export default function SignalCard({ data, type }) {
  const {
    symbol,
    price,
    signal,
    confidence,
    change1h,
    change24h,
    // pattern možete naknadno ubaciti:
    // patternMarkers: [{ time, price, label }]
  } = data;

  // primer bez pattern markera
  const markers = [];

  return (
    <div className="bg-[#23272f] p-4 rounded-2xl shadow flex items-center justify-between">
      {/* Leva kolona: tekstualni podaci */}
      <div className="flex-1">
        <div className="text-xl font-bold">{symbol}</div>
        <div className="text-sm">Signal: {signal}</div>
        <div className="text-sm">Confidence: {confidence}%</div>
        <div className="text-xs text-gray-400">
          1h: {change1h.toFixed(2)}% • 24h: {change24h.toFixed(2)}%
        </div>
      </div>

      {/* Desna kolona: grafikon */}
      <div className="w-36 h-24">
        <TradingViewChart symbol={symbol} patternMarkers={markers} />
      </div>
    </div>
  );
}
