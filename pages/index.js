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
      // prefer higher edge, fallback to model_prob if edge missing
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

  // date used for bets
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Init dark mode from localStorage or prefers-color-scheme
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem('dark-mode');
    if (stored === 'true') setIsDark(true);
    else if (stored === 'false') setIsDark(false);
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches)
      setIsDark(true);
  }, []);

  useEffect(() => {
    if (isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    if (typeof window !== 'undefined') {
      localStorage.setItem('dark-mode', isDark ? 'true' : 'false');
    }
  }, [isDark]);

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

  const topFootball = footballData?.footballTop || [];
  const topCrypto = cryptoData?.cryptoTop || [];
  const combinedPairs = [0, 1, 2];

  // Fetch value bets from backend (football)
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
        throw new Error(`Fetch error ${res.status}: ${t}`);
      }
      const json = await res.json();
      const bets = Array.isArray(json.value_bets) ? json.value_bets : [];
      setValueBets(sortValueBets(bets));
    } catch (e) {
      console.error('value-bets fetch failed', e);
      setValueBetsError('Failed to load value bets');
      setValueBets([]);
    } finally {
      setLoadingValueBets(false);
    }
  };

  useEffect(() => {
    fetchValueBets();
    const interval = setInterval(fetchValueBets, 2 * 60 * 60 * 1000); // every 2h
    return () => clearInterval(interval);
  }, [today]);

  // Derive top3 football value bets (for combined)
  const topValueBets = valueBets.slice(0, 3);
  // For combined slots, fallback to original topFootball if there is no corresponding value bet
  const combinedFootballSlots = combinedPairs.map((i) => topValueBets[i] || topFootball[i]);

  // For football tab: if valueBets present use those, else fallback to old ones
  const displayFootballPicks =
    valueBets && valueBets.length > 0
      ? valueBets.slice(0, 10)
      : topFootball.slice(0, 10);

  // Card for a value bet (football) using existing style
  const ValueBetCard = ({ bet }) => {
    if (!bet) return null;
    const {
      fixture_id,
      market,
      selection,
      type,
      model_prob,
      market_odds,
      edge,
      datetime_local,
      teams,
    } = bet;
    const home = teams?.home?.name || 'Home';
    const away = teams?.away?.name || 'Away';
    const timeStr = datetime_local?.starting_at?.date_time || '';
    const explanation = explainBet(bet);
    return (
      <div className="bg-[#1f2339] p-5 rounded-2xl shadow flex flex-col gap-2">
        <div className="flex justify-between items-start">
          <div className="font-semibold">
            {home} vs {away}{' '}
            <span className="text-sm text-gray-400">({market || '—'})</span>
          </div>
          <div
            className={`text-xs px-2 py-1 rounded ${
              type === 'MODEL+ODDS' ? 'bg-green-100 text-green-800' : 'bg-gray-800 text-gray-300'
            }`}
          >
            {type === 'MODEL+ODDS' ? 'Real + Odds' : 'FALLBACK'}
          </div>
        </div>
        <div className="text-sm flex flex-col gap-1">
          <div>
            <strong>Pick:</strong> {selection || '-'} @ {market_odds || '-'}
          </div>
          {edge != null && (
            <div>
              <strong>Edge:</strong> {formatPercent(edge)}
            </div>
          )}
          <div className="text-xs text-gray-400">{explanation}</div>
          <div className="text-xs text-gray-500">Starts at: {timeStr}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#18191c] text-white">
      {/* Header */}
      <header className="w-full grid grid-cols-[auto_1fr_auto] items-start gap-4 py-4 px-6">
        {/* left: tabs */}
        <div className="flex gap-1 items-center">
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
        </div>

        {/* center: title */}
        <div className="flex justify-center">
          <div className="text-xl font-bold">AI Top fudbalske i Kripto Prognoze</div>
        </div>

        {/* right: controls + timers pill */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-3">
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
          <div>
            <div className="bg-[#1f2339] px-4 py-2 rounded-full flex flex-col sm:flex-row gap-2 text-sm text-gray-300 font-medium">
              <div className="flex gap-1 items-center">
                <span className="text-white">Crypto next refresh:</span>
                <span className="font-mono">{getCountdown(nextCryptoUpdate)}</span>
              </div>
              <div className="flex gap-1 items-center">
                <span className="text-white">Football last generated:</span>
                <span className="font-mono">{formatTime(footballData?.generated_at)}</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mt-2 space-y-4 px-6">
        {(loadingFootball || loadingCrypto) && (
          <div className="text-center text-gray-400">Učitavanje podataka...</div>
        )}

        {/* Combined */}
        {activeTab === TABS.COMBINED && (
          <>
            {combinedFootballSlots.every((b) => !b) && topCrypto.length === 0 && (
              <div className="text-center text-gray-400 mb-4">
                Nema dostupnih kombinovanih predloga.
              </div>
            )}
            {combinedPairs.map((i) => (
              <div
                key={i}
                className="flex flex-col md:flex-row gap-4 md:min-h-[160px] items-stretch"
              >
                {/* Football 33% */}
                <div className="md:w-1/3 flex">
                  {combinedFootballSlots[i] ? (
                    <div className="w-full flex">
                      <ValueBetCard bet={combinedFootballSlots[i]} />
                    </div>
                  ) : topFootball[i] ? (
                    <div className="w-full flex">
                      <SignalCard data={topFootball[i]} type="football" />
                    </div>
                  ) : (
                    <div className="w-full bg-[#1f2339] p-3 rounded-2xl text-gray-400 flex items-center justify-center">
                      Nema dostupne fudbalske prognoze
                    </div>
                  )}
                </div>

                {/* Crypto 67% */}
                <div className="md:w-2/3 flex">
                  {topCrypto[i] ? (
                    <div className="w-full flex">
                      <SignalCard data={topCrypto[i]} type="crypto" />
                    </div>
                  ) : (
                    <div className="w-full bg-[#1f2339] p-3 rounded-2xl text-gray-400 flex items-center justify-center">
                      Nema dostupnog kripto signala
                    </div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Football only */}
        {activeTab === TABS.FOOTBALL && (
          <>
            <h2 className="text-2xl font-bold">Top Football Picks</h2>
            <div className="grid grid-cols-1 gap-6">
              {loadingValueBets && (
                <div className="text-center text-gray-400">Učitavanje predloga...</div>
              )}
              {!loadingValueBets &&
                (displayFootballPicks.length > 0 ? (
                  displayFootballPicks.map((bet, idx) => (
                    <div key={idx} className="bg-[#1f2339] p-5 rounded-2xl shadow flex">
                      <ValueBetCard bet={bet} />
                    </div>
                  ))
                ) : (
                  <div className="text-center text-gray-400">
                    Nema dostupnih fudbalskih predloga.
                  </div>
                ))}
            </div>
          </>
        )}

        {/* Crypto only */}
        {activeTab === TABS.CRYPTO && (
          <>
            <h2 className="text-2xl font-bold">Top Crypto Signals</h2>
            <div className="grid grid-cols-1 gap-6">
              {topCrypto.length > 0 ? (
                topCrypto.slice(0, 10).map((signal, idx) => (
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

        {valueBetsError && (
          <div className="text-red-400 text-center">{valueBetsError}</div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-12 mb-8 px-6 text-center text-sm text-gray-400">
        <div className="inline-flex gap-2 flex-wrap justify-center">
          <div>
            <span className="font-semibold">Confidence:</span>{' '}
          </div>
          <div className="flex gap-1 flex-wrap justify-center">
            <div>🟢 High (80–90%)</div>
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
