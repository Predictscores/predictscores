// components/TradingViewChart.js
import React, { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import 'chartjs-chart-financial';
import annotationPlugin from 'chartjs-plugin-annotation';

Chart.register(...registerables, annotationPlugin);

/**
 * Candlestick grafikon za poslednjih 24h.
 * Props:
 *   - symbol: npr. 'BTC'
 *   - patternMarkers: niz objekata { time: timestamp_ms, price: number, label: string }
 */
export default function TradingViewChart({ symbol, patternMarkers = [] }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');

    async function loadData() {
      // mapovanje simbola na CoinGecko ID
      const idMap = {
        BTC: 'bitcoin',
        ETH: 'ethereum',
        LTC: 'litecoin',
        // po potrebi dodaj ostale
      };
      const id = idMap[symbol] || symbol.toLowerCase();

      // povlačimo OHLC za 1 dan
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`
      );
      const data = await res.json();
      // data: [[timestamp, open, high, low, close], ...]
      const chartData = data.map(d => ({
        x: d[0],
        o: d[1],
        h: d[2],
        l: d[3],
        c: d[4],
      }));

      // uništi stari chart ako postoji
      if (chartRef.current) chartRef.current.destroy();

      chartRef.current = new Chart(ctx, {
        type: 'candlestick',
        data: {
          datasets: [{
            label: symbol,
            data: chartData,
          }]
        },
        options: {
          plugins: {
            legend: { display: false },
            annotation: {
              annotations: patternMarkers.map((pm, i) => ({
                type: 'label',
                xValue: pm.time,
                yValue: pm.price,
                backgroundColor: 'rgba(255,255,255,0.8)',
                content: [pm.label],
                font: { size: 10 },
                position: 'center'
              }))
            }
          },
          scales: {
            x: { type: 'time', time: { unit: 'hour' } },
            y: { position: 'right' }
          }
        }
      });
    }

    loadData();
    return () => {
      if (chartRef.current) chartRef.current.destroy();
    };
  }, [symbol, patternMarkers]);

  return <canvas ref={canvasRef} className="w-full h-24" />;
}
