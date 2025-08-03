// FILE: components/SignalCard.js

import React from 'react';

const SignalCard = ({ data, type }) => {
  if (!data) return null;

  const {
    symbol,
    name,
    direction,
    confidence,
    expected_range,
    stop_loss,
    take_profit,
    current_price,
    odds,
    prediction,
    note,
    price_history_24h,
    timeframe,
  } = data;

  // Badge klasa prema confidence-u
  let badgeClass = 'badge ';
  if (confidence >= 85) badgeClass += 'badge-high';
  else if (confidence >= 55) badgeClass += 'badge-moderate';
  else badgeClass += 'badge-low';

  // Chart preko QuickChart (png)
  const chartUrl = price_history_24h
    ? `https://quickchart.io/chart?width=340&height=70&c=${encodeURIComponent(JSON.stringify({
        type: 'line',
        data: {
          labels: price_history_24h.map((_, i) => i),
          datasets: [
            {
              label: symbol,
              data: price_history_24h.slice(-288),
              borderColor: '#2563eb',
              fill: false,
            },
          ],
        },
        options: {
          scales: { x: { display: false }, y: { display: false } },
          elements: { point: { radius: 0 } },
          plugins: { legend: { display: false } },
        },
      }))}`
    : null;

  return (
    <div className="bg-card rounded p-4 text-card-foreground" style={{ minWidth: 290, maxWidth: 390, flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 17 }}>
            {name || symbol}
            {timeframe && <span style={{ fontSize: 13, color: '#b0b3b8', marginLeft: 4 }}>[{timeframe}]</span>}
          </div>
        </div>
        <span className={badgeClass}>{confidence}%</span>
      </div>
      <div style={{ fontSize: 15, marginBottom: 7 }}>
        {type === 'crypto' && <span><b>Signal:</b> {direction}<br /></span>}
        {type === 'football' && <span><b>Pick:</b> {prediction}<br /></span>}
        {odds && <span><b>Odds:</b> {odds}<br /></span>}
      </div>
      {note && <div className="text-muted-foreground" style={{ fontSize: 14, fontStyle: 'italic', marginBottom: 8 }}>{note}</div>}
      {type === 'crypto' && (
        <div style={{ fontSize: 14, marginBottom: 6 }}>
          <span><b>Range:</b> {expected_range} &nbsp; <b>SL:</b> {stop_loss} &nbsp; <b>TP:</b> {take_profit}</span><br />
          <span><b>Price:</b> ${current_price}</span>
        </div>
      )}
      {chartUrl && (
        <img src={chartUrl} alt="Chart" style={{ width: '100%', height: 68, borderRadius: 7, marginTop: 7, background: "#18191c" }} />
      )}
    </div>
  );
};

export default SignalCard;
