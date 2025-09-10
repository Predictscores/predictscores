// components/TradingViewChart.js
import React, { useEffect, useMemo, useState } from "react";

/**
 * Candlestick chart (pure SVG):
 * - koristi bars (time, open, high, low, close) ako stižu iz API-ja
 * - fallback fetch 30m OHLC: OKX -> Bybit -> Binance (public, bez API ključa)
 * - crta sveće + wick, grid, Y osu/oznaku i horizontalne linije: Entry / TP / SL
 */
export default function TradingViewChart({ bars = [], entry, sl, tp, symbol }) {
  const [fbBars, setFbBars] = useState(null);
  const [err, setErr] = useState(null);

  const data = useMemo(() => {
    const arr = (Array.isArray(bars) && bars.length > 0) ? bars
      : (Array.isArray(fbBars) && fbBars.length > 0 ? fbBars : null);
    if (!arr) return null;

    // normalizacija + sortiranje po vremenu
    const norm = arr
      .map(d => ({
        time: typeof d.time === "number" ? d.time : Date.parse(d.time),
        open: Number(d.open), high: Number(d.high), low: Number(d.low), close: Number(d.close),
      }))
      .filter(d => Number.isFinite(d.time) && Number.isFinite(d.open) && Number.isFinite(d.high) && Number.isFinite(d.low) && Number.isFinite(d.close))
      .sort((a, b) => a.time - b.time);

    return norm.length >= 10 ? norm.slice(-120) : null; // do 120 barova
  }, [bars, fbBars]);

  useEffect(() => {
    let abort = false;

    async function fetchOKX(sym) {
      const instId = `${sym}-USDT`;
      const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=30m&limit=120`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OKX ${r.status}`);
      const j = await r.json();
      const arr = Array.isArray(j?.data) ? j.data : [];
      // OKX vraća od najnovijeg ka starom => obrni, mapiraj
      return arr.reverse().map(x => ({
        time: Number(x[0]), open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]),
      }));
    }
    async function fetchBybit(sym) {
      const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}USDT&interval=30&limit=120`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Bybit ${r.status}`);
      const j = await r.json();
      const arr = Array.isArray(j?.result?.list) ? j.result.list : [];
      // Bybit lista je [openTime, open, high, low, close, ...] kao stringovi; obrnuto vreme
      return arr.reverse().map(x => ({
        time: Number(x[0]), open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]),
      }));
    }
    async function fetchBinance(sym) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=30m&limit=120`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      const j = await r.json();
      return (Array.isArray(j) ? j : []).map(x => ({
        time: Number(x[0]), open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]),
      }));
    }

    async function go() {
      try {
        if (Array.isArray(bars) && bars.length > 0) return; // imamo bars iz props
        if (!symbol) return;
        const sym = String(symbol).toUpperCase();
        // redosled: OKX -> Bybit -> Binance
        try {
          const a = await fetchOKX(sym);
          if (!abort) setFbBars(a);
          return;
        } catch {}
        try {
          const b = await fetchBybit(sym);
          if (!abort) setFbBars(b);
          return;
        } catch {}
        const c = await fetchBinance(sym);
        if (!abort) setFbBars(c);
      } catch (e) {
        if (!abort) setErr(e?.message || "chart error");
      }
    }

    go();
    return () => { abort = true; };
  }, [bars, symbol]);

  if (!data) {
    return (
      <div className="text-gray-500 text-sm w-full h-56 flex items-center justify-center">
        {err ? `No chart (${err})` : "No chart"}
      </div>
    );
  }

  // Dimenzije i padding
  const W = 640, H = 240;
  const L = 48, R = 12, T = 10, B = 24;

  // skale
  const minLo = Math.min(...data.map(d => d.low));
  const maxHi = Math.max(...data.map(d => d.high));
  const pad = (maxHi - minLo) * 0.08 || 1e-6;
  const lo = minLo - pad, hi = maxHi + pad;

  const N = data.length;
  const x = (i) => L + (i * (W - L - R)) / (N - 1);
  const y = (v) => {
    const vv = Math.max(lo, Math.min(hi, v));
    return T + (H - T - B) * (1 - (vv - lo) / (hi - lo));
  };

  // grid (4 horizontalne linije + labels)
  const gridLevels = [0, 0.25, 0.5, 0.75, 1].map(p => lo + p * (hi - lo));
  function fmtP(v) {
    // heuristika za decimale
    const mag = Math.abs(hi - lo);
    const d = mag > 10 ? 2 : mag > 1 ? 4 : 6;
    return v.toFixed(d);
    }

  // elementi
  const candleW = Math.max(2, (W - L - R) / N * 0.6);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-56">
      {/* background */}
      <rect x="0" y="0" width={W} height={H} fill="transparent" />

      {/* grid + y labels */}
      {gridLevels.map((gv, idx) => (
        <g key={`g-${idx}`}>
          <line x1={L} x2={W - R} y1={y(gv)} y2={y(gv)} className="text-white/10" stroke="currentColor" strokeWidth="1" />
          <text x={4} y={y(gv) + 3} fontSize="10" className="fill-white/40">{fmtP(gv)}</text>
        </g>
      ))}

      {/* sveće */}
      {data.map((d, i) => {
        const up = d.close >= d.open;
        const cx = x(i);
        const half = candleW / 2;
        const openY = y(d.open), closeY = y(d.close);
        const highY = y(d.high), lowY = y(d.low);
        const top = Math.min(openY, closeY), bottom = Math.max(openY, closeY);
        return (
          <g key={d.time}>
            {/* wick */}
            <line x1={cx} x2={cx} y1={highY} y2={lowY}
              className={up ? "text-emerald-400" : "text-rose-400"}
              stroke="currentColor" strokeWidth="1" />
            {/* body */}
            <rect x={cx - half} y={top} width={candleW} height={Math.max(1, bottom - top)}
              className={up ? "fill-emerald-400/70" : "fill-rose-400/70"} stroke="none" />
          </g>
        );
      })}

      {/* entry/tp/sl linije */}
      {Number.isFinite(entry) && (
        <g>
          <line x1={L} x2={W - R} y1={y(entry)} y2={y(entry)} className="text-emerald-300" stroke="currentColor" strokeDasharray="4 3" strokeWidth="1.5" />
          <text x={W - R - 2} y={y(entry) - 4} textAnchor="end" fontSize="10" className="fill-emerald-300">Entry</text>
        </g>
      )}
      {Number.isFinite(tp) && (
        <g>
          <line x1={L} x2={W - R} y1={y(tp)} y2={y(tp)} className="text-green-400" stroke="currentColor" strokeDasharray="4 3" strokeWidth="1.5" />
          <text x={W - R - 2} y={y(tp) - 4} textAnchor="end" fontSize="10" className="fill-green-400">TP</text>
        </g>
      )}
      {Number.isFinite(sl) && (
        <g>
          <line x1={L} x2={W - R} y1={y(sl)} y2={y(sl)} className="text-rose-400" stroke="currentColor" strokeDasharray="4 3" strokeWidth="1.5" />
          <text x={W - R - 2} y={y(sl) - 4} textAnchor="end" fontSize="10" className="fill-rose-400">SL</text>
        </g>
      )}
    </svg>
  );
}
