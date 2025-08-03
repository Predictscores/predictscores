// FILE: pages/index.js

import { useContext } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';

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

  // Helpers
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const getCountdown = (targetTime) => {
    const diff = targetTime - Date.now();
    if (diff <= 0) return 'Now';
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  // UI
  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header */}
      <header className="flex items-center justify-between max-w-6xl mx-auto px-8 py-8">
        <h1 className="text-3xl md:text-4xl font-bold">
          AI Top fudbalske i Kripto Prognoze
        </h1>
        <div className="flex gap-4">
          <button
            onClick={refreshAll}
            className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#333842] transition-colors"
          >
            Refresh all
          </button>
          <button
            onClick={() =>
              document.documentElement.classList.toggle('dark')
            }
            className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#333842] transition-colors"
          >
            Dark mode
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex justify-center mt-2 mb-4 gap-4">
        <button className="px-4 py-2 rounded-md bg-[#23272f] text-white font-semibold border border-[#222] shadow hover:bg-[#333842]">
          Combined
        </button>
        <button className="px-4 py-2 rounded-md bg-[#23272f] text-white font-semibold border border-[#222] shadow hover:bg-[#333842] opacity-60 cursor-not-allowed">
          Football
        </button>
        <button className="px-4 py-2 rounded-md bg-[#23272f] text-white font-semibold border border-[#222] shadow hover:bg-[#333842] opacity-60 cursor-not-allowed">
          Crypto
        </button>
      </div>

      {/* Info bar */}
      <div className="flex justify-center gap-8 mb-8 text-sm font-medium text-gray-300">
        <span>
          <span className="text-white">Football last generated:</span>{' '}
          {formatTime(footballData?.generated_at)}
        </span>
        <span>
          <span className="text-white">Crypto next refresh in:</span>{' '}
          {getCountdown(nextCryptoUpdate)}
        </span>
        <span>
          <span className="text-white">Next update in:</span>{' '}
          {Math.min(
            (nextCryptoUpdate - Date.now()) / 1000,
            (nextFootballUpdate - Date.now()) / 1000
          ) > 0
            ? getCountdown(
                Math.min(nextCryptoUpdate, nextFootballUpdate)
              )
            : 'Now'}
        </span>
      </div>

      {/* Combined Top Picks */}
      <main className="max-w-6xl mx-auto px-8">
        <h2 className="text-2xl font-bold mb-4 mt-4">Combined Top Picks</h2>
        <div className="grid grid-cols-12 gap-8">
          {/* Football card (33%) */}
          <div className="col-span-12 md:col-span-4 flex">
            {footballData?.footballTop?.[0] && (
              <SignalCard data={footballData.footballTop[0]} type="football" />
            )}
          </div>
          {/* Crypto card (67%) */}
          <div className="col-span-12 md:col-span-8 flex">
            {cryptoData?.cryptoTop?.[0] && (
              <SignalCard data={cryptoData.cryptoTop[0]} type="crypto" />
            )}
          </div>
        </div>
      </main>

      {/* Footer – Confidence legenda */}
      <div className="mt-12 mb-6 text-center text-base text-gray-400">
        Confidence:
        <span className="ml-2 text-green-400 font-bold">High ≥85%</span>
        <span className="mx-3 text-blue-400 font-bold">Moderate 55–84%</span>
        <span className="text-yellow-300 font-bold">Low &lt;55%</span>
      </div>
    </div>
  );
}
