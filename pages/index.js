// FILE: pages/index.js

import { useContext, useEffect, useState } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';

const TABS = {
  COMBINED: 'combined',
  FOOTBALL: 'football',
  CRYPTO: 'crypto',
};

const formatTime = (timestamp) => {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getCountdown = (targetTime) => {
  if (!targetTime) return '—';
  const diff = targetTime - Date.now();
  if (diff <= 0) return 'Now';
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

export default function Home() {
  const {
    cryptoData,
    footballData,
    loadingCrypto,
    loadingFootball,
    refreshAll,
    nextCryptoUpdate,
  } = useContext(DataContext);

  const [activeTab, setActiveTab] = useState(TABS.COMBINED);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('dark-mode');
    if (stored === 'true') {
      document.documentElement.classList.add('dark');
      setIsDark(true);
    } else if (stored === 'false') {
      document.documentElement.classList.remove('dark');
      setIsDark(false);
    } else {
      const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefers) {
        document.documentElement.classList.add('dark');
        setIsDark(true);
        localStorage.setItem('dark-mode', 'true');
      }
    }
  }, []);

  const toggleDark = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    if (newDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    localStorage.setItem('dark-mode', newDark ? 'true' : 'false');
  };

  const topFootball = footballData?.footballTop || [];
  const topCrypto = cryptoData?.cryptoTop || [];
  const combinedPairs = [0, 1, 2];

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-[#18191c] dark:text-white">
      {/* Header */}
      <header className="flex items-center justify-between py-4 px-0">
        <div className="text-xl font-bold">AI Top fudbalske i Kripto Prognoze</div>
        <div className="flex gap-3">
          <button
            onClick={refreshAll}
            className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] text-white transition font-medium"
          >
            Refresh all
          </button>
          <button
            onClick={toggleDark}
            className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] text-white transition font-medium"
          >
            {isDark ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex justify-center mt-3">
        <div className="inline-flex bg-[#1f2339] rounded-full overflow-hidden">
          <button
            onClick={() => setActiveTab(TABS.COMBINED)}
            className={`px-5 py-2 text-sm font-semibold transition ${
              activeTab === TABS.COMBINED
                ? 'bg-[#23272f] text-white'
                : 'text-gray-300 hover:bg-[#272c4f]'
            }`}
          >
            Combined
          </button>
          <button
            onClick={() => setActiveTab(TABS.FOOTBALL)}
            className={`px-5 py-2 text-sm font-semibold transition ${
              activeTab === TABS.FOOTBALL
                ? 'bg-[#23272f] text-white'
                : 'text-gray-300 hover:bg-[#272c4f]'
            }`}
          >
            Football
          </button>
          <button
            onClick={() => setActiveTab(TABS.CRYPTO)}
            className={`px-5 py-2 text-sm font-semibold transition ${
              activeTab === TABS.CRYPTO
                ? 'bg-[#23272f] text-white'
                : 'text-gray-300 hover:bg-[#272c4f]'
            }`}
          >
            Crypto
          </button>
        </div>
      </div>

      {/* Info bar (only football + crypto refresh) */}
      <div className="flex flex-col md:flex-row justify-center gap-6 mt-4 px-0 text-sm text-gray-300 font-medium">
        <div>
          <span className="text-white">Football last generated:</span>{' '}
          {formatTime(footballData?.generated_at)}
        </div>
        <div>
          <span className="text-white">Crypto next refresh:</span>{' '}
          {getCountdown(nextCryptoUpdate)}
        </div>
      </div>

      {/* Main content */}
      <main className="mt-8 space-y-10 px-0">
        {(loadingFootball || loadingCrypto) && (
          <div className="text-center text-gray-500">Učitavanje podataka...</div>
        )}

        {activeTab === TABS.COMBINED && (
          <div className="space-y-10">
            {combinedPairs.map((i) => (
              <div
                key={i}
                className={`flex flex-col md:flex-row gap-2 ${
                  i === 0 ? 'best-pick' : ''
                }`}
                style={{ alignItems: 'stretch' }}
              >
                {/* Football 33% */}
                <div className="md:w-1/3 flex">
                  {topFootball[i] ? (
                    <SignalCard data={topFootball[i]} type="football" />
                  ) : (
                    <div className="w-full bg-[#1f2339] p-5 rounded-2xl text-gray-400">
                      Nema dostupne fudbalske prognoze
                    </div>
                  )}
                </div>
                {/* Crypto 67% */}
                <div className="md:w-2/3 flex">
                  {topCrypto[i] ? (
                    <SignalCard data={topCrypto[i]} type="crypto" />
                  ) : (
                    <div className="w-full bg-[#1f2339] p-5 rounded-2xl text-gray-400">
                      Nema dostupnog kripto signala
                    </div>
                  )}
                </div>
              </div>
            ))}
            {topFootball.length === 0 && topCrypto.length === 0 && (
              <div className="text-center text-gray-400">
                Nema dostupnih kombinovanih predloga.
              </div>
            )}
          </div>
        )}

        {activeTab === TABS.FOOTBALL && (
          <>
            <h2 className="text-2xl font-bold">Top Football Picks</h2>
            <div className="grid grid-cols-1 gap-6">
              {topFootball.length > 0 ? (
                topFootball.slice(0, 10).map((signal, idx) => (
                  <div
                    key={idx}
                    className="bg-[#1f2339] p-5 rounded-2xl shadow flex"
                  >
                    <SignalCard data={signal} type="football" />
                  </div>
                ))
              ) : (
                <div className="text-center text-gray-400">
                  Nema dostupnih fudbalskih predloga.
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === TABS.CRYPTO && (
          <>
            <h2 className="text-2xl font-bold">Top Crypto Signals</h2>
            <div className="grid grid-cols-1 gap-6">
              {topCrypto.length > 0 ? (
                topCrypto.slice(0, 10).map((signal, idx) => (
                  <div
                    key={idx}
                    className="bg-[#1f2339] p-5 rounded-2xl shadow flex"
                  >
                    <SignalCard data={signal} type="crypto" />
                  </div>
                ))
              ) : (
                <div className="text-center text-gray-400">
                  Nema dostupnih kripto signala.
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {/* Footer legend */}
      <footer className="mt-16 mb-8 text-center text-sm text-gray-400">
        <div className="inline-flex flex-wrap justify-center gap-2">
          <div className="font-semibold">Confidence:</div>
          <div className="flex gap-1 items-center">
            <div className="legend-item">🟡 Low (&lt;55%)</div>
            <div className="legend-sep"> </div>
            <div className="legend-item">🔵 Moderate (55–80%)</div>
            <div className="legend-sep"> </div>
            <div className="legend-item">🟢 High (80–90%)</div>
            <div className="legend-sep"> </div>
            <div className="legend-item">🔥 Explosive (&gt;90%)</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
