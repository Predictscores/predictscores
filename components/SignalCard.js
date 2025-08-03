// FILE: components/SignalCard.js

import React from 'react';
import QuickChart from 'quickchart-js';

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

  const chartUrl = price_history_24h
    ? new QuickChart()
        .setConfig({
          type: 'line',
          data: {
            labels: price_history_24h.map((_, i) => i),
            datasets: [
              {
                label: symbol,
                data: price_history_24h.slice(-288),
                borderColor: '#3b82f6',
                fill: false,
              },
            ],
          },
          options: {
            scales: { x: { display: false }, y: { display: false } },
            elements: { point: { radius: 0 } },
            plugins: { legend: { display: false } },
          },
        })
        .setWidth(300)
        .setHeight(100)
        .getUrl()
    : null;

  const confidenceColor =
    confidence >= 85 ? 'text-green-500' : confidence >= 55 ? 'text-blue-500' : 'text-yellow-500';

  return (
    <div className="border rounded p-4 w-full bg-card text-card-foreground">
      <div className="flex justify-between items-center mb-2">
        <div>
          <h3 className="text-lg font-semibold">
            {name || symbol}{' '}
            {timeframe && <span className="text-xs text-muted-foreground">[{timeframe}]</span>}
          </h3>
          <p className={`text-sm ${confidenceColor}`}>Confidence: {confidence}%</p>
        </div>
        <div className="text-right text-sm">
          {type === 'crypto' && <p>Signal: {direction}</p>}
          {type === 'football' && <p>{prediction}</p>}
          {odds && <p>Odds: {odds}</p>}
        </div>
      </div>

      {note && <p className="text-sm italic text-muted-foreground mb-2">{note}</p>}

      {type === 'crypto' && (
        <div className="grid grid-cols-2 gap-1 text-sm mb-2">
          <p>Range: {expected_range}</p>
          <p>SL: {stop_loss}</p>
          <p>TP: {take_profit}</p>
          <p>Price: ${current_price}</p>
        </div>
      )}

      <div className="my-2 border-t border-muted w-full"></div>

      {chartUrl && (
        <img
          src={chartUrl}
          alt="Chart"
          className="w-full h-auto rounded shadow-sm"
        />
      )}
    </div>
  );
};

export default SignalCard;
