// FILE: components/FootballBets.jsx
import { useState, useEffect } from "react";

/**
 * FootballBets
 * Props:
 *  - date: YYYY-MM-DD (obavezno)
 *  - limit?: broj kartica za prikaz (npr. 3)
 *  - compact?: true za manji, tamni stil (za Combined levu kolonu)
 */
export default function FootballBets({ date, limit, compact = false }) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const formatPercent = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);

  const sortBets = (value_bets = []) =>
    value_bets
      .slice()
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
        return (b.edge || 0) - (a.edge || 0);
      });

  const explainBet = (bet) => {
    const fmt = (x) => (x != null ? `${(x * 100).toFixed(1)}%` : "-");
    if (bet.type === "MODEL+ODDS") {
      const implied = bet.market_odds ? 1 / bet.market_odds : null;
      return `Model: ${fmt(bet.model_prob)} vs Market: ${fmt(implied)} (odds ${bet.market_odds}) → edge ${fmt(
        bet.edge
      )}`;
    }
    return `Model-only: ${fmt(bet.model_prob)} (fallback)`;
  };

  async function fetchBets() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/value-bets?sport_key=soccer&date=${encodeURIComponent(
          date
        )}&min_edge=0.05&min_odds=1.3`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const all = Array.isArray(json.value_bets) ? json.value_bets : [];
      setBets(sortBets(all));
    } catch (e) {
      console.error("FootballBets fetch error", e);
      setError("Failed to load predictions.");
      setBets([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!date) return;
    fetchBets();
    const interval = setInterval(fetchBets, 2 * 60 * 60 * 1000); // every 2h
    return () => clearInterval(interval);
  }, [date]);

  const shown = typeof limit === "number" ? bets.slice(0, limit) : bets;

  // kompaktne tamne kartice za Combined
  if (compact) {
    return (
      <div className="space-y-3">
        {loading && (
          <div className="p-4 rounded-2xl bg-[#1f2339] text-slate-300 shadow">
            Loading predictions…
          </div>
        )}
        {error && (
          <div className="p-4 rounded-2xl bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/30 shadow">
            {error}
          </div>
        )}
        {!loading && !error && shown.length === 0 && (
          <div className="p-4 rounded-2xl bg-[#1f2339] text-slate-300 shadow">
            Nema dostupne fudbalske prognoze
          </div>
        )}
        {shown.map((bet) => {
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
          const home = teams?.home?.name || "Home";
          const away = teams?.away?.name || "Away";
          const timeStr = datetime_local?.starting_at?.date_time || "";
          return (
            <div
              key={`${fixture_id}|${market}|${selection}`}
              className="p-4 rounded-2xl bg-[#1f2339] text-slate-100 shadow border border-white/5"
            >
              <div className="flex justify-between items-start">
                <div className="font-semibold">
                  {home} vs {away}{" "}
                  <span className="text-xs text-slate-400">({market})</span>
                </div>
                <div
                  className={
                    "text-[10px] px-2 py-0.5 rounded-full " +
                    (type === "MODEL+ODDS"
                      ? "bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30"
                      : "bg-slate-500/15 text-slate-300 ring-1 ring-white/10")
                  }
                >
                  {type === "MODEL+ODDS" ? "MODEL+ODDS" : "FALLBACK"}
                </div>
              </div>
              <div className="text-sm mt-1">
                <div className="flex items-center gap-2">
                  <strong>Pick:</strong> {selection}
                  <span className="px-2 py-0.5 text-[11px] rounded-full bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30">
                    {market_odds || "-"}
                  </span>
                </div>
                {edge != null && (
                  <div className="text-[12px] text-slate-300 mt-1">
                    Edge: <span className="font-medium">{formatPercent(edge)}</span>
                  </div>
                )}
                <div className="text-[11px] text-slate-400">{explainBet(bet)}</div>
                <div className="text-[11px] text-slate-500 mt-1">Starts at: {timeStr}</div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // default (ne-compact) – kao i ranije
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">All Suggestions</h2>
      {loading && (
        <div className="p-4 bg-white rounded shadow text-gray-800">
          <div>Loading predictions...</div>
        </div>
      )}
      {error && (
        <div className="p-4 bg-red-50 rounded shadow">
          <div className="text-red-600">{error}</div>
        </div>
      )}
      {!loading && !error && shown.length === 0 && (
        <div className="p-4 border rounded bg-yellow-50 text-gray-800">
          <div>No suggestions available.</div>
        </div>
      )}
      <div className="space-y-4">
        {shown.map((bet) => {
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
          const home = teams?.home?.name || "Home";
          const away = teams?.away?.name || "Away";
          const timeStr = datetime_local?.starting_at?.date_time || "";
          return (
            <div
              key={`${fixture_id}|${market}|${selection}`}
              className="p-4 border rounded shadow-sm flex flex-col gap-2 bg-white text-gray-900"
            >
              <div className="flex justify-between items-start">
                <div className="font-semibold">
                  {home} vs {away} <span className="text-sm text-gray-500">({market})</span>
                </div>
                <div
                  className={`text-xs px-2 py-1 rounded ${
                    type === "MODEL+ODDS"
                      ? "bg-blue-100 text-blue-800"
                      : "bg-gray-100 text-gray-700"
                  }`}
                >
                  {type === "MODEL+ODDS" ? "MODEL+ODDS" : "FALLBACK"}
                </div>
              </div>
              <div className="text-sm flex flex-col gap-1">
                <div>
                  <strong>Pick:</strong> {selection} @ {market_odds || "-"}
                </div>
                {edge != null && (
                  <div>
                    <strong>Edge:</strong> {formatPercent(edge)}
                  </div>
                )}
                <div className="text-xs text-gray-600">{explainBet(bet)}</div>
                <div className="text-xs text-gray-500">Starts at: {timeStr}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
