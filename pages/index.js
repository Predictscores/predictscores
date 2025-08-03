// FILE: pages/index.js

import Link from 'next/link';
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
  } = useContext(DataContext);

  // Helper
  const topFootball = footballData?.footballTop?.slice(0, 3) || [];
  const topCrypto = cryptoData?.cryptoTop?.slice(0, 3) || [];

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header sa tabovima i desnim dugmićima */}
      <header className="w-full bg-[#18191c] py-6 px-4 border-b border-[#23272f]">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          {/* Tabovi */}
          <nav className="flex gap-2 md:gap-4">
            <Link href="/">
              <span className="px-4 py-2 rounded-md bg-[#23272f] text-white font-semibold shadow border border-[#23272f] cursor-pointer hover:bg-[#333842] transition-colors">
                Combined
              </span>
            </Link>
            <Link href="/football">
              <span className="px-4 py-2 rounded-md text-white font-semibold shadow border border-[#23272f] cursor-pointer hover:bg-[#333842] transition-colors">
                Football
              </span>
            </Link>
            <Link href="/crypto">
              <span className="px-4 py-2 rounded-md text-white font-semibold shadow border border-[#23272f] cursor-pointer hover:bg-[#333842] transition-colors">
                Crypto
              </span>
            </Link>
          </nav>
          {/* Dugmad desno */}
          <div className="flex gap-2 md:gap-4">
            <button
              onClick={refreshAll}
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#333842] transition-colors font-medium"
            >
              Refresh all
            </button>
            <button
              onClick={() =>
                document.documentElement.classList.toggle('dark')
              }
              className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#333842] transition-colors font-medium"
            >
              Dark mode
            </button>
          </div>
        </div>
      </header>

      {/* Glavni sadržaj */}
      <main className="max-w-6xl mx-auto px-4 md:px-8 py-8">
        <h2 className="text-2xl font-bold mb-6 text-center">Combined Top Picks</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Parovi: fudbal + kripto */}
          {[0, 1, 2].map((i) => (
            <div className="flex flex-col md:flex-row gap-4" key={i}>
              <div className="flex-1">
                {topFootball[i] && (
                  <SignalCard data={topFootball[i]} type="football" />
                )}
              </div>
              <div className="flex-1">
                {topCrypto[i] && (
                  <SignalCard data={topCrypto[i]} type="crypto" />
                )}
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Footer – Confidence legenda */}
      <footer className="mt-12 mb-6 text-center text-base text-gray-400">
        Confidence:
        <span className="ml-2 text-green-400 font-bold">High ≥85%</span>
        <span className="mx-3 text-blue-400 font-bold">Moderate 55–84%</span>
        <span className="text-yellow-300 font-bold">Low &lt;55%</span>
      </footer>
    </div>
  );
}
