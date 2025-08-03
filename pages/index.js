// FILE: pages/index.js

import { useContext } from 'react';
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

  // Countdown helper
  const getCountdown = (targetTime) => {
    if (!targetTime) return '--';
    const diff = targetTime - Date.now();
    if (diff <= 0) return 'Now';
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  // Format vreme
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <main style={{ minHeight: "100vh", background: "#18191c", color: "#f3f4f6", padding: "0 0 40px 0" }}>
      <div style={{ maxWidth: 830, margin: "0 auto" }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 32 }}>
          <h1 style={{ fontSize: 38, fontWeight: 700, letterSpacing: "-1.5px" }}>AI Top fudbalske i Kripto Prognoze</h1>
          <div>
            <button className="btn" onClick={refreshAll}>Refresh all</button>
            <button
              className="btn"
              onClick={() => document.documentElement.classList.toggle('dark')}
            >
              Dark mode
            </button>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 17, marginBottom: 14 }}>
          <span>Next update in: <b>{getCountdown(Math.min(nextCryptoUpdate || Infinity, nextFootballUpdate || Infinity))}</b></span>
        </div>

        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", gap: 14 }}>
            <div>
              <span style={{ fontWeight: 600 }}>Football last generated:</span>{" "}
              {formatTime(footballData?.generated_at)}
            </div>
            <div>
              <span style={{ fontWeight: 600 }}>Crypto next refresh in:</span>{" "}
              {getCountdown(nextCryptoUpdate)}
            </div>
          </div>
        </div>

        <h2 style={{ fontSize: 27, fontWeight: 700, marginBottom: 20 }}>Combined Top Picks</h2>
        {[0, 1, 2].map((i) => (
          <div className="card-row" key={i}>
            {footballData?.footballTop?.[i] && (
              <SignalCard data={footballData.footballTop[i]} type="football" />
            )}
            {cryptoData?.cryptoTop?.[i] && (
              <SignalCard data={cryptoData.cryptoTop[i]} type="crypto" />
            )}
          </div>
        ))}

        <div className="confidence-legend">
          Confidence: <span className="high">🟢 High (≥85%)</span> ·{" "}
          <span className="moderate">🔵 Moderate (55–84%)</span> ·{" "}
          <span className="low">🟡 Low (&lt;55%)</span>
        </div>
      </div>
    </main>
  );
}
