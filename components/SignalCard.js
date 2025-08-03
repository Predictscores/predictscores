// components/SignalCard.js

import React from 'react';
import TradingViewChart from './TradingViewChart';

const SignalCard = ({ data, type, theme = "dark" }) => {
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
    timeframe,
  } = data;

  const confidenceColor =
    confidence >= 85 ? 'bg-green-500' : confidence >= 55 ? 'bg-blue-500' : 'bg-yellow-500';

  return (
    <div className="signal-card">
      <div className="signal-card-header">
        <div>
          <div className="signal-title">
            <span className="font-bold">{name || symbol}</span>
            {timeframe && <span className="signal-timeframe">[{timeframe}]</span>}
          </div>
          <div className="confidence-badge" style={{ background: confidence >= 85 ? "#22c55e" : confidence >= 55 ? "#3b82f6" : "#facc15" }}>
            {confidence}%
          </div>
        </div>
      </div>

      {type === 'football' && (
        <div className="mt-2 mb-2">
          <div><b>Pick:</b> {prediction}</div>
          {odds && <div><b>Odds:</b> {odds}</div>}
          {note && <div className="signal-note">{note}</div>}
        </div>
      )}

      {type === 'crypto' && (
        <>
          <div className="mt-2 mb-2">
            <div><b>Signal:</b> {direction}</div>
            <div><b>Range:</b> {expected_range} &nbsp; <b>SL:</b> {stop_loss} &nbsp; <b>TP:</b> {take_profit}</div>
            <div><b>Price:</b> ${current_price}</div>
          </div>
          <div className="signal-chart-wrapper">
            <TradingViewChart symbol={symbol ? symbol.toUpperCase() + "USDT" : "BTCUSDT"} theme={theme} height={120} />
          </div>
        </>
      )}
    </div>
  );
};

export default SignalCard;
