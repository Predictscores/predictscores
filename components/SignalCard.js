// FILE: components/SignalCard.jsx
import React, { useEffect, useState } from 'react';

export default function SignalCard({ data }) {
  const {
    symbol = '',
    price = 0,
    signal = '',
    confidence = 0,
    change1h = 0,
    change24h = 0,
    entryPrice = 0,
    sl = 0,
    tp = 0,
    expectedMove = 0
  } = data;

  const riskReward =
    entryPrice !== sl ? (tp - entryPrice) / Math.abs(entryPrice - sl) : null;

  const [chartUrl, setChartUrl] = useState('');

  useEffect(() => {
    async function buildChart() {
      try {
        // 24h in 15m bars
        const res = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USD&limit=96&aggregate=15`
        );
        const json = await res.json();
        let bars = json.Data?.Data || [];

        if (bars.length < 10) {
          const cgOhlc = await fetch(
            `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/ohlc?vs_currency=usd&days=1`
          ).then(r => r.json());
          bars = cgOhlc.map(([t,o,h,l,c]) => ({
            time:  t/1000,
            open:  o,
            high:  h,
            low:   l,
            close: c
          }));
        }

        const chartData = bars.map(d => ({
          x: d.time * 1000,
          o: d.open, h: d.high, l: d.low, c: d.close
        }));

        const config = {
          type: 'candlestick',
          data: {
            datasets: [{
              data: chartData,
              color: { up: '#4ade80', down: '#f87171', unchanged: '#888' }
            }]
          },
          options: {
            plugins: {
              legend: { display: false },
              annotation: {
                annotations: {
                  tpLine: {
                    type: 'line', yMin: tp, yMax: tp,
                    borderColor: 'green', borderWidth: 2, borderDash: [4,2],
                    label:{content:'TP',enabled:true,position:'end',backgroundColor:'rgba(0,255,0,0.7)',color:'#000'}
                  },
                  slLine: {
                    type: 'line', yMin: sl, yMax: sl,
                    borderColor: 'red',   borderWidth: 2, borderDash: [4,2],
                    label:{content:'SL',enabled:true,position:'end',backgroundColor:'rgba(255,0,0,0.7)',color:'#000'}
                  }
                }
              }
            },
            scales: { x:{type:'time',time:{unit:'hour'}}, y:{position:'right'}},
            layout:{padding:0}, elements:{point:{radius:0}}
          }
        };

        const encoded = encodeURIComponent(JSON.stringify(config));
        setChartUrl(
          `https://quickchart.io/chart?c=${encoded}&w=800&h=240&bkg=ffffff&version=3`
        );
      } catch {
        setChartUrl(null);
      }
    }
    buildChart();
  }, [symbol, tp, sl]);

  return (
    <div className="flex h-40 bg-[#23272f] rounded-2xl shadow overflow-hidden">
      {/* 1) INFO (≈35%) */}
      <div className="w-1/3 p-3 flex flex-col justify-center space-y-1 break-words">
        <h3 className="text-xl font-bold">{symbol}</h3>
        <div className="text-lg">Current: ${price.toFixed(4)}</div>
        <div className="text-base">
          Entry: ${entryPrice.toFixed(4)}{' '}
          <span className={signal==='LONG'?'text-green-400':'text-red-400'}>
            {signal==='LONG'?'⇧':'⇩'}
          </span>
        </div>
        <div className="text-sm flex gap-2">
          <span className="px-2 py-1 bg-green-600 rounded">TP: ${tp.toFixed(4)}</span>
          <span className="px-2 py-1 bg-red-600 rounded">SL: ${sl.toFixed(4)}</span>
        </div>
        <div className="text-sm">
          Expected: {expectedMove.toFixed(2)}%
          <span className="ml-2">
            {confidence>75?'🟢':confidence>50?'🔵':'🟡'}
          </span>
        </div>
        <div className="text-xs text-gray-400">
          1h: {change1h.toFixed(2)}% • 24h: {change24h.toFixed(2)}%
        </div>
      </div>

      {/* 2) EXTRA DETAILS (≈15%) */}
      <div className="w-1/6 p-3 border-l border-gray-700 flex flex-col justify-center items-center bg-[#1f2339] text-sm">
        <div>Signal TF: 15m, 30m, 1h, 4h</div>
        <div>R:R: {riskReward!=null?riskReward.toFixed(2):'-'}</div>
      </div>

      {/* 3) 24h Chart (≈50%) */}
      <div className="w-2/3 flex items-center justify-center bg-[#23272f]">
        {chartUrl===null
          ? <div className="w-full h-full flex items-center justify-center text-gray-500">No chart available</div>
          : <img src={chartUrl} alt={`${symbol} 24h candlestick`} className="w-full h-full object-contain" />
        }
      </div>
    </div>
  );
}
