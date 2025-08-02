// pages/index.js
import React, { useMemo } from 'react';
import SignalCard from '../components/SignalCard';
import { useData } from '../contexts/DataContext';

const formatRemaining = (target) => {
  if (!target) return '—';
  const diff = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

export default function Home() {
  const {
    cryptoData,
    footballData,
    loadingCrypto,
    loadingFootball,
    errorCrypto,
    errorFootball,
    refreshAll,
    nextCryptoUpdate,
    nextFootballUpdate,
  } = useData();

  const topCrypto = useMemo(() => {
    if (!cryptoData?.cryptoTop) return [];
    return cryptoData.cryptoTop.slice(0, 3);
  }, [cryptoData]);

  const topFootball = useMemo(() => {
    if (!footballData?.footballTop) return [];
    return footballData.footballTop.slice(0, 3);
  }, [footballData]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>AI Top fudbalske i Kripto Prognoze</h1>
      </div>

      {/* Pair rows: 3 rows each with football + crypto */}
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
  );
}
