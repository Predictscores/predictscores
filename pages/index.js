// FILE: pages/index.js

import { useContext, useEffect, useState } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';

const TABS = {
  COMBINED: 'combined',
  FOOTBALL: 'football',
  CRYPTO: 'crypto',
};

export default function Home() {
  const {
    footballData,
    longSignals,
    shortSignals,
    loadingCrypto,
    loadingFootball,
    refreshAll,
    nextCryptoUpdate,
  } = useContext(DataContext);

  const [activeTab, setActiveTab] = useState(TABS.COMBINED);
  const [isDark, setIsDark] = useState(false);

  // Init dark mode
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem('dark-mode');
    if (stored === 'true') setIsDark(true);
    else if (stored === 'false') setIsDark(false);
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches)
      setIsDark(true);
  }, []);

  // Persist dark mode
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('dark-mode', isDark ? 'true' : 'false');
  }, [isDark]);

  const formatTime = (ts) =>
    ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

  const getCountdown = (t) => {
    if (!t) return '—';
    const diff = t - Date.now();
    if (diff <= 0) return 'Now';
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${m}m ${s.toString().padStart(2,'0')}s`;
  };

  const topFootball = footballData?.footballTop || [];
  const pairs = [0, 1, 2];

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header */}
      <header className="w-full grid grid-cols-[auto_1fr_auto] items-start gap-4 py-4 px-6">
        <div className="flex gap-1 bg-[#1f2339] rounded-full overflow-hidden">
          {Object.entries(TABS).map(([key, tab]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2 text-sm font-semibold transition ${
                activeTab === tab ? 'bg-[#23272f] text-white' : 'text-gray-300 hover:bg-[#272c4f]'
              }`}
            >
              {key.charAt(0) + key.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <div className="text-xl font-bold text-center">AI Top fudbalske i Kripto Prognoze</div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-3">
            <button onClick={refreshAll} className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] transition font-medium">
              Refresh all
            </button>
            <button onClick={() => setIsDark(d => !d)} className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] transition font-medium">
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
          <div className="bg-[#1f2339] px-4 py-2 rounded-full flex flex-col sm:flex-row gap-2 text-sm text-gray-300">
            <div className="flex gap-1">
              <span className="text-white">Crypto next:</span> <span className="font-mono">{getCountdown(nextCryptoUpdate)}</span>
            </div>
            <div className="flex gap-1">
              <span className="text-white">Football last:</span> <span className="font-mono">{formatTime(footballData?.generated_at)}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mt-4 px-6 space-y-4">
        {(loadingFootball || loadingCrypto) && (
          <div className="text-center text-gray-400">Učitavanje podataka...</div>
        )}

        {/* Combined */}
        {activeTab === TABS.COMBINED &&
          pairs.map(i => (
            <div key={i} className="flex flex-col md:flex-row gap-4 md:min-h-[160px]">
              <div className="md:w-1/3">
                {topFootball[i] ? (
                  <SignalCard data={topFootball[i]} type="football" />
                ) : (
                  <div className="bg-[#1f2339] p-3 rounded-2xl text-gray-400 text-center">
                    Nema fudbalske prognoze
                  </div>
                )}
              </div>
              <div className="md:w-2/3">
                {(longSignals[i] || shortSignals[i]) ? (
                  <SignalCard data={longSignals[i] || shortSignals[i]} type="crypto" />
                ) : (
                  <div className="bg-[#1f2339] p-3 rounded-2xl text-gray-400 text-center">
                    Nema kripto signala
                  </div>
                )}
              </div>
            </div>
          ))}

        {/* Football */}
        {activeTab === TABS.FOOTBALL && (
          <>
            <h2 className="text-2xl font-bold">Top Football Picks</h2>
            <div className="grid grid-cols-1 gap-6 mt-4">
              {topFootball.slice(0, 10).map((f, idx) => (
                <SignalCard key={idx} data={f} type="football" />
              ))}
            </div>
          </>
        )}

        {/* Crypto */}
        {activeTab === TABS.CRYPTO && (
          <>
            <h2 className="text-2xl font-bold">Top Crypto</h2>
            <div className="mt-4 space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-green-300">Long</h3>
                <div className="grid grid-cols-1 gap-6 mt-2">
                  {longSignals.map((c, idx) => (
                    <SignalCard key={idx} data={c} type="crypto" />
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-red-300">Short</h3>
                <div className="grid grid-cols-1 gap-6 mt-2">
                  {shortSignals.map((c, idx) => (
                    <SignalCard key={idx} data={c} type="crypto" />
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="mt-12 mb-8 px-6 text-center text-sm text-gray-400">
        <span className="font-semibold">Confidence legend:</span> 🟢 High · 🔵 Mod · 🟡 Low
      </footer>
    </div>
  );
}

// Ovo onemogućava SSG i izbegava "collect page data" grešku
export async function getServerSideProps() {
  return { props: {} };
}
