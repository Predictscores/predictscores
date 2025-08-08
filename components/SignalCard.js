// FILE: components/SignalCard.js
import React from 'react';
import TradingViewChart from './TradingViewChart';

// format brojeva
function fmt(n, d = 4) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—';
}

// normalizuj/cap-uj confidence na [5..95] za prikaz
function normalizeConfidence(conf) {
  const raw = typeof conf === 'number' ? conf : 0;
  const pct = raw > 1 ? raw : raw * 100; // ako stigne u [0..1], prebaci u %
  const capped = Math.min(95, Math.max(5, Math.round(pct)));
  return capped;
}

export default function SignalCard({ data = {}, type }) {
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
    patterns = [],
    bars = [],
  } = data;

  const confDisplay = normalizeConfidence(confidence);

  // bucket i boja tačkice uz "Expected"
  let bucketText = 'Low';
  let confDot = 'text-amber-300';
  if (confDisplay >= 90) {
    bucketText = 'Top Pick';
    confDot = 'text-orange-400';
  } else if (confDisplay >= 75) {
    bucketText = 'High';
    confDot = 'text-green-400';
  } else if (confDisplay >= 50) {
    bucketText = 'Moderate';
    confDot = 'text-sky-400';
  }

  return (
    <div className="w-full bg-[#1f2339] p-5 rounded-2xl shadow flex">
      {/* LEVO ~35% */}
      <div className="w-[35%] pr-4 flex flex-col">
        <h3 className="text-2xl font-bold">{symbol}</h3>

        <div className="mt-2 text-sm">
          <div>Current: ${fmt(price)}</div>
          <div>
            Entry:{' '}
            <span className={signal === 'LONG' ? 'text-green-400' : 'text-red-400'}>
              ${fmt(entryPrice)} {signal === 'LONG' ? '↑' : '↓'}
            </span>
          </div>

          <div className="mt-2 flex gap-2">
            <span className="bg-green-500/20 border border-green-400/30 text-green-200 px-3 py-1 rounded-full text-xs">
              TP: ${fmt(tp)}
            </span>
            <span className="bg-red-500/20 border border-red-400/30 text-red-200 px-3 py-1 rounded-full text-xs">
              SL: ${fmt(sl)}
            </span>
          </div>
        </div>

        {/* Expected + bucket */}
        <div className="text-sm mt-3 flex items-center gap-2">
          <span>Expected: {fmt(expectedMove, 2)}%</span>
          <span className={confDot}>●</span>
          <span className="text-gray-200">{bucketText}</span>
        </div>

        {/* Confidence progress bar (kao na tvom screenshotu) */}
        <div className="mt-2">
          <div className="text-xs text-gray-400 mb-1">Confidence</div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                style={{ width: `${Math.max(0, Math.min(100, confDisplay))}%` }}
              />
            </div>
            <span className="text-xs text-gray-300">{confDisplay}%</span>
          </div>
        </div>

        <div className="text-xs text-gray-400 mt-2">
          1h: {fmt(change1h, 2)}% · 24h: {fmt(change24h, 2)}%
        </div>
      </div>

      {/* SREDINA ~15% (patterns trenutno ne koristimo) */}
      <div className="w-[15%] px-4 flex flex-col justify-center items-center border-l border-gray-700">
        <div className="text-xs text-gray-500">—</div>
      </div>

      {/* DESNO ~50% grafikon */}
      <div className="w-[50%] pl-4 flex items-center justify-center">
        {Array.isArray(bars) && bars.length > 0 ? (
          <TradingViewChart bars={bars} entry={entryPrice} sl={sl} tp={tp} />
        ) : (
          <div className="text-gray-500 text-sm">Loading chart…</div>
        )}
      </div>
    </div>
  );
}
