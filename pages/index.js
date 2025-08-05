// FILE: pages/index.js

import { useContext, useEffect, useState } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';

const TABS = {
  COMBINED: 'combined',
  FOOTBALL: 'football',
  CRYPTO: 'crypto',
};

function formatPercent(x) {
  if (x == null) return '-';
  return `${(x * 100).toFixed(1)}%`;
}

function explainBet(bet) {
  if (!bet) return '';
  if (bet.type === 'MODEL+ODDS') {
    const implied = bet.market_odds ? 1 / bet.market_odds : null;
    return `Model: ${formatPercent(bet.model_prob)} vs Market: ${formatPercent(
      implied
    )} (odds ${bet.market_odds}) → edge ${formatPercent(bet.edge)}`;
  } else {
    return `Model-only: ${formatPercent(bet.model_prob)} (fallback)`;
  }
}

function sortValueBets(value_bets = []) {
  return value_bets
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'MODEL+ODDS' ? -1 : 1;
      const edgeA = a.edge != null ? a.edge : 0;
      const edgeB = b.edge != null ? b.edge : 0;
      if (edgeB !== edgeA) return edgeB - edgeA;
      return (b.model_prob || 0) - (a.model_prob || 0);
    });
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

  const [valueBets, setValueBets] = useState([]);
  const [loadingValueBets, setLoadingValueBets] = useState(true);
  const [valueBetsError, setValueBetsError] = useState(null);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

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

  const formatTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const getCountdown = (t) => {
    if (!t) return '—';
    const d = t - Date.now();
    if (d <= 0) return 'Now';
    const m = Math.floor(d / 60000);
    const s = Math.floor((d % 60000) / 1000);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  };

  // fetch value-bets
  const fetchValueBets = async () => {
    setLoadingValueBets(true);
    setValueBetsError(null);
    try {
      const res = await fetch(
        `/api/value-bets?sport_key=soccer&date=${encodeURIComponent(
          today
        )}&min_edge=0.05&min_odds=1.3`
      );
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Fetch ${res.status}: ${t}`);
      }
      const json = await res.json();
      const bets = Array.isArray(json.value_bets) ? json.value_bets : [];
      setValueBets(sortValueBets(bets));
    } catch (e) {
      console.error(e);
      setValueBets([]);
      setValueBetsError('Ne mogu da učitam predloge');
    } finally {
      setLoadingValueBets(false);
    }
  };

  useEffect(() => {
    fetchValueBets();
    const iv = setInterval(fetchValueBets, 2 * 60 * 60 * 1000);
    return () => clearInterval(iv);
  }, [today]);

  const topFootball = footballData?.footballTop || [];
  const topCrypto = cryptoData?.cryptoTop || [];
  const combinedPairs = [0, 1, 2];
  const topValueBets = valueBets.slice(0, 3);
  const combinedSlots = combinedPairs.map((i) => topValueBets[i] || topFootball[i]);

  const displayFootball = valueBets.length > 0 ? valueBets.slice(0, 10) : topFootball.slice(0, 10);

  // Card component for a value-bet, with hover & icon
  const ValueBetCard = ({ bet }) => {
    if (!bet) return null;
    const { market, selection, type, market_odds, edge, teams, datetime_local } = bet;
    const home = teams?.home?.name || 'Home';
    const away = teams?.away?.name || 'Away';
    const timeStr = datetime_local?.starting_at?.date_time || '';
    // pick icon
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
            <span>{market === '1X2' ? `${home} vs ${away}` : `${home} vs ${away}`}</span>
            {market && <span className="text-sm text-gray-400">({market})</span>}
          </div>
          <div
            className={`text-xs px-2 py-1 rounded ${
              type === 'MODEL+ODDS' ? 'bg-green-100 text-green-800' : 'bg-gray-800 text-gray-300'
            }`}
          >
            {type === 'MODEL+ODDS' ? 'Real + Odds' : 'Fallback'}
          </div>
        </div>
        <div className="text-sm mt-2">
          <div>
            <strong>Kvota:</strong> {market_odds ?? '-'}
          </div>
          {edge != null && (
            <div>
              <strong>Edge:</strong> {formatPercent(edge)}
            </div>
          )}
          <div className="text-xs text-gray-400 mt-1">{explainBet(bet)}</div>
          <div className="text-xs text-gray-500 mt-1">Starts at: {timeStr}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* header omitted for brevity, same as before */}
      <header className="w-full grid grid-cols-[auto_1fr_auto] items-start gap-4 py-4 px-6">
        {/* ... same tabs, title, buttons ... */}
      </header>

      <main className="mt-2 space-y-4 px-6">
        {(loadingFootball || loadingCrypto) && (
          <div className="text-center text-gray-400">Učitavanje podataka...</div>
        )}

        {/* Combined */}
        {activeTab === TABS.COMBINED && (
          <>
            {combinedSlots.every((b) => !b) && topCrypto.every((c) => !c) && (
              <div className="text-center text-gray-400 mb-4">
                Nema dostupnih komb. predloga.
              </div>
            )}
            {combinedPairs.map((i) => (
              <div
                key={i}
                className="flex flex-col md:flex-row gap-4 md:min-h-[160px] items-stretch"
              >
                <div className="md:w-1/3">
                  {combinedSlots[i] ? (
                    <ValueBetCard bet={combinedSlots[i]} />
                  ) : topFootball[i] ? (
                    <SignalCard data={topFootball[i]} type="football" />
                  ) : (
                    <div className="w-full bg-[#1f2339] p-3 rounded-2xl text-gray-400 flex items-center justify-center">
                      Nema podataka
                    </div>
                  )}
                </div>
                <div className="md:w-2/3">
                  {topCrypto[i] ? (
                    <SignalCard data={topCrypto[i]} type="crypto" />
                  ) : (
                    <div className="w-full bg-[#1f2339] p-3 rounded-2xl text-gray-400 flex items-center justify-center">
                      Nema kripto signala
                    </div>
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
                {[1, 2, 3].map((n) => (
                  <div
                    key={n}
                    className="h-40 bg-gray-700 animate-pulse rounded-2xl"
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {displayFootball.length > 0 ? (
                  displayFootball.map((bet, idx) => (
                    <ValueBetCard key={idx} bet={bet} />
                  ))
                ) : (
                  <div className="text-center text-gray-400 col-span-3">
                    Nema dostupnih fudbalskih predloga.
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Crypto */}
        {activeTab === TABS.CRYPTO && (
          <>
            <h2 className="text-2xl font-bold">Top Crypto Signals</h2>
            <div className="grid grid-cols-1 gap-6">
              {topCrypto.length > 0 ? (
                topCrypto.slice(0, 10).map((signal, idx) => (
                  <div key={idx} className="bg-[#1f2339] p-5 rounded-2xl shadow">
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

      {/* footer omitted for brevity */}
      <footer className="mt-12 mb-8 px-6 text-center text-sm text-gray-400">
        {/* ... same confidence legend ... */}
      </footer>
    </div>
  );
}
