// components/TradingViewChart.js
import React, { useEffect, useRef } from 'react';

/**
 * Candlestick grafikon za poslednjih 24h, sa dinamičkim importom Chart.js.
 * Props:
 *   - symbol: npr. 'BTC'
 *   - patternMarkers: niz objekata { time: timestamp_ms, price: number, label: string }
 */
export default function TradingViewChart({ symbol, patternMarkers = [] }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    let isMounted = true;

    async function loadChart() {
      // Dinamički importujemo Chart.js i njegove plugine
      const chartPkg      = await import('chart.js');
      const finPluginPkg  = await import('chartjs-chart-financial');
      const annPluginPkg  = await import('chartjs-plugin-annotation');

      const { Chart, registerables } = chartPkg;
      const financialPlugin          = finPluginPkg.default;
      const annotationPlugin         = annPluginPkg.default;

      // Registrujemo module
      Chart.register(...registerables);
      Chart.register(financialPlugin);
      Chart.register(annotationPlugin);

      // Mapovanje simbola na CoinGecko ID
      const idMap = {
        BTC: 'bitcoin',
        ETH: 'ethereum',
        LTC: 'litecoin',
        // po potrebi dodaj ostale
      };
      const id = idMap[symbol] || symbol.toLowerCase();

      // Povlačenje OHLC za poslednjih 24h
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`
      );
      const raw = await res.json();
      // raw: [[timestamp, open, high, low, close], ...]
      const data = raw.map(d => ({
        x: d[0],
        o: d[1],
        h: d[2],
        l: d[3],
        c: d[4]
      }));

      if (!isMounted) return;

      const ctx = canvasRef.current.getContext('2d');
      if (chartRef.current) chartRef.current.destroy();

      chartRef.current = new Chart(ctx, {
        type: 'candlestick',
        data: {
          datasets: [{
            label: symbol,
            data
          }]
        },
        options: {
          plugins: {
            legend: { display: false },
            annotation: {
              annotations: patternMarkers.map((pm, idx) => ({
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

    if (typeof window !== 'undefined') {
      loadChart();
    }

    return () => {
      isMounted = false;
      if (chartRef.current) chartRef.current.destroy();
    };
  }, [symbol, patternMarkers]);

  return <canvas ref={canvasRef} className="w-full h-24" />;
}
