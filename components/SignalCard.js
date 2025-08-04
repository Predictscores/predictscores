// FILE: components/SignalCard.jsx
// Revised SignalCard: football više ne koristi justify-between (ne pravi ogroman gap),
// crypto i crossover konsenzus ostaju, vizuelno čišće, side bar za confidence.

import React from 'react';

// consensus between trend and crossover
const computeConsensus = (trend, crossover) => {
  if (!trend || !crossover) return null;
  if (trend.direction === crossover.direction) {
    let avg = (trend.confidence + crossover.confidence) / 2;
    if (trend.confidence >= 80 && crossover.confidence >= 80) avg += 5;
    return Math.min(100, Math.round(avg));
  }
  return Math.round(Math.min(trend.confidence, crossover.confidence) * 0.7);
};

const Badge = ({ children, className = '' }) => (
  <div
    className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold ${className}`}
  >
    {children}
  </div>
);

const ConfidenceBadge = ({ confidence }) => {
  if (confidence > 90) {
    return (
      <Badge className="bg-gradient-to-r from-red-500 to-yellow-400 text-white">
        🔥 Bomba {confidence}%
      </Badge>
    );
  }
  if (confidence >= 80) {
    return <Badge className="bg-green-600 text-white">High {confidence}%</Badge>;
  }
  if (confidence >= 55) {
    return <Badge className="bg-yellow-500 text-black">Moderate {confidence}%</Badge>;
  }
  return <Badge className="bg-gray-600 text-white">Low {confidence}%</Badge>;
};

const DirectionBadge = ({ direction }) => {
  if (direction === 'LONG') {
    return (
      <div className="text-green-300 font-bold flex items-center gap-1">
        ▲ LONG
      </div>
    );
  }
  if (direction === 'SHORT') {
    return (
      <div className="text-red-300 font-bold flex items-center gap-1">
        ▼ SHORT
      </div>
    );
  }
  return (
    <div className="text-gray-300 font-semibold flex items-center gap-1">
      {direction}
    </div>
  );
};

const Sparkline = ({ history = [], width = 120, height = 32 }) => {
  if (!history || history.length === 0) return null;
  const slice = history.slice(-60);
  const prices = slice.map((p) => (typeof p === 'number' ? p : p));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const path = prices
    .map((price, i) => {
      const x = (i / (prices.length - 1)) * width;
      const y = height - ((price - min) / span) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label="sparkline"
      className="mt-1"
    >
      <path
        d={path}
        fill="none"
        stroke="#7c3aed"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={((prices.length - 1) / (prices.length - 1)) * width}
        cy={
          height -
          (((prices[prices.length - 1] - min) / span) * height || 0)
        }
        r="2"
        fill="#fff"
      />
    </svg>
  );
};

const FootballContent = ({ data }) => (
  <div className="flex-1 flex flex-col gap-2">
    <div className="flex items-center mb-1">
      <div className="text-lg font-bold mr-2">
        {data.name || data.predicted || 'Pick'}
      </div>
      {data.timeframe && (
        <div className="text-[10px] px-2 py-1 bg-[#222741] rounded-full">
          {data.timeframe}
        </div>
      )}
      <div className="ml-auto">
        <ConfidenceBadge confidence={data.confidence ?? 0} />
      </div>
    </div>
    <div className="text-sm">
      {data.prediction && (
        <p>
          <span className="font-bold">Pick:</span> {data.prediction}
        </p>
      )}
      {data.odds && (
        <p>
          <span className="font-bold">Odds:</span> {data.odds}
        </p>
      )}
      {data.note && (
        <p className="text-xs italic text-gray-400 mt-1">{data.note}</p>
      )}
    </div>
  </div>
);

const CryptoMetrics = ({ sig }) => {
  const trend = {
    direction: sig.direction,
    confidence: sig.confidence,
  };
  const crossover = sig.crossover || null;
  const consensus = computeConsensus(trend, crossover);
  const showConsensus = consensus != null;

  return (
    <div className="flex flex-col flex-1">
      <div className="flex justify-between items-start mb-2">
        <div className="flex gap-2 items-center flex-wrap">
          <div className="text-xl font-bold">{sig.symbol}</div>
          <div className="text-xs text-gray-400">{sig.name}</div>
          {sig.timeframe && (
            <div className="text-[10px] px-2 py-1 bg-[#222741] rounded-full">
              {sig.timeframe}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2 flex-wrap">
            <ConfidenceBadge confidence={sig.confidence} />
            {crossover && crossover.confidence != null && (
              <ConfidenceBadge confidence={crossover.confidence} />
            )}
          </div>
          {showConsensus && (
            <div>
              <Badge className="bg-blue-600 text-white text-[10px]">
                Consensus {consensus}%
              </Badge>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-4 mb-2">
        <div className="flex gap-4 flex-1 min-w-[160px]">
          <div className="flex flex-col">
            <div className="text-[10px] text-gray-400">Trend</div>
            <DirectionBadge direction={sig.direction} />
          </div>
          {sig.crossover && (
            <div className="flex flex-col">
              <div className="text-[10px] text-gray-400">Crossover</div>
              <DirectionBadge direction={sig.crossover.direction} />
            </div>
          )}
        </div>

        <div className="flex flex-col text-right min-w-[120px]">
          <div className="text-[10px] text-gray-400">Price</div>
          <div className="text-lg font-semibold">
            {sig.current_price != null
              ? `$${Number(sig.current_price).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`
              : '—'}
          </div>
        </div>
      </div>

      <div className="w-full mb-2">
        <Sparkline history={sig.price_history_24h} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] mb-2">
        <div className="bg-[#222741] rounded px-2 py-1 flex flex-col">
          <div className="font-semibold uppercase">RSI</div>
          <div>{sig.rsi != null ? sig.rsi : '—'}</div>
        </div>
        <div className="bg-[#222741] rounded px-2 py-1 flex flex-col">
          <div className="font-semibold uppercase">Δ Price</div>
          <div>
            {sig.priceChangePercent != null
              ? `${sig.priceChangePercent > 0 ? '+' : ''}${sig.priceChangePercent}%`
              : '—'}
          </div>
        </div>
        <div className="bg-[#222741] rounded px-2 py-1 flex flex-col">
          <div className="font-semibold uppercase">Volatility</div>
          <div>{sig.volatility != null ? sig.volatility : '—'}</div>
        </div>
        <div className="bg-[#222741] rounded px-2 py-1 flex flex-col">
          <div className="font-semibold uppercase">Expected</div>
          <div>{sig.expected_range}</div>
        </div>
      </div>

      {sig.crossover && (
        <div className="flex gap-4 mb-1">
          <div className="flex-1 bg-[#1f234f] rounded px-3 py-2">
            <div className="text-[10px] uppercase font-medium mb-1">
              Crossover Edge
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="font-bold">
                {sig.crossover.edge != null
                  ? `${(sig.crossover.edge * 100).toFixed(2)}%`
                  : '—'}
              </div>
              <div className="text-[11px]">
                SMA: {sig.crossover.short_ma} / {sig.crossover.long_ma}
              </div>
              <div className="text-[11px]">({sig.crossover.direction})</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const SignalCard = ({ data, type }) => {
  if (!data) return null;

  const confidence = data.confidence ?? 0;
  const trend = { direction: data.direction, confidence: data.confidence };
  const crossover = data.crossover || null;
  const consensus = computeConsensus(trend, crossover);

  return (
    <div className="flex flex-col h-full w-full rounded-2xl bg-[#1f234f] text-white shadow-lg p-6 items-stretch gap-6 relative overflow-hidden">
      {/* side accent */}
      {type === 'crypto' && (
        <div
          className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-xl ${
            confidence > 90
              ? 'bg-gradient-to-b from-red-400 to-yellow-300'
              : confidence >= 80
              ? 'bg-green-400'
              : confidence >= 55
              ? 'bg-blue-400'
              : 'bg-yellow-500'
          }`}
        />
      )}
      {type === 'football' && (
        <div
          className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-xl ${
            confidence >= 85
              ? 'bg-green-400'
              : confidence >= 55
              ? 'bg-blue-400'
              : 'bg-yellow-400'
          }`}
        />
      )}

      {/* content */}
      {type === 'football' && <FootballContent data={data} />}
      {type === 'crypto' && <CryptoMetrics sig={data} />}

      {/* chart for crypto */}
      {type === 'crypto' && (
        <div className="ml-auto flex-shrink-0 flex flex-col justify-between min-w-[340px] max-w-[420px]">
          <div className="mb-2">
            <iframe
              title={`tv-${data.symbol || 'chart'}`}
              src={`https://s.tradingview.com/widgetembed/?symbol=${(data.symbol || '')
                .toUpperCase()}USDT&interval=15&theme=dark&style=1&timezone=Etc/UTC&studies=[]&hide_side_toolbar=true&hide_legend=true&withdateranges=false&saveimage=false&hideideas=true&toolbar_bg=2c2d3e&locale=en`}
              width="100%"
              height="135"
              frameBorder="0"
              allowTransparency={true}
              style={{ borderRadius: 12, border: 0 }}
            />
          </div>
          <div className="text-[10px] text-gray-400">
            Price updated:{' '}
            {data.timestamp
              ? new Date(data.timestamp).toLocaleTimeString()
              : '—'}
          </div>
        </div>
      )}

      {/* strong consensus badge */}
      {type === 'crypto' && consensus != null && consensus > 90 && (
        <div className="absolute top-2 right-2">
          <div className="px-2 py-1 rounded bg-yellow-400 text-black text-[10px] font-bold flex items-center gap-1">
            🔥 STRONG CONSENSUS
          </div>
        </div>
      )}
    </div>
  );
};

export default SignalCard;
