// FILE: pages/index.js

import { useContext, useState } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';

export default function Home() {
  const {
    cryptoData,
    footballData,
    refreshAll,
    nextCryptoUpdate,
    nextFootballUpdate,
  } = useContext(DataContext);

  // Tabs: 'combined' (default), 'football', 'crypto'
  const [tab, setTab] = useState('combined');

  // Helperi
  const getCountdown = (targetTime) => {
    if (!targetTime) return '--';
    const diff = targetTime - Date.now();
    if (diff <= 0) return 'Now';
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Tabovi: samo 'combined' prikazuje parove, ostali su stub
  let tabContent = null;
  if (tab === 'combined') {
    tabContent = (
      <div>
        {[0, 1, 2].map((i) => (
          <div className="card-row" key={i} style={{ marginBottom: 26, gap: 22 }}>
            {footballData?.footballTop?.[i] && (
              <SignalCard data={footballData.footballTop[i]} type="football" />
            )}
            {cryptoData?.cryptoTop?.[i] && (
              <SignalCard data={cryptoData.cryptoTop[i]} type="crypto" />
            )}
          </div>
        ))}
      </div>
    );
  } else if (tab === 'football') {
    tabContent = (
      <div>
        {footballData?.footballTop?.map((item, idx) => (
          <div style={{ marginBottom: 22 }}>
            <SignalCard key={idx} data={item} type="football" />
          </div>
        ))}
      </div>
    );
  } else if (tab === 'crypto') {
    tabContent = (
      <div>
        {cryptoData?.cryptoTop?.map((item, idx) => (
          <div style={{ marginBottom: 22 }}>
            <SignalCard key={idx} data={item} type="crypto" />
          </div>
        ))}
      </div>
    );
  }

  // Da footer bude zalepnjen za dno
  const pageStyle = {
    minHeight: '100vh',
    background: "#18191c",
    color: "#f3f4f6",
    display: 'flex',
    flexDirection: 'column'
  };

  const mainStyle = {
    maxWidth: 830,
    margin: "0 auto",
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-start',
  };

  return (
    <div style={pageStyle}>
      {/* Header i kontrole */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        margin: '38px auto 0',
        maxWidth: 830,
        width: '100%'
      }}>
        <h1 style={{
          fontSize: 36,
          fontWeight: 700,
          letterSpacing: "-1.5px",
          textAlign: 'left'
        }}>
          AI Top fudbalske i Kripto Prognoze
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 500, marginRight: 14 }}>
            Next update in: <b>{getCountdown(Math.min(nextCryptoUpdate || Infinity, nextFootballUpdate || Infinity))}</b>
          </span>
          <button className="btn" onClick={refreshAll}>Refresh all</button>
          {/* Dark mode dugme (samo placeholder dok ne rešiš CSS) */}
          <button
            className="btn"
            onClick={() => document.documentElement.classList.toggle('dark')}
            style={{ opacity: 0.6, pointerEvents: 'none' }}
            title="Dark mode (još nije funkcionalno)"
          >
            Dark mode
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        margin: '34px auto 24px',
        maxWidth: 600,
        display: 'flex',
        justifyContent: 'center',
        gap: 10,
      }}>
        <button
          className={`tab-btn${tab === 'combined' ? ' tab-active' : ''}`}
          onClick={() => setTab('combined')}
        >Combined</button>
        <button
          className={`tab-btn${tab === 'football' ? ' tab-active' : ''}`}
          onClick={() => setTab('football')}
        >Football</button>
        <button
          className={`tab-btn${tab === 'crypto' ? ' tab-active' : ''}`}
          onClick={() => setTab('crypto')}
        >Crypto</button>
      </div>

      {/* Meta info (ispod tabova) */}
      <div style={{
        display: "flex", justifyContent: "center", gap: 30, fontSize: 17, marginBottom: 13
      }}>
        <span>
          <span style={{ fontWeight: 600 }}>Football last generated:</span> {formatTime(footballData?.generated_at)}
        </span>
        <span>
          <span style={{ fontWeight: 600 }}>Crypto next refresh in:</span> {getCountdown(nextCryptoUpdate)}
        </span>
      </div>

      <main style={mainStyle}>
        <h2 style={{ fontSize: 25, fontWeight: 700, marginBottom: 18, textAlign: 'left' }}>
          {tab === 'combined'
            ? 'Combined Top Picks'
            : tab === 'football'
              ? 'Football Top Picks'
              : 'Crypto Top Picks'}
        </h2>
        {tabContent}
      </main>

      {/* Footer sa legendom za badge */}
      <footer style={{
        margin: "38px 0 17px 0",
        padding: 0,
        width: "100%",
        textAlign: "center",
        fontSize: 17,
        color: "#b0b3b8"
      }}>
        Confidence:&nbsp;
        <span style={{ color: "#21c55d", fontWeight: 600 }}>🟢 High (≥85%)</span> ·{" "}
        <span style={{ color: "#3b82f6", fontWeight: 600 }}>🔵 Moderate (55–84%)</span> ·{" "}
        <span style={{ color: "#eab308", fontWeight: 600 }}>🟡 Low (&lt;55%)</span>
      </footer>
    </div>
  );
}
