// FILE: pages/index.js

import { useContext, useState, useEffect } from 'react';
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
  const [theme, setTheme] = useState('dark');

  // Uvezi dark/light mode iz localStorage na početku
  useEffect(() => {
    const stored = window.localStorage.getItem('theme');
    if (stored === 'light') {
      setTheme('light');
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      setTheme('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  // Menja dark/light mod
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    window.localStorage.setItem('theme', next);
  };

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

  // Grid layout za combined tab (football 33%, crypto 66%)
  const renderCombinedRow = (i) => (
    <div className="combined-grid" key={i}>
      <div className="football-col">
        {footballData?.footballTop?.[i] && (
          <SignalCard data={footballData.footballTop[i]} type="football" theme={theme} />
        )}
      </div>
      <div className="crypto-col">
        {cryptoData?.cryptoTop?.[i] && (
          <SignalCard data={cryptoData.cryptoTop[i]} type="crypto" theme={theme} />
        )}
      </div>
    </div>
  );

  // Kartice po tabovima
  let tabContent = null;
  if (tab === 'combined') {
    tabContent = (
      <div>
        {[0, 1, 2].map((i) => renderCombinedRow(i))}
      </div>
    );
  } else if (tab === 'football') {
    tabContent = (
      <div>
        {footballData?.footballTop?.map((item, idx) => (
          <div className="card-row" key={idx}>
            <SignalCard data={item} type="football" theme={theme} />
          </div>
        ))}
      </div>
    );
  } else if (tab === 'crypto') {
    tabContent = (
      <div>
        {cryptoData?.cryptoTop?.map((item, idx) => (
          <div className="card-row" key={idx}>
            <SignalCard data={item} type="crypto" theme={theme} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: "var(--page-bg, #18191c)",
      color: "var(--page-fg, #f4f4f5)",
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header: naslov i kontrole u istoj liniji */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        margin: '36px auto 0',
        maxWidth: 900,
        width: '100%',
        gap: 20
      }}>
        <h1 style={{
          fontSize: 34,
          fontWeight: 700,
          letterSpacing: "-1.5px",
          textAlign: 'left',
          margin: 0,
          lineHeight: 1.2
        }}>
          AI Top fudbalske i Kripto Prognoze
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn" onClick={refreshAll}>Refresh all</button>
          <button className="btn" onClick={toggleTheme}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </div>

      {/* Meta info (ispod headera, centrirano) */}
      <div style={{
        display: "flex", justifyContent: "center", gap: 34,
        fontSize: 17, margin: "17px 0 8px 0"
      }}>
        <span>
          <span style={{ fontWeight: 600 }}>Football last generated:</span> {formatTime(footballData?.generated_at)}
        </span>
        <span>
          <span style={{ fontWeight: 600 }}>Crypto next refresh in:</span> {getCountdown(nextCryptoUpdate)}
        </span>
        <span>
          <span style={{ fontWeight: 600 }}>Next update in:</span> <b>{getCountdown(Math.min(nextCryptoUpdate || Infinity, nextFootballUpdate || Infinity))}</b>
        </span>
      </div>

      {/* Tabs */}
      <div style={{
        margin: '28px auto 22px',
        maxWidth: 680,
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

      {/* Main kartice */}
      <main style={{
        maxWidth: 900, margin: "0 auto", flex: 1, display: 'flex',
        flexDirection: 'column', justifyContent: 'flex-start'
      }}>
        <h2 style={{
          fontSize: 25, fontWeight: 700, marginBottom: 18, textAlign: 'left'
        }}>
          {tab === 'combined'
            ? 'Combined Top Picks'
            : tab === 'football'
              ? 'Football Top Picks'
              : 'Crypto Top Picks'}
        </h2>
        {tabContent}
      </main>

      {/* Footer legenda */}
      <footer style={{
        margin: "34px 0 12px 0",
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
