// pages/_app.js
import { useEffect, useState } from 'react';
import '../styles/globals.css';
import { DataProvider, useData } from '../contexts/DataContext';

function HeaderControls() {
  const [theme, setTheme] = useState('light');
  const { refreshAll, nextCryptoUpdate, nextFootballUpdate } = useData();
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

  // unified next update (earliest of the two)
  const nextUpdate = (() => {
    if (!nextCryptoUpdate && !nextFootballUpdate) return null;
    if (!nextCryptoUpdate) return nextFootballUpdate;
    if (!nextFootballUpdate) return nextCryptoUpdate;
    return Math.min(nextCryptoUpdate, nextFootballUpdate);
  })();

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
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 12,
        padding: '8px 0',
      }}
    >
      <div className="small">Next update in: <strong>{formatRemaining(nextUpdate)}</strong></div>
      <button
        onClick={refreshAll}
        style={{
          padding: '6px 12px',
          cursor: 'pointer',
          fontWeight: 600,
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'transparent',
        }}
      >
        Refresh all
      </button>
      <button
        onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        style={{ padding: '6px 12px', cursor: 'pointer' }}
      >
        {theme === 'dark' ? 'Light' : 'Dark'} mode
      </button>
    </div>
  );
}

export default function App({ Component, pageProps }) {
  return (
    <DataProvider>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
        <HeaderControls />
        <Component {...pageProps} />
      </div>
    </DataProvider>
  );
}
