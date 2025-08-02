// pages/index.js
import React, { useEffect, useState, useMemo } from 'react';
import SignalCard from '../components/SignalCard';

const fetcher = (url) => fetch(url).then((r) => r.json());

const formatRemaining = (target) => {
  if (!target) return '—';
  const diff = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

export default function Home() {
  const [activeTab, setActiveTab] = useState('combined'); // combined / football / crypto

  const [cryptoData, setCryptoData] = useState(null);
  const [footballData, setFootballData] = useState(null);
  const [loadingCrypto, setLoadingCrypto] = useState(true);
  const [loadingFootball, setLoadingFootball] = useState(true);
  const [errorCrypto, setErrorCrypto] = useState(null);
  const [errorFootball, setErrorFootball] = useState(null);

  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null);
  const [nextFootballUpdate, setNextFootballUpdate] = useState(null);

  const CRYPTO_INTERVAL = 10 * 60 * 1000;
  const FOOTBALL_INTERVAL = 30 * 60 * 1000;

  const loadCrypto = async () => {
    setLoadingCrypto(true);
    setErrorCrypto(null);
    try {
      const res = await fetch('/api/crypto');
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} - ${txt}`);
      }
      const d = await res.json();
      setCryptoData(d);
      setNextCryptoUpdate(Date.now() + CRYPTO_INTERVAL);
    } catch (e) {
      setErrorCrypto(e.message);
    } finally {
      setLoadingCrypto(false);
    }
  };

  const loadFootball = async () => {
    setLoadingFootball(true);
    setErrorFootball(null);
    try {
      const res = await fetch('/api/football');
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} - ${txt}`);
      }
      const d = await res.json();
      setFootballData(d);
      setNextFootballUpdate(Date.now() + FOOTBALL_INTERVAL);
    } catch (e) {
      setErrorFootball(e.message);
    } finally {
      setLoadingFootball(false);
    }
  };

  useEffect(() => {
    loadCrypto();
    loadFootball();
    const ivCrypto = setInterval(loadCrypto, CRYPTO_INTERVAL);
    const ivFootball = setInterval(loadFootball, FOOTBALL_INTERVAL);
    return () => {
      clearInterval(ivCrypto);
      clearInterval(ivFootball);
    };
  }, []);

  // Combined top 3 crypto + top 3 football (displayed separately)
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
              border: 'none'
            }}
          >
            {t === 'combined' ? 'Combined' : t === 'football' ? 'Football' : 'Crypto'}
          </button>
        ))}
      </div>

      {/* Refresh / countdown */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <div>
          <button
            onClick={() => {
              loadCrypto();
              loadFootball();
            }}
            style={{ padding: '6px 12px', cursor: 'pointer', marginRight: 8 }}
          >
            Refresh all
          </button>
          <button onClick={loadCrypto} style={{ padding: '6px 12px', cursor: 'pointer', marginRight: 8 }}>
            Refresh Crypto
          </button>
          <button onClick={loadFootball} style={{ padding: '6px 12px', cursor: 'pointer' }}>
            Refresh Football
          </button>
        </div>
        <div className="small">
          Crypto in: <strong>{formatRemaining(nextCryptoUpdate)}</strong>
        </div>
        <div className="small">
          Football in: <strong>{formatRemaining(nextFootballUpdate)}</strong>
        </div>
      </div>

      <div style={{ marginBottom: 8, fontSize: '0.75rem' }}>
        Crypto last fetched:{' '}
        {cryptoData?.generated_at ? new Date(cryptoData.generated_at).toLocaleString('sr-RS') : '—'} | Football
        last fetched:{' '}
        {footballData?.generated_at ? new Date(footballData.generated_at).toLocaleString('sr-RS') : '—'}
      </div>

      {/* Combined tab */}
      {activeTab === 'combined' && (
        <div>
          <h2 style={{ marginTop: 0 }}>Combined — top 3 crypto & top 3 football</h2>

          <div>
            <h3>Crypto top 3</h3>
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
                    timeframe: 'combined'
                  }}
                />
              ))}
          </div>

          <div style={{ marginTop: 24 }}>
            <h3>Football top 3</h3>
            {loadingFootball && <div className="card">Učitavanje fudbalskih predikcija...</div>}
            {!loadingFootball && errorFootball && (
              <div className="card" style={{ color: 'crimson' }}>
                Greška: {errorFootball}
              </div>
            )}
            {!loadingFootball && (!footballData?.footballTop || footballData.footballTop.length === 0) && (
              <div className="card small">
                Nema fudbalskih predikcija. Pošalji mi izvore i pravila konsenzusa da ubacim realne top 3.
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
        </div>
      )}

      {/* Football tab */}
      {activeTab === 'football' && (
        <div>
          <h2 style={{ marginTop: 0 }}>Football daily predictions</h2>
          {loadingFootball && <div className="card">Učitavanje fudbalskih predikcija...</div>}
          {!loadingFootball && errorFootball && (
            <div className="card" style={{ color: 'crimson' }}>
              Greška: {errorFootball}
            </div>
          )}
          {!loadingFootball && (!footballData?.footballTop || footballData.footballTop.length === 0) && (
            <div className="card small">
              Fudbal još nije konfigurisan. Pošalji mi konkretne izvore (endpoint + sample response + konsenzus
              pravila) da napravim `/api/football.js` i ubacim top predikcije.
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

      {/* Crypto tab */}
      {activeTab === 'crypto' && (
        <div>
          <h2 style={{ marginTop: 0 }}>Crypto signals (top by confidence)</h2>
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
                  timeframe: 'crypto'
                }}
              />
            ))}
        </div>
      )}
    </div>
  );
}
