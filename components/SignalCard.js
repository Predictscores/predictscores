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

  // Determine level
  const getConfidenceLevel = (val) => {
    if (typeof val !== 'number') return 'unknown';
    if (val > 90) return 'explosive';
    if (val >= 80) return 'high';
    if (val >= 55) return 'moderate';
    return 'low';
  };

  const level = getConfidenceLevel(confidence);

  // Color mapping
  const barColor = {
    low: 'bg-yellow-400',
    moderate: 'bg-blue-400',
    high: 'bg-green-400',
    explosive: 'bg-gradient-to-b from-orange-400 to-red-500',
    unknown: 'bg-gray-500',
  }[level];

  const badgeBg = {
    low: 'bg-yellow-400',
    moderate: 'bg-blue-400',
    high: 'bg-green-400',
    explosive: 'bg-gradient-to-r from-orange-400 to-red-500',
    unknown: 'bg-gray-500',
  }[level];

  const levelLabel = {
    low: 'Low',
    moderate: 'Moderate',
    high: 'High',
    explosive: '🔥 Explosive',
    unknown: 'Unknown',
  }[level];

  return (
    <div
      className={`relative flex w-full rounded-2xl bg-[#1f2339] text-white shadow-md p-6 flex-col md:flex-row gap-6 signal-card-hover`}
    >
      {/* Vertical bar indicator */}
      <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl">
        <div
          className={`h-full ${barColor} ${
            level === 'explosive' ? 'opacity-90' : ''
          }`}
          style={level === 'explosive' ? { boxShadow: '0 0 12px 2px rgba(255,99,0,0.8)' } : {}}
        />
      </div>

      {/* Info */}
      <div className="flex-1 flex flex-col justify-between pl-3">
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
            <div
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1 rounded-full ${
                level === 'explosive' ? 'pulse-fire' : ''
              }`}
              style={
                level === 'explosive'
                  ? {
                      background:
                        'linear-gradient(135deg, rgba(251,146,60,1) 0%, rgba(239,68,68,1) 100%)',
                      color: 'white',
                    }
                  : {}
              }
            >
              {level === 'explosive' ? (
                <span className="mr-1">🔥</span>
              ) : null}
              <span>
                {confidence}%
                <span className="ml-1 text-gray-300">
                  {level === 'explosive'
                    ? ''
                    : levelLabel[level] && ` ${levelLabel[level]}`}
                </span>
              </span>
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
