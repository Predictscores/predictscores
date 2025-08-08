// FILE: components/SignalCard.js
import React, { useEffect, useState } from 'react';
import TradingViewChart from './TradingViewChart';

export default function SignalCard({ data = {} }) {
  const {
    symbol,
    price,
    entryPrice,
    sl,
    tp,
    expectedMove,
    confidence,  // 0–100 (iz konteksta)
    change1h,
    change24h,
    signal,      // "LONG" | "SHORT"
    tier,        // "low" | "moderate" | "high" | "top"
    bars: initialBars = []
  } = data;

  const [bars, setBars] = useState(Array.isArray(initialBars) ? initialBars : []);
  const [barsLoading, setBarsLoading] = useState(false);
  const [barsError, setBarsError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadBars() {
      try {
        if ((initialBars || []).length > 0) return;
        if (!symbol) return;
        setBarsLoading(true);
        setBarsError(null);
        const q = encodeURIComponent(symbol);
        const res = await fetch('/api/ohlc?symbol=' + q + '&interval=30m&limit=48', {
          headers: { accept: 'application/json' }
        });
        if (!res.ok) throw new Error('OHLC ' + res.status);
        const json = await res.json();
        const b = Array.isArray(json && json.bars) ? json.bars : [];
        if (!cancelled) setBars(b);
      } catch (e) {
        if (!cancelled) setBarsError(e.message || 'Bars error');
      } finally {
        if (!cancelled) setBarsLoading(false);
      }
    }
    loadBars();
    return function () { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const fmt = (n, d) => (typeof n === 'number' ? n.toFixed(d != null ? d : 4) : '—');
  const pct = (n, d) => (typeof n === 'number' ? Math.abs(n).toFixed(d != null ? d : 2) + '%' : '—');
  const arrow = (n) => (typeof n === 'number' ? (n > 0 ? '▲' : n < 0 ? '▼' : '•') : '•');

  const changeChip = (val) => {
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] ring-1 ';
    if (typeof val !== 'number') return base + 'bg-slate-600/20 text-slate-300 ring-white/10';
    if (val > 0) return base + 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30';
    if (val < 0) return base + 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
    return base + 'bg-slate-600/20 text-slate-300 ring-white/10';
  };

  const dirBadge =
    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ' +
    (signal === 'SHORT'
      ? 'bg-gradient-to-b from-rose-500 to-rose-400 text-rose-950'
      : 'bg-gradient-to-b from-emerald-500 to-emerald-400 text-emerald-950');

  const tierBadge =
    tier === 'top'
      ? '🔥 Top Pick'
      : tier === 'high'
      ? 'High'
      : tier === 'moderate'
      ? 'Moderate'
      : 'Low';

  const tierDot =
    tier === 'top'
      ? 'text-orange-300'
      : tier === 'high'
      ? 'text-emerald-400'
      : tier === 'moderate'
      ? 'text-sky-400'
      : 'text-amber-300';

  // 2 kolone i na mobilu → graf uvek pored info
  return (
    <div className="w-full bg-[#1f2339] p-4 md:p-5 rounded-2xl shadow grid grid-cols-2 gap-4">
      {/* INFO (leva kolona) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-2xl md:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-white to-slate-300">
            {symbol}
          </h3>
          <span className={dirBadge} title={signal}>
            {signal} {signal === 'SHORT' ? '↓' : '↑'}
          </span>
        </div>

        <div className="text-sm space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-slate-300">Current:</span>
            <span className="font-semibold">${fmt(price, 4)}</span>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-slate-300">Entry</span>
            <span className={signal === 'LONG' ? 'text-emerald-400' : 'text-rose-400'} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
              ${fmt(entryPrice, 4)} {signal === 'LONG' ? '↑' : '↓'}
            </span>
          </div>

          <div className="flex gap-2 pt-1">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold ring-1 ring-emerald-500/40 text-emerald-300 bg-emerald-500/10">
              TP: ${fmt(tp, 4)}
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold ring-1 ring-rose-500/40 text-rose-300 bg-rose-500/10">
              SL: ${fmt(sl, 4)}
            </span>
          </div>
        </div>

        <div className="flex gap-2 text-[11px]">
          <span className={changeChip(change1h)}>{arrow(change1h)} Δ1h {pct(change1h, 2)}</span>
          <span className={changeChip(change24h)}>{arrow(change24h)} Δ24h {pct(change24h, 2)}</span>
        </div>

        <div className="space-y-1">
          <div className="text-sm flex items-center gap-2">
            <span>Expected: <span className="font-medium">{fmt(expectedMove, 2)}%</span></span>
            <span className={tierDot}>●</span>
            <span className="text-xs opacity-80">{tierBadge}</span>
          </div>
          <div>
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>Confidence</span>
              <span>{Math.round(confidence || 0)}%</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className={
                  'h-full ' +
                  (confidence >= 90
                    ? 'bg-orange-400'
                    : confidence >= 75
                    ? 'bg-emerald-500'
                    : confidence >= 50
                    ? 'bg-sky-500'
                    : 'bg-amber-400')
                }
                style={{ width: (Math.max(0, Math.min(100, Number(confidence || 0)))) + '%' }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* GRAF (desna kolona) */}
      <div className="border-l border-gray-700 pl-4 flex items-center">
        {barsLoading ? (
          <div className="text-gray-500 text-sm">Loading chart…</div>
        ) : barsError ? (
          <div className="text-red-400 text-sm">Chart error</div>
        ) : bars.length > 0 ? (
          <div className="w-full">
            <TradingViewChart bars={bars} entry={entryPrice} sl={sl} tp={tp} />
          </div>
        ) : (
          <div className="text-gray-500 text-sm">No data</div>
        )}
      </div>
    </div>
  );
}
