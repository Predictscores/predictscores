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

  // (tvoja postojeća dark-mode/ header logika...)

  const topFootball = footballData.picks.slice(0, 10);
  const topCrypto = cryptoData.cryptoTop.slice(0, 10);

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header sa date picker-om */}
      <header className="w-full grid grid-cols-[auto_1fr_auto] items-start gap-4 py-4 px-6">
        <div className="flex items-center gap-2">
          <label htmlFor="date" className="text-gray-300">Datum:</label>
          <input
            id="date"
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-2 py-1 rounded bg-[#1f2339] text-white"
          />
        </div>
        {/* ... ostatak header-a (tabs, naslov, kontrole) */}
        <div className="flex gap-3">
          <button onClick={refreshAll} className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344]">
            Refresh all
          </button>
        </div>
      </header>

      {/* Main sa tvojim karticama */}
      <main className="mt-2 space-y-4 px-6">
        {(loadingFootball || loadingCrypto) && (
          <div className="text-center text-gray-400">Učitavanje podataka...</div>
        )}

        {activeTab === TABS.COMBINED && (
          {/* ... tvoj kombinovani layout */}
          <div>/* Combined */</div>
        )}

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

        {activeTab === TABS.CRYPTO && (
          {/* ... crypto deo */}
          <div>/* Crypto */</div>
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
