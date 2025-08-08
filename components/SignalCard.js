// FILE: components/SignalCard.js
import React, { useEffect, useState } from 'react';
import TradingViewChart from './TradingViewChart';

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
    bars: initialBars = [] // ako API već pošalje bars – koristimo
  } = data;

  const [bars, setBars] = useState(Array.isArray(initialBars) ? initialBars : []);
  const [barsLoading, setBarsLoading] = useState(false);
  const [barsError, setBarsError] = useState(null);

  // Ako bars nisu došli kroz data → povuci ih sa našeg API-ja (30m, 24h)
  useEffect(() => {
    let cancelled = false;

    async function loadBars() {
      try {
        if (Array.isArray(initialBars) && initialBars.length > 0) return;
        if (!symbol) return;

        setBarsLoading(true);
        setBarsError(null);

        const q = encodeURIComponent(symbol);
        const res = await fetch(`/api/ohlc?symbol=${q}&interval=30m&limit=48`, {
          headers: { accept: 'application/json' }
        });

        if (!res.ok) throw new Error(`OHLC ${res.status}`);
        const json = await res.json();
        const b = Array.isArray(json?.bars) ? json.bars : [];
        if (!cancelled) setBars(b);
      } catch (e) {
        if (!cancelled) setBarsError(e.message || 'Bars error');
        console.error('SignalCard bars fetch error', e);
      } finally {
        if (!cancelled) setBarsLoading(false);
      }
    }

    loadBars();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const fmt = (n, d = 4) => (typeof n === 'number' ? n.toFixed(d) : '—');

  return (
    <div className="w-full bg-[#1f2339] p-5 rounded-2xl shadow flex flex-col md:flex-row">
      {/* LEVI BLOK (info) */}
      <div className="md:w-[40%] md:pr-6 flex flex-col justify-between">
        <h3 className="text-2xl font-bold">{symbol}</h3>

        <div className="text-sm mt-1">
          <div>Current: ${fmt(price)}</div>
          <div>
            Entry{' '}
            <span className={signal === 'LONG' ? 'text-green-400' : 'text-red-400'}>
              ${fmt(entryPrice)} {signal === 'LONG' ? '↑' : '↓'}
            </span>
          </div>

          <div className="mt-2 flex gap-2">
            <span className="bg-green-500/90 px-3 py-1 rounded-full text-sm">
              TP: ${fmt(tp)}
            </span>
            <span className="bg-red-500/90 px-3 py-1 rounded-full text-sm">
              SL: ${fmt(sl)}
            </span>
          </div>
        </div>

        <div className="text-sm mt-2">
          Expected: {fmt(expectedMove, 2)}%{' '}
          <span
            className={
              confidence >= 75 ? 'text-green-400' :
              confidence >= 50 ? 'text-blue-400' : 'text-yellow-300'
            }
          >
            ●
          </span>
        </div>

        <div className="text-xs text-gray-400 mt-1">
          1h: {fmt(change1h, 2)}% · 24h: {fmt(change24h, 2)}%
        </div>
      </div>

      {/* DESNI BLOK (graf) */}
      <div className="md:w-[60%] md:pl-6 mt-4 md:mt-0 border-t md:border-t-0 md:border-l border-gray-700 flex items-center justify-center">
        {barsLoading ? (
          <div className="text-gray-500 text-sm">Loading chart…</div>
        ) : barsError ? (
          <div className="text-red-400 text-sm">Chart error</div>
        ) : bars.length > 0 ? (
          <TradingViewChart bars={bars} entry={entryPrice} sl={sl} tp={tp} />
        ) : (
          <div className="text-gray-500 text-sm">No data</div>
        )}
      </div>
    </div>
  );
}
