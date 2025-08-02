// pages/index.js
import React, { useEffect, useState } from 'react';
import SignalCard from '../components/SignalCard';

const fetcher = (url) => fetch(url).then((r) => r.json());

export default function Home() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/crypto');
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} - ${txt}`);
      }
      const d = await res.json();
      setData(d);
    } catch (e) {
      setError(e.message);
      setData(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 10 * 60 * 1000); // 10m refresh
    return () => clearInterval(iv);
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 8, fontSize: '0.75rem' }}>
        Ažurirano:{' '}
        {data?.generated_at ? new Date(data.generated_at).toLocaleString('sr-RS') : '—'}
      </div>

      {/* Kartica 1: Football daily predictions */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Football daily predictions</h2>
        {loading && <div>Učitavanje...</div>}
        {!loading && data && data.footballTop && data.footballTop.length > 0 && (
          <>
            {data.footballTop.map((f, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                {/* Strukturiraj kad bude real data; ovo je placeholder */}
                <div>
                  <strong>{f.match || 'Match name'}</strong> — {f.prediction || 'Type'} | Confidence:{' '}
                  {f.confidence || '—'}%
                </div>
                <div>Odds: {f.odds || '-'}</div>
              </div>
            ))}
          </>
        )}
        {!loading && (!data || !data.footballTop || data.footballTop.length === 0) && (
          <div className="small">
            Fudbal još nije konfigurisan. Pošalji mi tačne izvore (endpoint/sample response i pravila
            konsenzusa) da odmah ubacim realne daily predikcije (top 3).  
          </div>
        )}
      </div>

      {/* Kartica 2: Crypto top 3 signals */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Crypto top 3 signals</h2>
        {loading && <div>Učitavanje...</div>}
        {!loading && error && (
          <div style={{ color: 'crimson' }}>Greška: {error}</div>
        )}
        {!loading && data && data.cryptoTop && data.cryptoTop.length > 0 ? (
          data.cryptoTop.map((it) => (
            <SignalCard
              key={`${it.symbol}-${it.direction}`}
              item={{
                symbol: it.symbol,
                name: it.name,
                current_price: it.current_price,
                direction: it.direction,
                confidence: it.confidence,
                priceChangePercent: it.priceChangePercent,
                rsi: it.rsi,
                expected_range: it.expected_range,
                stop_loss: it.stop_loss,
                take_profit: it.take_profit,
                volatility: it.volatility,
                price_history_24h: it.price_history_24h,
                timeframe: 'aggregate'
              }}
            />
          ))
        ) : (
          <div className="small">Nema trenutnih jakih kripto signala.</div>
        )}
      </div>

      {/* Kartica 3: Top overall */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Top overall</h2>
        {loading && <div>Učitavanje...</div>}
        {!loading && data && data.cryptoTop && data.cryptoTop.length > 0 ? (
          data.cryptoTop.map((it) => (
            <SignalCard
              key={`overall-${it.symbol}-${it.direction}`}
              item={{
                symbol: it.symbol,
                name: it.name,
                current_price: it.current_price,
                direction: it.direction,
                confidence: it.confidence,
                priceChangePercent: it.priceChangePercent,
                rsi: it.rsi,
                expected_range: it.expected_range,
                stop_loss: it.stop_loss,
                take_profit: it.take_profit,
                volatility: it.volatility,
                price_history_24h: it.price_history_24h,
                timeframe: 'overall'
              }}
            />
          ))
        ) : (
          <div className="small">Još nema kombinovanih podataka.</div>
        )}
      </div>
    </div>
  );
}
