// FILE: pages/index.js

import { useContext, useEffect, useState } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';
import useValueBets from '../hooks/useValueBets';

const TABS = {
  COMBINED: 'combined',
  FOOTBALL: 'football',
  CRYPTO: 'crypto',
};

function formatTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getCountdown(targetTime) {
  if (!targetTime) return '—';
  const diff = targetTime - Date.now();
  if (diff <= 0) return 'Now';
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

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

  const today = new Date().toISOString().slice(0, 10);

  const {
    bets: valueBets,
    loading: loadingValueBets,
    error: valueBetsError,
  } = useValueBets(today);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem('dark-mode');
    if (stored === 'true') setIsDark(true);
    else if (stored === 'false') setIsDark(false);
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches)
      setIsDark(true);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    if (typeof window !== 'undefined') {
      localStorage.setItem('dark-mode', isDark ? 'true' : 'false');
    }
  }, [isDark]);

  const topFootball = footballData?.footballTop || [];
  const topCrypto = cryptoData?.cryptoTop || [];
  const combinedPairs = [0, 1, 2];
  const topValueBets = valueBets.slice(0, 3);
  const combinedSlots = combinedPairs.map((i) => topValueBets[i] || topFootball[i]);
  const displayFootball = valueBets.length > 0 ? valueBets.slice(0, 10) : topFootball.slice(0, 10);

  const ValueBetCard = ({ bet }) => {
    if (!bet) return null;
    const { market, selection, type, market_odds, edge, teams, datetime_local } = bet;
    const home = teams?.home?.name || 'Home';
    const away = teams?.away?.name || 'Away';
    const timeStr = datetime_local?.starting_at?.date_time || '';

    let pickIcon = selection;
    if (market === '1X2') {
      if (selection.toLowerCase() === home.toLowerCase()) pickIcon = '1️⃣';
      else if (selection.toLowerCase() === away.toLowerCase()) pickIcon = '2️⃣';
      else pickIcon = '✖️';
    } else if (market === 'BTTS') {
      pickIcon = selection.toLowerCase() === 'yes' ? '✅' : '❌';
    }

    return (
      <div className="bg-[#1f2339] p-5 rounded-2xl shadow hover:shadow-lg transform hover:scale-105 transition duration-200">
        <div className="flex justify-between items-start">
          <div className="font-semibold text-lg flex items-center gap-2">
            <span>{pickIcon}</span>
            <span>{home} vs {away}</span>
            {market && <span className="text-sm text-gray-400">({market})</span>}
          </div>
          <div className={`text-xs px-2 py-1 rounded ${
            type === 'MODEL+ODDS' ? 'bg-green-100 text-green-800' : 'bg-gray-800 text-gray-300'
          }`}>
            {type === 'MODEL+ODDS' ? 'Real + Odds' : 'Fallback'}
          </div>
        </div>
        <div className="text-sm mt-2">
          <div><strong>Kvota:</strong> {market_odds ?? '-'}</div>
          {edge != null && <div><strong>Edge:</strong> {(edge * 100).toFixed(1)}%</div>}
          <div className="text-xs text-gray-400 mt-1">{`Model: ${(bet.model_prob * 100).toFixed(1)}%`}</div>
          <div className="text-xs text-gray-500 mt-1">Starts at: {timeStr}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header */}
      <header className="w-full grid grid-cols-[auto_1fr_auto] items-start gap-4 py-4 px-6">
        <div className="flex gap-1 items-center">
          <div className="flex gap-1 bg-[#1f2339] rounded-full overflow-hidden">
            <button onClick={() => setActiveTab(TABS.COMBINED)} className={`px-5 py-2 text-sm font-semibold transition ${
              activeTab === TABS.COMBINED ? 'bg-[#23272f] text-white' : 'text-gray-300 hover:bg-[#272c4f]'
            }`}>Combined</button>
            <button onClick={() => setActiveTab(TABS.FOOTBALL)} className={`px-5 py-2 text-sm font-semibold transition ${
              activeTab === TABS.FOOTBALL ? 'bg-[#23272f] text-white' : 'text-gray-300 hover:bg-[#272c4f]'
            }`}>Football</button>
            <button onClick={() => setActiveTab(TABS.CRYPTO)} className={`px-5 py-2 text-sm font-semibold transition ${
              activeTab === TABS.CRYPTO ? 'bg-[#23272f] text-white' : 'text-gray-300 hover:bg-[#272c4f]'
            }`}>Crypto</button>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="text-xl font-bold">AI Top fudbalske i Kripto Prognoze</div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-3">
            <button onClick={refreshAll} className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] transition font-medium">Refresh all</button>
            <button onClick={() => setIsDark(d => !d)} className="px-4 py-2 rounded-md bg-[#23272f] hover:bg-[#2f3344] transition font-medium">{isDark ? 'Light mode' : 'Dark mode'}</button>
          </div>
          <div>
            <div className="bg-[#1f2339] px-4 py-2 rounded-full flex flex-col sm:flex-row gap-2 text-sm text-gray-300 font-medium">
              <div className="flex gap-1 items-center"><span className="text-white">Crypto next refresh:</span><span className="font-mono">{getCountdown(nextCryptoUpdate)}</span></div>
              <div className="flex gap-1 items-center"><span className="text-white">Football last generated:</span><span className="font-mono">{formatTime(footballData?.generated_at)}</span></div>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mt-2 space-y-4 px-6">
        {(loadingFootball || loadingCrypto) && <div className="text-center text-gray-400">Učitavanje podataka...</div>}

        {/* Combined */}
        {activeTab === TABS.COMBINED && (
          <>
            {combinedSlots.every(b => !b) && topCrypto.every(c => !c) && (
              <div className="text-center text-gray-400 mb-4">Nema dostupnih komb. predloga.</div>
            )}
            {combinedPairs.map(i => (
              <div key={i} className="flex flex-col md:flex-row gap-4 md:min-h-[160px] items-stretch">
                <div className="md:w-1/3">
                  {combinedSlots[i] ? (
                    <ValueBetCard bet={combinedSlots[i]} />
                  ) : topFootball[i] ? (
                    <SignalCard data={topFootball[i]} type="football" />
                  ) : (
                    <div className="w-full bg-[#1f2339] p-3 rounded-2xl text-gray-400 flex items-center justify-center">Nema podataka</div>
                  )}
                </div>
                <div className="md:w-2/3">
                  {topCrypto[i] ? (
                    <SignalCard data={topCrypto[i]} type="crypto" />
                  ) : ( 
                    <div className="w-full bg-[#1f2339] p-3 rounded-2xl text-gray-400 flex items-center justify-center">Nema kripto signala</div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Football */}
        {activeTab === TABS.FOOTBALL && (
          <>
            <h2 className="text-2xl font-bold">Top Football Picks</h2>
            {loadingValueBets ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[1, 2, 3].map(n => (
                  <div key={n} className="h-40 bg-gray-700 animate-pulse rounded-2xl" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {displayFootball.length > 0 ? (
                  displayFootball.map((bet, idx) => <ValueBetCard key={idx} bet={bet} />)
                ) : (
                  <div className="text-center text-gray-400 col-span-3">Nema dostupnih fudbalskih predloga.</div>
                )}
              </div>
            )}
            {valueBetsError && <div className="text-red-400 text-center mt-2">{valueBetsError}</div>}
          </>
        )}

        {/* Crypto */}
        {activeTab === TABS.CRYPTO && (
          <>
            <h2 className="text-2xl font-bold">Top Crypto Signals</h2>
            <div className="grid grid-cols-1 gap-6">
              {topCrypto.length > 0 ? (
                topCrypto.slice(0, 10).map((signal, idx) => (
                  <div key={idx} className="bg-[#1f2339] p-5 rounded-2xl shadow"><SignalCard data={signal} type="crypto" /></div>
                ))
              ) : (
                <div className="text-center text-gray-400">Nema dostupnih kripto signala.</div>
              )}
            </div>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-12 mb-8 px-6 text-center text-sm text-gray-400">
        <div className="inline-flex gap-2 flex-wrap justify-center">
          <div><span className="font-semibold">Confidence:</span></div>
          <div className="flex gap-1 flex-wrap justify-center">
            <div>🟢 High (80–90%)</div><div>·</div>
            <div>🔵 Moderate (55–80%)</div><div>·</div>
            <div>🟡 Low (&lt;55%)</div><div>·</div>
            <div>🔥 Bomba (&gt;90%)</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
