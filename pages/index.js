// pages/index.js
import React, { useState, useMemo } from 'react';
import SignalCard from '../components/SignalCard';
import { useData } from '../contexts/DataContext';

export default function Home() {
  const [activeTab, setActiveTab] = useState('combined'); // combined / football / crypto
  const {
    cryptoData,
    footballData,
    loadingCrypto,
    loadingFootball,
    errorCrypto,
    errorFootball,
  } = useData();

  const topCrypto3 = useMemo(() => {
    if (!cryptoData?.cryptoTop) return [];
    return cryptoData.cryptoTop.slice(0, 3);
  }, [cryptoData]);

  const topCryptoAll = useMemo(() => {
    return cryptoData?.cryptoTop || [];
  }, [cryptoData]);

  const topFootball3 = useMemo(() => {
    if (!footballData?.footballTop) return [];
    return footballData.footballTop.slice(0, 3);
  }, [footballData]);

  return (
    <div>
      {/* Title */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>AI Top fudbalske i Kripto Prognoze</h1>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        {['combined', 'football', 'crypto'].map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`tab-btn ${activeTab === t ? 'active' : ''}`}
            style={{
              padding: '8px 16px',
              cursor: 'pointer',
              fontWeight: 600,
              background: 'transparent',
              border: 'none',
            }}
          >
            {t === 'combined' ? 'Combined' : t === 'football' ? 'Football' : 'Crypto'}
          </button>
        ))}
      </div>

      {/* Combined */}
      {activeTab === 'combined' && (
        <div>
          {/* Pair rows: 3 pairs football + crypto */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                  alignItems: 'flex-start',
                }}
              >
                {/* Football side (30%) */}
                <div style={{ flex: '0 0 30%', minWidth: 260 }}>
                  {i === 0 && <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Football top 3</h2>}
                  {loadingFootball && i === 0 && <div className="card">Učitavanje fudbalskih predikcija...</div>}
                  {!loadingFootball && errorFootball && i === 0 && (
                    <div className="card" style={{ color: 'crimson' }}>
                      Greška: {errorFootball}
                    </div>
                  )}
                  {!loadingFootball && (!footballData?.footballTop || footballData.footballTop.length === 0) && (
                    <div className="card small">
                      Nema fudbalskih predikcija. Pošalji izvore + konsenzus pravila da ubacim realne top 3.
                    </div>
                  )}
                  {!loadingFootball && footballData?.footballTop && footballData.footballTop[i] && (
                    <SignalCard item={footballData.footballTop[i]} isFootball />
                  )}
                </div>

                {/* Crypto side (70%) */}
                <div style={{ flex: '1 1 70%', minWidth: 320 }}>
                  {i === 0 && <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Crypto top 3</h2>}
                  {loadingCrypto && i === 0 && <div className="card">Učitavanje kripto signala...</div>}
                  {!loadingCrypto && errorCrypto && i === 0 && (
                    <div className="card" style={{ color: 'crimson' }}>
                      Greška: {errorCrypto}
                    </div>
                  )}
                  {!loadingCrypto && cryptoData?.cryptoTop && cryptoData.cryptoTop[i] && (
                    <SignalCard item={cryptoData.cryptoTop[i]} />
                  )}
                  {!loadingCrypto && (!cryptoData?.cryptoTop || !cryptoData.cryptoTop[i]) && i === 0 && (
                    <div className="card small">Nema jakih kripto signala.</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Football only */}
      {activeTab === 'football' && (
        <div>
          <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Football top 3</h2>
          {loadingFootball && <div className="card">Učitavanje fudbalskih predikcija...</div>}
          {!loadingFootball && errorFootball && (
            <div className="card" style={{ color: 'crimson' }}>
              Greška: {errorFootball}
            </div>
          )}
          {!loadingFootball && (!footballData?.footballTop || footballData.footballTop.length === 0) && (
            <div className="card small">
              Nema fudbalskih predikcija. Pošalji izvore + konsenzus pravila da ubacim realne top 3.
            </div>
          )}
          {!loadingFootball &&
            footballData?.footballTop &&
            footballData.footballTop.map((f, i) => (
              <SignalCard key={`football-only-${i}`} item={f} isFootball />
            ))}
        </div>
      )}

      {/* Crypto only */}
      {activeTab === 'crypto' && (
        <div>
          <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Crypto signals</h2>
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
            topCryptoAll.map((it, i) => (
              <SignalCard key={`crypto-only-${i}-${it.symbol}`} item={it} />
            ))}
        </div>
      )}
    </div>
  );
}
