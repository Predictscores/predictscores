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
  const pct = (n, d = 2) =>
    typeof n === 'number' ? `${(Math.abs(n)).toFixed(d)}%` : '—';
  const arrow = (n) => (typeof n === 'number' ? (n > 0 ? '▲' : n < 0 ? '▼' : '•') : '•');
  const signClass = (n) =>
    typeof n === 'number'
      ? n > 0
        ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
        : n < 0
        ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30'
        : 'bg-slate-500/15 text-slate-300 ring-1 ring-white/10'
      : 'bg-slate-500/15 text-slate-300 ring-1 ring-white/10';

  const conf = useMemo(() => {
    const x = Number(confidence ?? 0);
    return Math.max(0, Math.min(100, isNaN(x) ? 0 : x));
  }, [confidence]);

  const confBarClass =
    conf >= 75 ? 'bg-emerald-500' : conf >= 50 ? 'bg-sky-500' : 'bg-amber-400';

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
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-extrabold uppercase bg-gradient-to-b ${dirBadgeClass} shadow`}
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
          <span className={`inline-flex
