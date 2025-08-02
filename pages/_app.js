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

  const fmt = (target) => {
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
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          style={{ padding: '6px 12px', cursor: 'pointer' }}
        >
          {theme === 'dark' ? 'Light' : 'Dark'} mode
        </button>
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
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: '0.8rem' }}>
        <div>
          Crypto in: <strong>{fmt(nextCryptoUpdate)}</strong>
        </div>
        <div>
          Football in: <strong>{fmt(nextFootballUpdate)}</strong>
        </div>
      </div>
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
