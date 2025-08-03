// FILE: pages/index.js

import Link from 'next/link';
import { useContext, useEffect, useState } from 'react';
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

  // Dark mode persistence (optional, keeps toggle)
  useEffect(() => {
    const stored = localStorage.getItem('dark-mode');
    if (stored === 'true') document.documentElement.classList.add('dark');
  }, []);
  const toggleDark = () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('dark-mode', isDark ? 'true' : 'false');
  };

  const topFootball = footballData?.footballTop?.slice(0, 3) || [];
  const topCrypto = cryptoData?.cryptoTop?.slice(0, 3) || [];

  return (
    <div className="min-h-screen bg-[#0f1118] text-white">
      {/* Header */}
      <header className="w-full bg-[#0f1118] py-5 px-4 border-b border-[#1f2434]">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="text-xl font-bold">AI Top fudbalske i Kripto Prognoze</div>
            <nav className="flex gap-2">
              <Link href="/">
                <span className="px-3 py-2 rounded-md bg-[#23272f] text-white font-semibold shadow border border-[#23272f] cursor-pointer hover:bg-[#333842] transition">
                  Combined
                </span>
              </Link>
              <Link href="/football">
                <span className="px-3 py-2 rounded-md text-white font-semibold shadow border border-[#23272f] cursor-pointer hover:bg-[#333842] transition">
                  Football
                </span>
              </Link>
              <Link href="/crypto">
                <span className="px-3 py-2 rounded-md text-white font-semibold shadow border border-[#23272f] cursor-pointer hover:bg-[#333842] transition">
                  Crypto
                </span>
              </Link>
            </nav>
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

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-4 md:px-8 py-10">
        <h2 className="text-3xl font-bold mb-8 text-center">Combined Top Picks</h2>

        {(loadingFootball || loadingCrypto) && (
          <div className="text-center mb-6">Učitavanje podataka...</div>
        )}

        <div className="grid grid-cols-1 gap-10">
          {[0, 1, 2].map((i) => (
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
            <div className="text-center text-gray-400">Nema dostupnih kombinovanih predloga.</div>
          )}
        </div>
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
