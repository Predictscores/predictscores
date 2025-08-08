// FILE: components/SignalCard.js
import React, { useEffect, useState, useMemo } from 'react';
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
    bars: initialBars = []
  } = data;

  const [bars, setBars] = useState(Array.isArray(initialBars) ? initialBars : []);
  const [barsLoading, setBarsLoading] = useState(false);
  const [barsError, setBarsError] = useState(null);

  // dovuci 30m/24h barove ako nisu došli u data
  useEffect(() => {
    let cancelled = false;

    async function loadBars() {
      try {
        if ((initialBars || []).length > 0) return;
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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const fmt = (n, d = 4) => (typeof n === 'number' ? n.toFixed(d) : '—');
  const pct = (n, d = 2) => (typeof n === 'number' ? `${Math.abs(n).toFixed(d)}%` : '—');
  const arrow = (n) => (typeof n === 'number' ? (n > 0 ? '▲' : n < 0 ? '▼' : '•') : '•');

  const signClass = (n) => {
    if (typeof n !== 'number') return 'bg-slate-500/15 text-slate-300 ring-1 ring-white/10';
    if (n > 0) return 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30';
    if (n < 0) return 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30';
    return 'bg-slate-500/15 text-slate-300 ring-1 ring-white/10';
  };

  const conf = useMemo(() => {
    const x = Number(confidence ?? 0);
    return Math.max(0, Math.min(100, isNaN(x) ? 0 : x));
  }, [confidence]);

  const confBarClass = conf >= 75 ? 'bg-emerald-500' : conf >= 50 ? 'bg-sky-500' : 'bg-amber-400';
  const dirBadgeClass =
    signal === 'SHORT'
      ? 'from-rose-500 to-rose-400 text-rose-950'
      : 'from-emerald-500 to-emerald-400 text-emerald-950';

  return (
    <div className="w-full bg-[#1f2339] p-5 rounded-2xl shadow flex flex-col md:flex-row">
      {/* INFO BLOK (≈40%) */}
      <div className="md:w-[40%] md:pr-6 flex flex-col gap-3">
        {/* Naslov + smer */}
        <div className="flex items-center gap-3">
          <h3 className="text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-white to-slate-300">
            {symbol}
          </h3>
          <span
            className={
              'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-extrabold uppercase bg-gradient-to-b ' +
              dirBadgeClass +
              ' shadow'
            }
            title={signal}
          >
            {signal} {signal === 'SHORT' ? '↓' : '↑'}
          </span>
        </div>

        {/* Cene + TP/SL */}
        <div className="text-sm space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-slate-300">Current:</span>
            <span className="font-semibold">${fmt(price)}</span>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-slate-300">Entry</span>
            <span className={signal === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}>
              ${fmt(entryPrice)} {signal === 'LONG' ? '↑' : '↓'}
            </span>
          </div>

          <div className="flex gap-2 pt-1">
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/90 text-emerald-50 shadow">
              TP: ${fmt(tp)}
            </span>
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/90 text-rose-50 shadow">
              SL: ${fmt(sl)}
            </span>
          </div>
        </div>

        {/* 1h / 24h promene */}
        <div className="flex gap-2 text-xs">
          <span
            className={
              'inline-flex items-center gap-1 px-2 py-1 rounded-full ' + signClass(change1h)
            }
          >
            {arrow(change1h)} 1h {pct(change1h)}
          </span>
          <span
            className={
              'inline-flex items-center gap-1 px-2 py-1 rounded-full ' + signClass(change24h)
            }
          >
            {arrow(change24h)} 24h {pct(change24h)}
          </span>
        </div>

        {/* Expected + Confidence bar */}
        <div className="space-y-1">
          <div className="text-sm">
            Expected: <span className="font-medium">{fmt(expectedMove, 2)}%</span>{' '}
            <span
              className={
                conf >= 75 ? 'text-emerald-400' : conf >= 50 ? 'text-sky-400' : 'text-amber-300'
              }
              title={`Confidence ${conf.toFixed(0)}%`}
            >
              ●
            </span>
          </div>
          <div>
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>Confidence</span>
              <span>{conf.toFixed(0)}%</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div className={'h-full ' + confBarClass} style={{ width: `${conf}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* GRAF (≈60%) */}
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
