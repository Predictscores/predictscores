import React from 'react';

function buildQuickChartUrl(symbol, prices24h = []) {
  const labels = prices24h.map((_, i) => i);
  const data = prices24h.map((p) => Number(p.toFixed(4)));
  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: symbol,
          data,
          fill: false,
          tension: 0.3
        }
      ]
    },
    options: {
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { display: false }
      }
    }
  };
  return `https://quickchart.io/chart?width=300&height=120&c=${encodeURIComponent(
    JSON.stringify(config)
  )}`;
}

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
        <div style={{ fontSize: '0.7em', marginTop: 4 }}>Volatility: {item.volatility}%</div>
      </div>
      <div style={{ width: 320 }}>
        <img
          alt="chart"
          src={buildQuickChartUrl(item.symbol, item.price_history_24h || [])}
          style={{ width: '100%', borderRadius: 6 }}
        />
      </div>
    </div>
  );
}
