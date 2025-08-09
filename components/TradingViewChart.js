// FILE: components/TradingViewChart.js
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Lagan SVG grafikon sa fallback fetch-om:
 * - Ako bars (OHLC) stigne u props -> koristi to
 * - Inače pokušaj Binance 24h / 30m za {SYMBOL}USDT
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
        {error ? 'Chart error' : 'Loading chart…'}
      </div>
    );
  }

  try {
    // ----- skale -----
    const width = 860;
    const height = 220;
    const pad = 30;

    const times = data.map(d => (d.time > 2e12 ? d.time : d.time * 1000));
    const closes = data.map(d => d.close);

    const finite = (arr, fallback) =>
      arr.reduce((acc, v) => (Number.isFinite(v) ? Math.min(acc, v) : acc), fallback);

    const finiteMax = (arr, fallback) =>
      arr.reduce((acc, v) => (Number.isFinite(v) ? Math.max(acc, v) : acc), fallback);

    const minClose = finite(closes,  +Infinity);
    const maxClose = finiteMax(closes, -Infinity);

    const minY = Math.min(
      minClose,
      Number.isFinite(sl) ? sl : +Infinity,
      Number.isFinite(entry) ? entry : +Infinity,
      Number.isFinite(tp) ? tp : +Infinity
    );
    const maxY = Math.max(
      maxClose,
      Number.isFinite(sl) ? sl : -Infinity,
      Number.isFinite(entry) ? entry : -Infinity,
      Number.isFinite(tp) ? tp : -Infinity
    );

    // ako i dalje nije validno, odustani bez rušenja
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY - minY <= 0) {
      return (
        <div className="text-gray-500 text-sm w-full h-40 flex items-center justify-center">
          Chart error
        </div>
      );
    }

    const xMin = Math.min(...times);
    const xMax = Math.max(...times);
    const xDen = Math.max(1, xMax - xMin);
    const yDen = Math.max(1e-9, maxY - minY);

    const xScale = (t) => pad + ((t - xMin) / xDen) * (width - pad * 2);
    const yScale = (v) => pad + (1 - ((v - minY) / yDen)) * (height - pad * 2);

    const pricePath = closes.map((c, i) => {
      const t = times[i];
      const cmd = i === 0 ? 'M' : 'L';
      return `${cmd} ${xScale(t)} ${yScale(c)}`;
    }).join(' ');

    const line = (val, color, dash = '0') =>
      Number.isFinite(val) ? (
        <line
          x1={pad} x2={width - pad}
          y1={yScale(val)} y2={yScale(val)}
          stroke={color} strokeWidth="2" strokeDasharray={dash}
          opacity="0.9"
        />
      ) : null;

    // X ticks – umereno
    const ticks = [];
    const step = Math.max(1, Math.ceil(data.length / 8));
    for (let i = 0; i < data.length; i += step) {
      const t = new Date(times[i]);
      const label = t.toLocaleTimeString([], { hour: 'numeric' });
      ticks.push({ x: xScale(times[i]), label });
    }

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40">
        <rect x="0" y="0" width={width} height={height} fill="transparent" />

        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={pad} x2={width - pad}
            y1={pad + p * (height - pad * 2)}
            y2={pad + p * (height - pad * 2)}
            stroke="rgba(255,255,255,0.08)"
          />
        ))}

        {line(tp,    '#22c55e')}
        {line(entry, 'rgba(255,255,255,0.75)', '6,6')}
        {line(sl,    '#ef4444')}

        <path d={pricePath} fill="none" stroke="#4da6ff" strokeWidth="2.5" />

        {ticks.map((t, idx) => (
          <text
            key={idx}
            x={t.x}
            y={height - 6}
            fontSize="10"
            textAnchor="middle"
            fill="rgba(255,255,255,0.6)"
          >
            {t.label}
          </text>
        ))}
      </svg>
    );
  } catch (e) {
    // poslednja zaštita – nikad ne ruši
    return (
      <div className="text-gray-500 text-sm w-full h-40 flex items-center justify-center">
        Chart error
      </div>
    );
  }
}
