// FILE: pages/index.js

import { useContext, useEffect, useState } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';
import CryptoTopSignals from '../components/CryptoTopSignals';

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
    nextCryptoUpdate,
    nextFootballUpdate,
  } = useContext(DataContext);

  const [activeTab, setActiveTab] = useState(TABS.COMBINED);
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem('dark-mode') === 'true'
  );

  // Sync dark mode class
  useEffect(() => {
    if (isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    localStorage.setItem('dark-mode', isDark ? 'true' : 'false');
  }, [isDark]);

  // Helpers
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
  const nextUpdate = (() => {
    if (!nextCryptoUpdate && !nextFootballUpdate) return null;
    if (!nextCryptoUpdate) return nextFootballUpdate;
    if (!nextFootballUpdate) return nextCryptoUpdate;
    return Math.min(nextCryptoUpdate, nextFootballUpdate);
  })();

  const topFootball = footballData?.footballTop || [];
  const topCrypto = cryptoData?.cryptoTop || [];
  const combinedPairs = [0, 1, 2];

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header */}
      <header className="w-full flex flex-col md:flex-row items-start md:items-center justify-between py-4 px-6 gap-4">
        <div className="text-xl font-bold">AI Top fudbalske i Kripto Prognoze</div>
        <div className="flex flex-wrap items-center gap-3 ml-auto">
          <div className="flex gap-1 bg-[#1f2339] rounded-full overflow-hidden">
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
          <div className="flex gap-3 ml-auto">
            <button
              onClick={refreshAll}
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] transition font-medium"
            >
              Refresh all
            </button>
            <button
              onClick={() => setIsDark((d) => !d)}
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] transition font-medium"
            >
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </div>
      </header>

      {/* Info bar */}
      <div className="max-w-full flex flex-col md:flex-row justify-center gap-6 mt-2 px-6 text-sm text-gray-300 font-medium">
        <div>
          <span className="text-white">Football last generated:</span>{' '}
          {formatTime(footballData?.generated_at)}
        </div>
        <div>
          <span className="text-white">Crypto next refresh:</span>{' '}
          {getCountdown(nextCryptoUpdate)}
        </div>
        {/* removed unified next update per request */}
      </div>

      {/* Main content */}
      <main className="mt-8 space-y-10 px-6">
        {(loadingFootball || loadingCrypto) && (
          <div className="text-center text-gray-400">
            Učitavanje podataka...
          </div>
        )}

        {/* Combined view */}
        {activeTab === TABS.COMBINED && (
          <div className="space-y-10">
            {combinedPairs.map((i) => (
              <div
                key={i}
                className="flex flex-col md:flex-row gap-4"
                style={{ alignItems: 'stretch' }}
              >
                {/* Football 33% */}
                <div className="md:w-1/3 flex">
                  {topFootball[i] ? (
                    <div className="w-full">
                      <div className="relative">
                        {i === 0 && (
                          <div className="absolute -top-4 left-0">
                            <div className="inline-flex px-3 py-1 rounded-full bg-gradient-to-r from-yellow-400 to-red-500 text-xs font-bold">
                              Best Combined Pick
                            </div>
                          </div>
                        )}
                        <SignalCard data={topFootball[i]} type="football" />
                      </div>
                    </div>
                  ) : (
                    <div className="w-full bg-[#1f2339] p-5 rounded-2xl text-gray-400">
                      Nema dostupne fudbalske prognoze
                    </div>
                  )}
                </div>
                {/* Crypto 67% */}
                <div className="md:w-2/3 flex">
                  {topCrypto[i] ? (
                    <div className="w-full">
                      <SignalCard data={topCrypto[i]} type="crypto" />
                    </div>
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

        {/* Football only */}
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

        {/* Crypto only */}
        {activeTab === TABS.CRYPTO && (
          <>
            <CryptoTopSignals refreshIntervalMs={10000} limit={6} />
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-16 mb-8 px-6 text-center text-sm text-gray-400">
        <div className="inline-flex gap-2 flex-wrap justify-center">
          <div>
            <span className="font-semibold">Confidence:</span>{' '}
          </div>
          <div className="flex gap-1">
            <div>🟢 High (≥80% &lt;=90%)</div>
            <div>·</div>
            <div>🔵 Moderate (55–80%)</div>
            <div>·</div>
            <div>🟡 Low (&lt;55%)</div>
            <div>·</div>
            <div>🔥 Bomba (&gt;90%)</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
