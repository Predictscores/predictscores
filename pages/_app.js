import { useEffect, useState } from 'react';
import '../styles/globals.css';

export default function App({ Component, pageProps }) {
  const [theme, setTheme] = useState('light');

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

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Predict Scores (clean start)</h1>
        <button onClick={toggle} style={{ padding: '6px 12px', cursor: 'pointer' }}>
          {theme === 'dark' ? 'Light' : 'Dark'} mode
        </button>
      </div>
      <Component {...pageProps} />
    </div>
  );
}
