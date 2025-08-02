// pages/index.js
import React, { useState, useMemo } from 'react';
import SignalCard from '../components/SignalCard';
import { useData } from '../contexts/DataContext';

const tabLabels = {
  combined: 'Combined',
  football: 'Football',
  crypto: 'Crypto',
};

export default function Home() {
  const [activeTab, setActiveTab] = useState('combined');
  const {
    cryptoData,
    footballData,
    loadingCrypto,
    loadingFootball,
    errorCrypto,
    errorFootball,
  } = useData();

  const topCryptoCombined = useMemo(() => {
    if (!cryptoData?.cryptoTop) return [];
    return cryptoData.cryptoTop.slice(0, 3);
  }, [cryptoData]);

  const topFootballCombined = useMemo(() => {
    if (!footballData?.footballTop) return [];
    return footballData.footballTop.slice(0, 3);
  }, [footballData]);

  return (
    <div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        {Object.entries(tabLabels).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`tab-btn ${activeTab === key ? 'active' : ''}`}
            style={{
              padding: '8px 16px',
              cursor: 'pointer',
              fontWeight: 600,
              background: 'transparent',
              border: 'none',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Combined */}
      {activeTab === 'combined' && (
        <div style={{ display: 'flex', gap: 16 }}>
          {/* Football left 30% */}
          <div style={{ flex: '0 0 30%' }}>
            <h2 style={{ marginTop: 0 }}>Football top 3</h2>
            {loadingFootball && <div className="card">Učitavanje fudbalskih predikcija...</div>}
            {!loadingFootball && errorFootball && (
              <div className="card" style={{ color: 'crimson' }}>
                Greška: {errorFootball}
              </div>
            )}
            {!loadingFootball &&
              (!footballData?.footballTop || footballData.footballTop.length === 0) && (
                <div className="card small">
                  Nema fudbalskih predikcija. Pošalji izvore i konsenzus pravila da ubacim realne top 3.
                </div>
              )}
            {!loadingFootball &&
              footballData?.footballTop &&
              footballData.footballTop.slice(0, 3).map((f, i) => (
                <div className="card" key={`combined-football-${i}`} style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 600 }}>
                    {f.match || 'Match'} — {f.prediction || 'Type'}
                  </div>
                  <div>Confidence: {f.confidence || '—'}%</div>
                  <div>Odds: {f.odds || '-'}</div>
                  <div className="small">{f.note || ''}</div>
                </div>
              ))}
          </div>

          {/* Crypto right 70% */}
          <div style={{ flex: '1 1 70%' }}>
            <h2 style={{ marginTop: 0 }}>Crypto top 3</h2>
            {loadingCrypto && <div className="card">Učitavanje kripto signala...</div>}
            {!loadingCrypto && errorCrypto && (
              <div className="card" style={{ color: 'crimson' }}>
                Greška: {errorCrypto}
              </div>
            )}
            {!loadingCrypto && topCryptoCombined.length === 0 && (
              <div className="card small">Nema jakih kripto signala.</div>
            )}
            {!loadingCrypto &&
              topCryptoCombined.map((it) => (
                <SignalCard
                  key={`combined-crypto-${it.symbol}`}
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
                    timeframe: 'combined',
                  }}
                />
              ))}
          </div>
        </div>
      )}

      {/* Football only */}
      {activeTab === 'football' && (
        <div>
          <h2 style={{ marginTop: 0 }}>Football daily predictions</h2>
          {loadingFootball && <div className="card">Učitavanje fudbalskih predikcija...</div>}
          {!loadingFootball && errorFootball && (
            <div className="card" style={{ color: 'crimson' }}>
              Greška: {errorFootball}
            </div>
          )}
          {!loadingFootball &&
            (!footballData?.footballTop || footballData.footballTop.length === 0) && (
              <div className="card small">
                Fudbal još nije konfigurisan. Pošalji mi izvore + konsenzus da napravim realne top 10.
              </div>
            )}
          {!loadingFootball &&
            footballData?.footballTop &&
            footballData.footballTop.map((f, i) => (
              <div className="card" key={`football-only-${i}`} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600 }}>
                  {f.match || 'Match'} — {f.prediction || 'Type'}
                </div>
                <div>Confidence: {f.confidence || '—'}%</div>
                <div>Odds: {f.odds || '-'}</div>
                <div className="small">{f.note || ''}</div>
              </div>
            ))}
        </div>
      )}

      {/* Crypto only */}
      {activeTab === 'crypto' && (
        <div>
          <h2 style={{ marginTop: 0 }}>Crypto signals (top 10+)</h2>
          {loadingCrypto && <div className="card">Učitavanje kripto signala...</div>}
          {!loadingCrypto && errorCrypto && (
            <div className="card" style={{ color: 'crimson' }}>
              Greška: {errorCrypto}
            </div>
          )}
          {!loadingCrypto && (!cryptoData?.cryptoTop || cryptoData.cryptoTop.length === 0) && (
            <div className="card small">Nema trenutno jakih kripto signala.</div>
          )}
          {!loadingCrypto &&
            cryptoData?.cryptoTop &&
            cryptoData.cryptoTop.map((it, i) => (
              <SignalCard
                key={`crypto-only-${i}-${it.symbol}`}
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
                  timeframe: 'crypto',
                }}
              />
            ))}
        </div>
      )}
    </div>
  );
}
