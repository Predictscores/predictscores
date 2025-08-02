// pages/_app.js
import { useEffect, useState } from 'react';
import '../styles/globals.css';
import { DataProvider, useData } from '../contexts/DataContext';

function Header() {
  const [theme, setTheme] = useState('light');
  const {
    refreshCrypto,
    refreshFootball,
    refreshAll,
    nextCryptoUpdate,
    nextFootballUpdate,
  } = useData();

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (stored) setTheme(stored);
    else {
      const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(prefers ? 'dark' : 'light');
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const formatRemaining = (target) => {
    if (!target) return '—';
    const diff = Math.max(0, Math.floor((target - now) / 1000));
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Predict Scores (clean start)</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            onClick={refreshAll}
            style={{
              padding: '6px 12px',
              cursor: 'pointer',
              fontWeight: 600,
              borderRadius: 6,
              border: '1px solid var(--fg)',
              background: 'transparent',
            }}
          >
            Refresh all
          </button>
          <div className="small">
            Crypto in: <strong>{formatRemaining(nextCryptoUpdate)}</strong>
          </div>
          <div className="small">
            Football in: <strong>{formatRemaining(nextFootballUpdate)}</strong>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} style={{ padding: '6px 12px', cursor: 'pointer' }}>
          {theme === 'dark' ? 'Light' : 'Dark'} mode
        </button>
        <button onClick={refreshCrypto} style={{ padding: '6px 12px', cursor: 'pointer' }}>
          Refresh Crypto
        </button>
        <button onClick={refreshFootball} style={{ padding: '6px 12px', cursor: 'pointer' }}>
          Refresh Football
        </button>
      </div>
    </div>
  );
}

export default function App({ Component, pageProps }) {
  return (
    <DataProvider>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
        <Header />
        <Component {...pageProps} />
      </div>
    </DataProvider>
  );
}
