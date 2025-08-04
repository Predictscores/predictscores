// components/FootballBets.jsx
import { useState, useEffect } from "react";

/**
 * FootballBets: prikazuje sve kvalifikovane value betove (MODEL+ODDS i fallback).
 * Props:
 *   - date: string u formatu YYYY-MM-DD
 */
export default function FootballBets({ date }) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const formatPercent = (x) => {
    if (x == null) return "-";
    return `${(x * 100).toFixed(1)}%`;
  };

  const sortBets = (value_bets = []) => {
    return value_bets
      .slice()
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
        return (b.edge || 0) - (a.edge || 0);
      });
  };

  const explainBet = (bet) => {
    const fmt = (x) => (x != null ? `${(x * 100).toFixed(1)}%` : "-");
    if (bet.type === "MODEL+ODDS") {
      const implied = bet.market_odds ? 1 / bet.market_odds : null;
      return `Model: ${fmt(bet.model_prob)} vs Market: ${fmt(implied)} (odds ${bet.market_odds}) → edge ${fmt(
        bet.edge
      )}`;
    } else {
      return `Model-only: ${fmt(bet.model_prob)} (fallback)`;
    }
  };

  const fetchBets = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/value-bets?sport_key=soccer&date=${encodeURIComponent(
          date
        )}&min_edge=0.05&min_odds=1.3`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const all = Array.isArray(json.value_bets) ? json.value_bets : [];
      const sorted = sortBets(all);
      setBets(sorted);
    } catch (e) {
      console.error("FootballBets fetch error", e);
      setError("Failed to load predictions.");
      setBets([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!date) return;
    fetchBets();
    const interval = setInterval(fetchBets, 2 * 60 * 60 * 1000); // every 2h
    return () => clearInterval(interval);
  }, [date]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">All Suggestions</h2>
      {loading && (
        <div className="p-4 bg-white rounded shadow">
          <div>Loading predictions...</div>
        </div>
      )}
      {error && (
        <div className="p-4 bg-red-50 rounded shadow">
          <div className="text-red-600">{error}</div>
        </div>
      )}
      {!loading && !error && bets.length === 0 && (
        <div className="p-4 border rounded bg-yellow-50">
          <div>No suggestions available.</div>
        </div>
      )}
      <div className="space-y-4">
        {bets.map((bet) => {
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
              className="p-4 border rounded shadow-sm flex flex-col gap-2 bg-white"
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
