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
    cryptoData,
    footballData,
    loadingCrypto,
    loadingFootball,
    refreshAll,
  } = useContext(DataContext);

  const [activeTab, setActiveTab] = useState(TABS.COMBINED);
  const [versionTag, setVersionTag] = useState('');

  // Dark mode persistence
  useEffect(() => {
    const stored = localStorage.getItem('dark-mode');
    if (stored === 'true') document.documentElement.classList.add('dark');
    setVersionTag(new Date().toISOString().replace('T', ' ').split('.')[0]);
  }, []);

  const toggleDark = () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('dark-mode', isDark ? 'true' : 'false');
  };

  const topFootball = footballData?.footballTop || [];
  const topCrypto = cryptoData?.cryptoTop || [];

  const renderCombined = () => {
    const pairs = [0, 1, 2];
    return (
      <div className="grid grid-cols-1 gap-10">
        {pairs.map((i) => (
          <div
            className="flex flex-col md:flex-row gap-6 bg-[#1f2434] p-6 rounded-2xl shadow"
            key={i}
          >
            <div className="flex-1">
              {topFootball[i] ? (
                <SignalCard data={topFootball[i]} type="football" />
              ) : (
                <div className="text-gray-400">Nema dostupne fudbalske prognoze</div>
              )}
            </div>
            <div className="flex-1">
              {topCrypto[i] ? (
                <SignalCard data={topCrypto[i]} type="crypto" />
              ) : (
                <div className="text-gray-400">Nema dostupnog kripto signala</div>
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
    );
  };

  const renderFootball = () => (
    <div className="grid grid-cols-1 gap-8">
      {topFootball.length > 0 ? (
        topFootball.slice(0, 10).map((signal, idx) => (
          <div key={idx} className="bg-[#1f2434] p-5 rounded-2xl shadow">
            <SignalCard data={signal} type="football" />
          </div>
        ))
      ) : (
        <div className="text-center text-gray-400">
          Nema dostupnih fudbalskih predloga.
        </div>
      )}
    </div>
  );

  const renderCrypto = () => (
    <div className="grid grid-cols-1 gap-8">
      {topCrypto.length > 0 ? (
        topCrypto.slice(0, 10).map((signal, idx) => (
          <div key={idx} className="bg-[#1f2434] p-5 rounded-2xl shadow">
            <SignalCard data={signal} type="crypto" />
          </div>
        ))
      ) : (
        <div className="text-center text-gray-400">
          Nema dostupnih kripto signala.
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0f1118] text-white">
      {/* Header */}
      <header className="w-full bg-[#0f1118] py-5 px-4 border-b border-[#1f2434]">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex flex-col md:flex-row items-center gap-6 flex-wrap">
            <div className="flex items-baseline gap-2">
              <div className="text-xl font-bold">AI Top fudbalske i Kripto Prognoze</div>
              <div className="text-xs text-gray-400">({activeTab.toUpperCase()})</div>
              <div className="ml-4 text-xs text-gray-500">ver: {versionTag}</div>
            </div>
            {/* Tabs */}
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setActiveTab(TABS.COMBINED)}
                className={`px-3 py-2 rounded-md font-semibold transition ${
                  activeTab === TABS.COMBINED
                    ? 'bg-[#23272f] text-white shadow'
                    : 'text-white hover:bg-[#1f2434]'
                }`}
              >
                Combined
              </button>
              <button
                onClick={() => setActiveTab(TABS.FOOTBALL)}
                className={`px-3 py-2 rounded-md font-semibold transition ${
                  activeTab === TABS.FOOTBALL
                    ? 'bg-[#23272f] text-white shadow'
                    : 'text-white hover:bg-[#1f2434]'
                }`}
              >
                Football
              </button>
              <button
                onClick={() => setActiveTab(TABS.CRYPTO)}
                className={`px-3 py-2 rounded-md font-semibold transition ${
                  activeTab === TABS.CRYPTO
                    ? 'bg-[#23272f] text-white shadow'
                    : 'text-white hover:bg-[#1f2434]'
                }`}
              >
                Crypto
              </button>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={refreshAll}
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#333842] transition font-medium"
            >
              Refresh all
            </button>
            <button
              onClick={toggleDark}
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#333842] transition font-medium"
            >
              Dark mode
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 md:px-8 py-10">
        { (loadingFootball || loadingCrypto) && (
          <div className="text-center mb-6">Učitavanje podataka...</div>
        )}

        {activeTab === TABS.COMBINED && (
          <>
            <h2 className="text-3xl font-bold mb-6 text-center">Combined Top Picks</h2>
            {renderCombined()}
          </>
        )}

        {activeTab === TABS.FOOTBALL && (
          <>
            <h2 className="text-3xl font-bold mb-6 text-center">Top Football Picks</h2>
            {renderFootball()}
          </>
        )}

        {activeTab === TABS.CRYPTO && (
          <>
            <h2 className="text-3xl font-bold mb-6 text-center">Top Crypto Signals</h2>
            {renderCrypto()}
          </>
        )}
      </main>

      {/* Footer legend */}
      <footer className="mt-16 mb-8 text-center text-base text-gray-400">
        Confidence:
        <span className="ml-2 text-green-400 font-bold">High ≥85%</span>
        <span className="mx-3 text-blue-400 font-bold">Moderate 55–84%</span>
        <span className="text-yellow-300 font-bold">Low &lt;55%</span>
      </footer>
    </div>
  );
}
