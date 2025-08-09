// FILE: components/TradingViewChart.js
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Minimalan, lagan SVG grafikon sa fallback fetch-om:
 * - Ako bars (OHLC) stigne kroz props -> koristimo to
 * - Inače povlačimo 24h/30m sa Binance (SYMBOLUSDT)
 *
 * Očekuje: bars: [{ time: sec|ms, open, high, low, close }], entry, sl, tp, symbol
 */
export default function TradingViewChart({ bars = [], entry, sl, tp, symbol }) {
  const [fallbackBars, setFallbackBars] = useState(null);
  const [error, setError] = useState(null);

  // Odluči koje barove da crta (prop ili fallback)
  const data = useMemo(() => {
    if (Array.isArray(bars) && bars.length > 0) return bars;
    if (Array.isArray(fallbackBars) && fallbackBars.length > 0) return fallbackBars;
    return null;
  }, [bars, fallbackBars]);

  // Fallback fetch sa Binance ako nema barova iz props
  useEffect(() => {
    let abort = false;

    async function fetchFallback() {
      try {
        if (Array.isArray(bars) && bars.length > 0) return; // imamo već podatke
        if (!symbol) return;

        // Pokušaj {SYMBOL}USDT par
        const pair = `${String(symbol).toUpperCase()}USDT`;
        const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=30m&limit=50`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

        const json = await res.json();
        // Kline format: [ openTime, open, high, low, close, ... ]
        const mapped = json.map(row => ({
          time: row[0], // ms
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
        }));
        if (!abort) setFallbackBars(mapped);
      } catch (e) {
        if (!abort) setError(e.message || 'Chart error');
      }
    }

    fetchFallback();
    return () => { abort = true; };
  }, [bars, symbol]);

  if (!data) {
    return (
      <div className="text-gray-500 text-sm w-full h-40 flex items-center justify-center">
        {error ? 'Chart error' : 'Loading chart…'}
      </div>
    );
  }

  // ----- priprema skale -----
  const width = 860;     // virtuozno platno; skalira se preko viewBox
  const height = 220;
  const pad = 30;

  // Pretvori time u ms ako su sekunde
  const times = data.map(d => (d.time > 2e12 ? d.time : d.time * 1000));
  const closes = data.map(d => d.close);

  const minY = Math.min(
    Math.min(...closes),
    typeof sl === 'number' ? sl : Infinity,
    typeof entry === 'number' ? entry : Infinity,
    typeof tp === 'number' ? tp : Infinity
  );
  const maxY = Math.max(
    Math.max(...closes),
    typeof sl === 'number' ? sl : -Infinity,
    typeof entry === 'number' ? entry : -Infinity,
    typeof tp === 'number' ? tp : -Infinity
  );

  const xMin = Math.min(...times);
  const xMax = Math.max(...times);

  const xScale = (t) => {
    const x = (t - xMin) / Math.max(1, (xMax - xMin));
    return pad + x * (width - pad * 2);
  };

  const yScale = (v) => {
    const y = (v - minY) / Math.max(1e-9, (maxY - minY));
    // invert (0 top, 1 bottom)
    return pad + (1 - y) * (height - pad * 2);
  };

  const pricePath = useMemo(() => {
    return closes.map((c, i) => {
      const t = times[i];
      return `${i === 0 ? 'M' : 'L'} ${xScale(t)} ${yScale(c)}`;
    }).join(' ');
  }, [closes, times]);

  const line = (val, color, dash = '0') => (
    typeof val === 'number' ? (
      <line
        x1={pad} x2={width - pad}
        y1={yScale(val)} y2={yScale(val)}
        stroke={color} strokeWidth="2" strokeDasharray={dash}
        opacity="0.9"
      />
    ) : null
  );

  // skromne X oznake (svaki 6. bar)
  const ticks = [];
  const step = Math.ceil(data.length / 8);
  for (let i = 0; i < data.length; i += step) {
    const t = new Date(times[i]);
    const label = t.toLocaleTimeString([], { hour: 'numeric' });
    ticks.push({ x: xScale(times[i]), label });
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40">
      {/* pozadina */}
      <rect x="0" y="0" width={width} height={height} fill="transparent" />

      {/* mreža Y (blaga) */}
      {[0.25, 0.5, 0.75].map((p) => (
        <line
          key={p}
          x1={pad} x2={width - pad}
          y1={pad + p * (height - pad * 2)}
          y2={pad + p * (height - pad * 2)}
          stroke="rgba(255,255,255,0.08)"
        />
      ))}

      {/* linije: TP / ENTRY (dashed) / SL */}
      {line(tp,   '#22c55e')}
      {line(entry, 'rgba(255,255,255,0.75)', '6,6')}
      {line(sl,   '#ef4444')}

      {/* sama cena */}
      <path d={pricePath} fill="none" stroke="#4da6ff" strokeWidth="2.5" />

      {/* X oznake */}
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
}
