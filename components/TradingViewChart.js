// FILE: components/TradingViewChart.js
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Lagan SVG grafikon sa fallback fetch-om:
 * - Ako bars (OHLC) stigne u props -> koristi to
 * - Inače pokušaj 30m klines za {SYMBOL}USDT (fallback)
 * Robusne provere: nikad ne baca exception pri renderu.
 */
export default function TradingViewChart({ bars = [], entry, sl, tp, symbol }) {
  const [fallbackBars, setFallbackBars] = useState(null);
  const [error, setError] = useState(null);

  // izvor podataka za crtanje (props ili fallback)
  const data = useMemo(() => {
    const arr = Array.isArray(bars) && bars.length > 0
      ? bars
      : (Array.isArray(fallbackBars) && fallbackBars.length > 0 ? fallbackBars : null);

    if (!arr) return null;

    // normalizuj i filtriraj samo validne tačke
    const safe = arr
      .map(d => ({
        time: typeof d.time === 'number' ? d.time : Date.parse(d.time),
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
      }))
      .filter(d =>
        Number.isFinite(d.time) &&
        Number.isFinite(d.close) &&
        Number.isFinite(d.high) &&
        Number.isFinite(d.low) &&
        Number.isFinite(d.open)
      );

    return safe.length >= 2 ? safe : null;
  }, [bars, fallbackBars]);

  // Fallback fetch ako nema bars
  useEffect(() => {
    let abort = false;

    async function fetchFallback() {
      try {
        if (Array.isArray(bars) && bars.length > 0) return;
        if (!symbol) return;

        const pair = `${String(symbol).toUpperCase()}USDT`;
        const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=30m&limit=50`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

        const json = await res.json();
        const mapped = Array.isArray(json)
          ? json.map(row => ({
              time: Number(row[0]),                 // ms
              open: Number(row[1]),
              high: Number(row[2]),
              low:  Number(row[3]),
              close:Number(row[4]),
            }))
          : [];

        if (!abort) setFallbackBars(mapped);
      } catch (e) {
        if (!abort) setError(e?.message || 'Chart error');
      }
    }

    fetchFallback();
    return () => { abort = true; };
  }, [bars, symbol]);

  // ako ni posle svega nemamo validne tačke -> prikaži poruku, ne ruši render
  if (!data) {
    return (
      <div className="text-gray-500 text-sm w-full h-40 flex items-center justify-center">
        {error ? `No chart (${error})` : 'No chart'}
      </div>
    );
  }

  // izračunaj min/max za skalu
  const min = Math.min(...data.map(d => d.low));
  const max = Math.max(...data.map(d => d.high));
  const pad = (max - min) * 0.1 || 1e-6;
  const lo = min - pad;
  const hi = max + pad;

  // dimenzije
  const W = 560;
  const H = 180;
  const L = 40;  // left padding
  const R = 10;  // right padding
  const T = 10;  // top
  const B = 20;  // bottom

  // helper skale
  const x = (i) => L + (i * (W - L - R)) / (data.length - 1);
  const y = (v) => {
    const clamped = Math.max(lo, Math.min(hi, v));
    return T + (H - T - B) * (1 - (clamped - lo) / (hi - lo));
  };

  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.close)}`).join(' ');

  // horizontalne linije za entry/sl/tp
  const hline = (v, cls) =>
    Number.isFinite(v) ? <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={cls} strokeWidth="1" /> : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40">
      {/* frame */}
      <rect x="0" y="0" width={W} height={H} fill="transparent" />
      {/* price path */}
      <path d={path} fill="none" stroke="currentColor" className="text-sky-300" strokeWidth="1.5" />
      {/* entry/tp/sl */}
      {hline(entry, "text-emerald-400")}
      {hline(tp, "text-green-400")}
      {hline(sl, "text-rose-400")}
    </svg>
  );
}
