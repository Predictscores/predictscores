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
    timeframe,
  } = data;

  const getConfidenceColor = (val) => {
    if (typeof val !== 'number') return 'bg-gray-500';
    if (val >= 85) return 'bg-green-400';
    if (val >= 55) return 'bg-blue-400';
    return 'bg-yellow-300';
  };

  return (
    <div className="flex w-full rounded-2xl bg-[#1f2339] text-white shadow-md p-6 flex-col md:flex-row gap-6">
      {/* Info */}
      <div className="flex-1 flex flex-col justify-between">
        <div className="flex items-start gap-2 mb-2 flex-wrap">
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-bold truncate">
              {name || symbol}{' '}
              {timeframe && (
                <span className="text-xs font-normal text-gray-300">
                  [{timeframe}]
                </span>
              )}
            </h3>
          </div>
          {typeof confidence === 'number' && (
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${getConfidenceColor(
                  confidence
                )}`}
              />
              <div className="text-xs font-semibold">
                {confidence}%{' '}
                <span className="text-gray-400">
                  {confidence >= 85
                    ? 'High'
                    : confidence >= 55
                    ? 'Moderate'
                    : 'Low'}
                </span>
              </div>
            </div>
          )}
        </div>

        {type === 'football' && (
          <div className="flex flex-col gap-1 text-sm">
            <div>
              <span className="font-semibold">Pick:</span> {prediction || '—'}
            </div>
            {odds && (
              <div>
                <span className="font-semibold">Odds:</span> {odds}
              </div>
            )}
            {note && (
              <div className="text-xs italic text-gray-400 mt-1">{note}</div>
            )}
          </div>
        )}

        {type === 'crypto' && (
          <div className="flex flex-col gap-2 text-sm">
            <div>
              <span className="font-semibold">Signal:</span> {direction || '—'}
            </div>
            <div className="flex flex-wrap gap-4">
              <div>
                <span className="font-semibold">Range:</span>{' '}
                {expected_range || '—'}
              </div>
              <div>
                <span className="font-semibold">SL:</span>{' '}
                {stop_loss ?? '—'}
              </div>
              <div>
                <span className="font-semibold">TP:</span>{' '}
                {take_profit ?? '—'}
              </div>
            </div>
            <div>
              <span className="font-semibold">Price:</span>{' '}
              {current_price != null ? `$${current_price}` : '—'}
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      {type === 'crypto' && (
        <div className="flex-shrink-0 w-full md:w-[380px]">
          <div className="w-full rounded-xl overflow-hidden">
            <iframe
              title="TradingView Chart"
              src={`https://s.tradingview.com/widgetembed/?symbol=${(symbol || '')
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')}USDT&interval=15&theme=dark&style=1&timezone=Etc/UTC&studies=[]&hide_side_toolbar=true&hide_legend=true&withdateranges=false&saveimage=false&hideideas=true&toolbar_bg=2c2d3e&locale=en`}
              width="100%"
              height="140"
              frameBorder="0"
              allowTransparency={true}
              style={{ borderRadius: 12, border: 0 }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default SignalCard;
