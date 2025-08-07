// FILE: components/TradingViewChart.js

import React, { useRef, useEffect } from 'react';
import { Chart, registerables } from 'chart.js';
import 'chartjs-chart-financial';
import annotationPlugin from 'chartjs-plugin-annotation';

Chart.register(...registerables, annotationPlugin);

export default function TradingViewChart({ bars, entry, sl, tp }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!Array.isArray(bars) || bars.length === 0) return;
    const ctx = canvasRef.current.getContext('2d');

    // Destroy previous chart instance
    if (chartRef.current) {
      chartRef.current.destroy();
    }

    chartRef.current = new Chart(ctx, {
      type: 'candlestick',
      data: {
        datasets: [
          {
            label: 'Price',
            data: bars.map((b) => ({
              x: new Date(b.time * 1000),
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
            })),
            borderColor: '#888',
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          annotation: {
            annotations: {
              entryLine: {
                type: 'line',
                yMin: entry,
                yMax: entry,
                borderColor: '#fff',
                borderDash: [5, 5],
              },
              slLine: {
                type: 'line',
                yMin: sl,
                yMax: sl,
                borderColor: 'red',
              },
              tpLine: {
                type: 'line',
                yMin: tp,
                yMax: tp,
                borderColor: 'green',
              },
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'hour', tooltipFormat: 'MMM d, h:mm a' },
            ticks: { color: '#aaa' },
            grid: { display: false },
          },
          y: {
            ticks: { color: '#aaa' },
            grid: { color: 'rgba(255,255,255,0.1)' },
          },
        },
      },
    });
  }, [bars, entry, sl, tp]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-28" // visina ~ same as existing card
    />
  );
}
