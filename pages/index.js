// FILE: pages/index.js

import { useContext, useState, useEffect } from 'react';
import { DataContext, DataProvider } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';

const TABS = {
  COMBINED: 'combined',
  FOOTBALL: 'football',
  CRYPTO: 'crypto',
};

function HomeContent() {
  const {
    footballData,
    cryptoData,
    loadingFootball,
    loadingCrypto,
    refreshAll,
    selectedDate,
    setSelectedDate,
  } = useContext(DataContext);

  const [activeTab, setActiveTab] = useState(TABS.COMBINED);
  const [isDark, setIsDark] = useState(false);

  // Dark mode init
  useEffect(() => {
    const stored = localStorage.getItem('dark-mode');
    if (stored === 'true') setIsDark(true);
    else if (stored === 'false') setIsDark(false);
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches)
      setIsDark(true);
  }, []);
  useEffect(() => {
    if (isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    localStorage.setItem('dark-mode', isDark ? 'true' : 'false');
  }, [isDark]);

  const getCountdown = (target) => {
    if (!target) return '—';
    const diff = target - Date.now();
    if (diff <= 0) return 'Now';
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  };

  const topFootball = footballData.picks || [];
  const topCrypto = cryptoData.cryptoTop || [];

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header */}
      <header className="w-full grid grid-cols-[auto_1fr_auto] items-start py-4 px-6 gap-4">
        {/* Date picker */}
        <div className="flex items-center gap-2">
          <label htmlFor="date" className="text-gray-300">Datum:</label>
          <input
            id="date"
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="px-2 py-1 rounded bg-[#1f2339] text-white"
          />
        </div>
        {/* Tabs */}
        <div className="flex gap-1 bg-[#1f2339] rounded-full overflow-hidden">
          {Object.values(TABS).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2 text-sm font-semibold transition ${
                activeTab === tab
                  ? 'bg-[#23272f] text-white'
                  : 'text-gray-300 hover:bg-[#272c4f]'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        {/* Controls */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-3">
            <button
              onClick={refreshAll}
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344]"
            >
              Refresh all
            </button>
            <button
              onClick={() => setIsDark(d => !d)}
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344]"
            >
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mt-2 px-6 space-y-4">
        {(loadingFootball || loadingCrypto) && (
          <div className="text-center text-gray-400">Učitavanje podataka...</div>
        )}

        {/* Combined */}
        {activeTab === TABS.COMBINED && (
          <div className="text-center text-gray-400 mb-4">
            {/* ovde možeš ubaciti kombinovani layout */}
            Nema kombinovanih predloga.
          </div>
        )}

        {/* Football */}
        {activeTab === TABS.FOOTBALL && (
          <>
            <h2 className="text-2xl font-bold">
              Top Football Picks za {footballData.date || selectedDate}
            </h2>
            <div className="grid grid-cols-1 gap-6">
              {topFootball.length > 0 ? (
                topFootball.map((signal, idx) => (
                  <div key={idx} className="bg-[#1f2339] p-5 rounded-2xl shadow flex">
                    <SignalCard data={signal} type="football" />
                  </div>
                ))
              ) : (
                <div className="text-center text-gray-400">
                  Nema dostupnih utakmica u narednih 7 dana.
                </div>
              )}
            </div>
          </>
        )}

        {/* Crypto */}
        {activeTab === TABS.CRYPTO && (
          <>
            <h2 className="text-2xl font-bold">Top Crypto Signals</h2>
            <div className="grid grid-cols-1 gap-6">
              {topCrypto.length > 0 ? (
                topCrypto.map((signal, idx) => (
                  <div key={idx} className="bg-[#1f2339] p-5 rounded-2xl shadow flex">
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
    </div>
  );
}

export default function HomePage() {
  return (
    <DataProvider>
      <HomeContent />
    </DataProvider>
  );
}
