// FILE: components/TradingViewChart.js
import React, { useRef, useEffect } from 'react';
import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';
import annotationPlugin from 'chartjs-plugin-annotation';

Chart.register(...registerables, annotationPlugin);

/**
 * bars: [{ time: <unix sec>, open, high, low, close }, ...]
 * entry/sl/tp: brojevi (opcioni)
 */
export default function TradingViewChart({ bars, entry, sl, tp }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!Array.isArray(bars) || bars.length === 0) return;
    const ctx = canvasRef.current.getContext('2d');

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    // Umesto candlestick-a, crtamo line chart od close vrednosti
    const dataPoints = bars.map((b) => ({
      x: new Date(b.time * 1000),
      y: b.close
    }));

    chartRef.current = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Price (close)',
            data: dataPoints,
            borderWidth: 2,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { display: false },
          annotation: {
            annotations: {
              ...(entry != null && {
                entryLine: {
                  type: 'line',
                  yMin: entry,
                  yMax: entry,
                  borderColor: '#ffffff',
                  borderDash: [5, 5],
                  borderWidth: 1
                }
              }),
              ...(sl != null && {
                slLine: {
                  type: 'line',
                  yMin: sl,
                  yMax: sl,
                  borderColor: 'red',
                  borderWidth: 1
                }
              }),
              ...(tp != null && {
                tpLine: {
                  type: 'line',
                  yMin: tp,
                  yMax: tp,
                  borderColor: 'green',
                  borderWidth: 1
                }
              })
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'hour', tooltipFormat: 'MMM d, h:mm a' },
            ticks: { color: '#aaa' },
            grid: { display: false }
          },
          y: {
            ticks: { color: '#aaa' },
            grid: { color: 'rgba(255,255,255,0.1)' }
          }
        }
      }
    });
  }, [bars, entry, sl, tp]);

  return <canvas ref={canvasRef} className="w-full h-28" />;
}
