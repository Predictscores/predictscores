import React from 'react';

export default function SignalCard({ item }) {
  const isLong = item.direction === 'LONG';
  return (
    <div className="card" style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: '0.85rem' }}>
      <div style={{ flex: '1 1 220px' }}>
        <div style={{ fontWeight: 600 }}>
          {item.symbol} — {item.name} <span style={{ fontSize: '0.75em' }}>[{item.timeframe || ''}]</span>
        </div>
        <div>Price: ${item.current_price?.toFixed(4)}</div>
        <div>
          Signal:{' '}
          <span style={{ color: isLong ? 'green' : 'crimson' }}>{item.direction}</span> | Confidence:{' '}
          {item.confidence}%
        </div>
        <div>Price change: {item.priceChangePercent}%</div>
        <div>RSI: {item.rsi}</div>
        <div>Expected range: {item.expected_range}</div>
        <div>
          SL: {item.stop_loss} / TP: {item.take_profit}
        </div>
      </div>
      <div style={{ width: 320 }}>
        <img
          alt="chart"
          src={`https://quickchart.io/chart?c=${encodeURIComponent(
            JSON.stringify({
              type: 'line',
              data: {
                labels: Array(24)
                  .fill(0)
                  .map((_, i) => i),
                datasets: [
                  {
                    label: item.symbol,
                    data: Array(24)
                      .fill(item.current_price || 0)
                      .map((v, i) => v * (1 + (Math.sin(i / 3) * 0.005))),
                    fill: false,
                    tension: 0.3,
                  },
                ],
              },
              options: {
                plugins: { legend: { display: false } },
                scales: { x: { display: false } },
              },
            })
          )}`}
          style={{ width: '100%', borderRadius: 6 }}
        />
      </div>
    </div>
  );
}
