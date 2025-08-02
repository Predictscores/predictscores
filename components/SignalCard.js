// components/SignalCard.js
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
          tension: 0.3,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: { display: false },
      },
    },
  };
  return `https://quickchart.io/chart?width=300&height=120&c=${encodeURIComponent(
    JSON.stringify(config)
  )}`;
}

function confidenceLevel(conf) {
  if (conf >= 80) return { label: 'High', color: '#10b981' }; // green
  if (conf >= 50) return { label: 'Moderate', color: '#2563eb' }; // blue
  return { label: 'Low', color: '#d97706' }; // yellow/orange
}

export default function SignalCard({ item, isFootball }) {
  // isFootball distinguishes football card structure vs crypto
  const conf = item.confidence ?? 0;
  const { label: confLabel, color: confColor } = confidenceLevel(conf);
  return (
    <div
      className="card"
      style={{
        display: 'flex',
        gap: 16,
        marginBottom: 12,
        fontSize: '0.85rem',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {item.symbol && (
              <>
                {item.symbol} — {item.name}{' '}
                <span style={{ fontSize: '0.65em', color: '#6b7280' }}>
                  [{item.timeframe || ''}]
                </span>
              </>
            )}
            {isFootball && (
              <>
                {item.match || 'Match'} — {item.prediction || 'Type'}
              </>
            )}
          </div>
          <div
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: confColor,
              color: 'white',
              fontSize: '0.6rem',
              fontWeight: 600,
            }}
          >
            {confLabel} ({conf}%)
          </div>
        </div>
        {item.current_price !== undefined && (
          <div>Entry price: ${Number(item.current_price).toFixed(4)}</div>
        )}
        {isFootball ? (
          <>
            <div>Odds: {item.odds || '-'}</div>
            <div>Confidence raw: {conf}%</div>
            {item.note && <div className="small">{item.note}</div>}
          </>
        ) : (
          <>
            <div>
              Signal:{' '}
              <span style={{ color: item.direction === 'LONG' ? '#10b981' : '#dc2626' }}>
                {item.direction}
              </span>
            </div>
            <div>Price change (4h trend): {item.priceChangePercent}%</div>
            <div>RSI: {item.rsi}</div>
            <div>
              SL: {item.stop_loss} / TP: {item.take_profit}
            </div>
            <div className="small">Volatility: {item.volatility}%</div>
          </>
        )}
      </div>
      <div style={{ flex: '0 0 320px', minWidth: 260 }}>
        {!isFootball && (
          <img
            alt="chart"
            src={buildQuickChartUrl(item.symbol || '', item.price_history_24h || [])}
            style={{ width: '100%', borderRadius: 6 }}
          />
        )}
        {isFootball && item.extra && (
          <div className="small">{item.extra}</div>
        )}
      </div>
    </div>
  );
}
