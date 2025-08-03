// FILE: components/CryptoTopSignals.jsx

import { useEffect, useState, useRef } from 'react';

/**
 * CryptoTopSignals
 * Fetches from /api/crypto and displays the top crypto signals with:
 *  - Trend signal (direction/confidence/rsi/price change)
 *  - Crossover signal (SHORT/LONG, edge)
 *  - Consensus if both agree
 *  - "Bomba" highlight for >90% confidence
 *  - Mini sparkline for recent price history
 *
 * Props:
 *  - refreshIntervalMs: how often to refetch (default 10000)
 *  - limit: how many top coins to show (default 6)
 */
export default function CryptoTopSignals({
  refreshIntervalMs = 10000,
  limit = 6,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const fetchSignals = async () => {
    try {
      setError(null);
      const res = await fetch('/api/crypto');
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Fetch failed: ${res.status} ${txt}`);
      }
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message || 'Fetch error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSignals();
    intervalRef.current = setInterval(fetchSignals, refreshIntervalMs);
    return () => clearInterval(intervalRef.current);
  }, [refreshIntervalMs]);

  const confidenceBadge = (confidence) => {
    if (confidence > 90) {
      return (
        <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-gradient-to-r from-red-500 to-yellow-400 text-white">
          🔥 Bomba {confidence}%
        </div>
      );
    }
    if (confidence >= 80) {
      return (
        <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-green-600 text-white">
          High {confidence}%
        </div>
      );
    }
    if (confidence >= 55) {
      return (
        <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-yellow-500 text-black">
          Moderate {confidence}%
        </div>
      );
    }
    return (
      <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-gray-600 text-white">
        Low {confidence}%
      </div>
    );
  };

  const directionBadge = (direction) => {
    if (direction === 'LONG') {
      return (
        <div className="text-green-400 font-bold flex items-center gap-1">
          ▲ LONG
        </div>
      );
    }
    if (direction === 'SHORT') {
      return (
        <div className="text-red-400 font-bold flex items-center gap-1">
          ▼ SHORT
        </div>
      );
    }
    return <div className="font-bold">{direction}</div>;
  };

  const consensusScore = (trend, crossover) => {
    if (!trend || !crossover) return null;
    if (trend.direction === crossover.direction) {
      // average of confidences, boost if both strong
      const avg = (trend.confidence + crossover.confidence) / 2;
      return Math.round(
        avg + (trend.confidence >= 80 && crossover.confidence >= 80 ? 5 : 0)
      );
    }
    // disagreement penalty: lower of the two minus some
    return Math.round(Math.min(trend.confidence, crossover.confidence) * 0.75);
  };

  const sparklinePath = (history = [], width = 120, height = 30) => {
    if (!history || history.length === 0) return '';
    const slice = history.slice(-60); // last 60 points
    const prices = slice.map((p) => p);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    return prices
      .map((price, i) => {
        const x = (i / (prices.length - 1)) * width;
        const y = height - ((price - min) / span) * height;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  };

  if (loading && !data) {
    return (
      <div className="text-center text-gray-400 py-8">
        Učitavanje kripto signala...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-600 text-white p-4 rounded-md">
        Greška pri učitavanju kripto signala: {error}
      </div>
    );
  }

  const tops = data?.cryptoTop?.slice(0, limit) || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-2xl font-bold">Top Crypto Signals</h2>
        <div className="text-sm text-gray-400">
          {data?.generated_at
            ? `Updated: ${new Date(data.generated_at).toLocaleTimeString()}`
            : ''}
        </div>
      </div>

      {tops.length === 0 && (
        <div className="text-center text-gray-500">Nema dostupnih signala.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {tops.map((sig) => {
          const trend = {
            direction: sig.direction,
            confidence: sig.confidence,
          };
          const crossover = sig.crossover || null;
          const consensus = consensusScore(trend, crossover);
          const isConsensusStrong = consensus != null && consensus >= 80;
          return (
            <div
              key={sig.symbol + (sig.timeframe || '')}
              className="bg-[#1f2339] p-5 rounded-2xl shadow flex flex-col min-h-[260px]"
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex gap-2 items-center">
                  <div className="text-xl font-bold">{sig.symbol}</div>
                  <div className="text-xs text-gray-300">{sig.name}</div>
                </div>
                <div className="text-right space-y-1">
                  <div className="flex gap-1">
                    {confidenceBadge(sig.confidence)}
                  </div>
                  {consensus != null && (
                    <div className="mt-1">
                      <div className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full bg-blue-600 text-white">
                        Consensus {consensus}%
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Price & direction */}
              <div className="flex justify-between items-center mb-2">
                <div className="flex gap-4">
                  <div className="flex flex-col">
                    <div className="text-sm text-gray-300">Trend</div>
                    <div className="flex gap-2 items-center">
                      {directionBadge(trend.direction)}
                    </div>
                  </div>
                  {crossover && (
                    <div className="flex flex-col">
                      <div className="text-sm text-gray-300">Crossover</div>
                      <div className="flex gap-2 items-center">
                        {directionBadge(crossover.direction)}
                      </div>
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold">
                    {sig.current_price != null
                      ? `$${Number(sig.current_price).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}`
                      : '—'}
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {sig.timeframe && <>TF: {sig.timeframe}</>}
                  </div>
                </div>
              </div>

              {/* Sparkline */}
              <div className="mb-2">
                <svg
                  width="100%"
                  height="40"
                  viewBox="0 0 120 40"
                  className="overflow-visible"
                  aria-label="Price sparkline"
                >
                  <path
                    d={sparklinePath(sig.price_history_24h || [], 120, 40)}
                    fill="none"
                    stroke="#7c3aed"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>

              {/* Metrics row */}
              <div className="flex flex-wrap gap-2 text-[11px] mb-2">
                <div className="bg-[#252a4f] px-2 py-1 rounded flex-1 min-w-[100px]">
                  <div className="font-semibold">RSI</div>
                  <div>{sig.rsi != null ? sig.rsi : '—'}</div>
                </div>
                <div className="bg-[#252a4f] px-2 py-1 rounded flex-1 min-w-[100px]">
                  <div className="font-semibold">Price Δ</div>
                  <div>
                    {sig.priceChangePercent != null
                      ? `${sig.priceChangePercent > 0 ? '+' : ''}${sig.priceChangePercent}%`
                      : '—'}
                  </div>
                </div>
                <div className="bg-[#252a4f] px-2 py-1 rounded flex-1 min-w-[100px]">
                  <div className="font-semibold">Volatility</div>
                  <div>{sig.volatility != null ? `${sig.volatility}` : '—'}</div>
                </div>
              </div>

              {/* Edge / expected range */}
              <div className="flex flex-wrap gap-3 mt-auto">
                {crossover && (
                  <div className="flex-1 bg-[#20243f] rounded px-3 py-2">
                    <div className="text-[10px] uppercase font-medium">
                      Crossover edge
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="font-bold">
                        {crossover.edge != null
                          ? `${(crossover.edge * 100).toFixed(2)}%`
                          : '—'}
                      </div>
                      <div className="text-[10px]">
                        ({crossover.direction})
                      </div>
                    </div>
                    <div className="text-[10px]">
                      SMA: {crossover.short_ma} / {crossover.long_ma}
                    </div>
                  </div>
                )}
                <div className="flex-1 bg-[#20243f] rounded px-3 py-2">
                  <div className="text-[10px] uppercase font-medium">
                    Expected range
                  </div>
                  <div className="font-bold">{sig.expected_range}</div>
                </div>
              </div>

              <div className="mt-2 text-[10px] text-gray-500">
                Signal updated:{' '}
                {data?.generated_at
                  ? new Date(data.generated_at).toLocaleTimeString()
                  : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
