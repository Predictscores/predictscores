// components/SignalCard.jsx
import React from 'react';
import TradingViewChart from './TradingViewChart';

export default function SignalCard({ data }) {
  const {
    symbol,
    price,         // trenutna cena
    entryPrice,    // ulazna cena
    signal,        // 'LONG' ili 'SHORT'
    tp,            // take-profit cena
    sl,            // stop-loss cena
    expectedMove,  // očekivani % pomaka
    confidence,    // 0–100
    patterns = []  // niz stringova, npr. ['Engulfing', 'Doji']
  } = data;

  // priprema markera za chart (ako želiš pattern-e na grafu)
  const patternMarkers = patterns.map((label, i) => ({
    time: Date.now(),   // zameni za stvarni timestamp sveće
    price,              // pozicija markera na grafikonu
    label
  }));

  return (
    <div className="bg-[#23272f] rounded-2xl shadow flex h-full overflow-hidden">
      {/* Levi deo - informacije */}
      <div className="w-1/3 p-4 flex flex-col justify-center space-y-1">
        <h3 className="text-xl font-bold">{symbol}</h3>
        <div className="text-sm">Current: ${price.toFixed(2)}</div>
        <div className="text-sm">
          Entry: ${entryPrice.toFixed(2)}
          <span className={`ml-1 ${signal === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>
            {signal === 'LONG' ? '⇧' : '⇩'}
          </span>
        </div>
        <div className="text-sm">TP: ${tp.toFixed(2)} / SL: ${sl.toFixed(2)}</div>
        <div className="text-sm">
          Expected: {expectedMove.toFixed(2)}%
          <span className="ml-2">
            {confidence > 75 ? '🟢' : confidence > 50 ? '🔵' : '🟡'}
          </span>
        </div>
        {patterns.length > 0 && (
          <div className="text-xs text-gray-400">
            Patterns: {patterns.join(', ')}
          </div>
        )}
      </div>

      {/* Desni deo - grafikon */}
      <div className="w-2/3">
        <TradingViewChart symbol={symbol} patternMarkers={patternMarkers} />
      </div>
    </div>
  );
}
