// FILE: components/SignalCard.js

import React from 'react';
import TradingViewChart from './TradingViewChart';

export default function SignalCard({ data, type }) {
  const {
    symbol,
    price,
    entryPrice,
    sl,
    tp,
    expectedMove,
    confidence,
    change1h,
    change24h,
    signal,
    // pretpostavljamo da incoming `data` može imati i `patterns` i `bars`
    patterns = [],
    bars = [],
  } = data || {};

  // Format helper
  const fmt = (num, dp = 4) =>
    typeof num === 'number' ? num.toFixed(dp) : '—';

  return (
    <div className="w-full bg-[#1f2339] p-5 rounded-2xl shadow flex">
      {/* ----- LEVI DEO: INFO (35%) ----- */}
      <div className="w-[35%] pr-4 flex flex-col justify-between">
        <h3 className="text-2xl font-bold">{symbol}</h3>
        <div className="text-sm">
          <div>Current: ${fmt(price)}</div>
          <div>
            Entry:{' '}
            <span
              className={
                signal === 'LONG' ? 'text-green-400' : 'text-red-400'
              }
            >
              ${fmt(entryPrice)}{' '}
              {signal === 'LONG' ? '↑' : '↓'}
            </span>
          </div>
          <div className="mt-2 flex gap-2">
            <button className="bg-green-500 px-3 py-1 rounded-full text-sm">
              TP: ${fmt(tp)}
            </button>
            <button className="bg-red-500 px-3 py-1 rounded-full text-sm">
              SL: ${fmt(sl)}
            </button>
          </div>
        </div>
        <div className="text-sm mt-2">
          Expected: {fmt(expectedMove, 2)}%{' '}
          <span
            className={
              confidence >= 75
                ? 'text-green-400'
                : confidence >= 50
                ? 'text-blue-400'
                : 'text-yellow-300'
            }
          >
            ●
          </span>
        </div>
        <div className="text-xs text-gray-400 mt-1">
          1h: {fmt(change1h, 2)}% · 24h: {fmt(change24h, 2)}%
        </div>
      </div>

      {/* ----- SREDNJI DEO: PATTERNS (Optional) ----- */}
      <div className="w-[15%] px-4 flex flex-col justify-center items-center border-l border-gray-700">
        {patterns.length > 0 ? (
          patterns.map((p, i) => (
            <div key={i} className="text-xs mb-1">
              {p.name || p}
            </div>
          ))
        ) : (
          <div className="text-xs text-gray-500">No patterns</div>
        )}
      </div>

      {/* ----- DESNI DEO: CHART (50%) ----- */}
      <div className="w-[50%] pl-4 flex items-center justify-center">
        {Array.isArray(bars) && bars.length > 0 ? (
          <TradingViewChart
            bars={bars}
            entry={entryPrice}
            sl={sl}
            tp={tp}
          />
        ) : (
          <div className="text-gray-500 text-sm">
            Loading chart…
          </div>
        )}
      </div>
    </div>
  );
}
