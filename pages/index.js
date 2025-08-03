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

  const [tab, setTab] = useState('combined');
  const [theme, setTheme] = useState('dark');

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

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    window.localStorage.setItem('theme', next);
  };

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

  // Combined row grid: 33% football, 67% crypto
  const renderCombinedRow = (i) => (
    <div
      key={i}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 2fr',
        gap: '24px',
        marginBottom: '32px',
        alignItems: 'stretch',
      }}
    >
      <div>
        {footballData?.footballTop?.[i] && (
          <SignalCard data={footballData.footballTop[i]} type="football" theme={theme} />
        )}
      </div>
      <div>
        {cryptoData?.cryptoTop?.[i] && (
          <SignalCard data={cryptoData.cryptoTop[i]} type="crypto" theme={theme} />
        )}
      </div>
    </div>
  );

  let tabContent = null;
  if (tab === 'combined') {
    tabContent = (
      <div>
        {[0, 1, 2].map((i) => renderCombinedRow(i))}
      </div>
    );
  } else if (tab === 'football') {
    tabContent = (
      <div style={{ display: 'grid', gap: 24 }}>
        {footballData?.footballTop?.map((item, idx) => (
          <SignalCard data={item} type="football" theme={theme} key={idx} />
        ))}
      </div>
    );
  } else if (tab === 'crypto') {
    tabContent = (
      <div style={{ display: 'grid', gap: 24 }}>
        {cryptoData?.cryptoTop?.map((item, idx) => (
          <SignalCard data={item} type="crypto" theme={theme} key={idx} />
        ))}
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--page-bg, #18191c)',
        color: 'var(--page-fg, #f4f4f5)',
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: '42px 28px 18px 28px',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
            gap: 20,
          }}
        >
          <h1
            style={{
              fontSize: 32,
              fontWeight: 700,
              letterSpacing: '-1.5px',
              margin: 0,
              lineHeight: 1.14,
              textAlign: 'left',
            }}
          >
            AI Top fudbalske i Kripto Prognoze
          </h1>
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn" onClick={refreshAll}>
              Refresh all
            </button>
            <button className="btn" onClick={toggleTheme}>
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </div>

        {/* Info bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 38,
            fontSize: 16,
            margin: '0 0 10px 0',
            flexWrap: 'wrap',
          }}
        >
          <span>
            <b>Football last generated:</b> {formatTime(footballData?.generated_at)}
          </span>
          <span>
            <b>Crypto next refresh in:</b> {getCountdown(nextCryptoUpdate)}
          </span>
          <span>
            <b>Next update in:</b>{' '}
            <b>
              {getCountdown(
                Math.min(nextCryptoUpdate || Infinity, nextFootballUpdate || Infinity)
              )}
            </b>
          </span>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 14,
            margin: '25px 0 28px 0',
          }}
        >
          <button
            className={`tab-btn${tab === 'combined' ? ' tab-active' : ''}`}
            onClick={() => setTab('combined')}
          >
            Combined
          </button>
          <button
            className={`tab-btn${tab === 'football' ? ' tab-active' : ''}`}
            onClick={() => setTab('football')}
          >
            Football
          </button>
          <button
            className={`tab-btn${tab === 'crypto' ? ' tab-active' : ''}`}
            onClick={() => setTab('crypto')}
          >
            Crypto
          </button>
        </div>

        {/* Main cards/content */}
        <main>
          <h2
            style={{
              fontSize: 23,
              fontWeight: 700,
              marginBottom: 18,
              marginTop: 0,
              textAlign: 'left',
            }}
          >
            {tab === 'combined'
              ? 'Combined Top Picks'
              : tab === 'football'
              ? 'Football Top Picks'
              : 'Crypto Top Picks'}
          </h2>
          {tabContent}
        </main>

        {/* Footer legenda */}
        <footer
          style={{
            margin: '34px 0 12px 0',
            padding: 0,
            width: '100%',
            textAlign: 'center',
            fontSize: 17,
            color: '#b0b3b8',
          }}
        >
          Confidence:&nbsp;
          <span style={{ color: '#21c55d', fontWeight: 600 }}>🟢 High (≥85%)</span> ·{' '}
          <span style={{ color: '#3b82f6', fontWeight: 600 }}>🔵 Moderate (55–84%)</span> ·{' '}
          <span style={{ color: '#eab308', fontWeight: 600 }}>🟡 Low (&lt;55%)</span>
        </footer>
      </div>
    </div>
  );
}
