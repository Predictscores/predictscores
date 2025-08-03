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

  const confidenceColor =
    confidence >= 85
      ? 'bg-green-500'
      : confidence >= 55
      ? 'bg-blue-500'
      : 'bg-yellow-400';

  return (
    <div className="flex w-full rounded-xl bg-[#f5f6fa] dark:bg-[#23272f] text-[#222] dark:text-gray-100 shadow-lg p-6 min-h-[180px] items-stretch">
      {/* Info – left side */}
      <div className="flex-1 flex flex-col justify-between pr-6">
        <div className="flex items-center mb-1">
          <h3 className="text-lg font-bold mr-2">
            {name || symbol}{' '}
            {timeframe && (
              <span className="text-xs font-normal text-gray-400">
                [{timeframe}]
              </span>
            )}
          </h3>
          {/* Confidence badge */}
          <span
            className={`${confidenceColor} text-white text-xs font-bold px-3 py-1 rounded-full ml-auto`}
          >
            {confidence}%
          </span>
        </div>
        {/* Football */}
        {type === 'football' && (
          <>
            <p>
              <span className="font-bold">Pick:</span> {prediction}
            </p>
            {odds && (
              <p>
                <span className="font-bold">Odds:</span> {odds}
              </p>
            )}
            {note && (
              <p className="text-xs italic text-gray-500 mt-2">{note}</p>
            )}
          </>
        )}

        {/* Crypto */}
        {type === 'crypto' && (
          <div className="flex flex-col gap-1 text-base">
            <p>
              <span className="font-bold">Signal:</span> {direction}
            </p>
            <div className="flex gap-4 flex-wrap">
              <span>
                <span className="font-bold">Range:</span> {expected_range}
              </span>
              <span>
                <span className="font-bold">SL:</span> {stop_loss}
              </span>
              <span>
                <span className="font-bold">TP:</span> {take_profit}
              </span>
            </div>
            <span>
              <span className="font-bold">Price:</span> ${current_price}
            </span>
          </div>
        )}
      </div>
      {/* Chart – right side (for crypto only) */}
      {type === 'crypto' && (
        <div className="flex items-center min-w-[340px] max-w-[400px] ml-auto">
          {/* TradingView widget */}
          <iframe
            title="TradingView Chart"
            src={`https://s.tradingview.com/widgetembed/?symbol=${symbol?.toUpperCase()}USDT&interval=15&theme=dark&style=1&timezone=Etc/UTC&studies=[]&hide_side_toolbar=true&hide_legend=true&withdateranges=false&saveimage=false&hideideas=true&toolbar_bg=2c2d3e&locale=en`}
            width="380"
            height="120"
            frameBorder="0"
            allowTransparency={true}
            style={{ borderRadius: 12, border: 0, minWidth: 340 }}
          />
        </div>
      )}
    </div>
  );
};

export default SignalCard;
