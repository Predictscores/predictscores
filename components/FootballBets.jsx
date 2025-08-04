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
      let all = Array.isArray(json.value_bets) ? json.value_bets : [];
      all.sort((a, b) => {
        if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
        return (b.edge || 0) - (a.edge || 0);
      });
      setBets(all);
    } catch (e) {
      console.error("FootballBets fetch error", e);
      setError("Failed to load predictions.");
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

  if (loading)
    return (
      <div className="p-4 bg-white rounded shadow">
        <div>Loading predictions...</div>
      </div>
    );
  if (error)
    return (
      <div className="p-4 bg-red-50 rounded shadow">
        <div className="text-red-600">{error}</div>
      </div>
    );
  if (!bets.length)
    return (
      <div className="p-4 border rounded bg-yellow-50">
        <div>No suggestions available.</div>
      </div>
    );

  return (
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
        const implied = market_odds ? 1 / market_odds : null;
        const home = teams?.home?.name || "Home";
        const away = teams?.away?.name || "Away";
        const timeStr = datetime_local?.starting_at?.date_time || "";
        const explanation =
          type === "MODEL+ODDS"
            ? `Model: ${formatPercent(model_prob)} vs Market: ${formatPercent(
                implied
              )} (odds ${market_odds}) → edge ${formatPercent(edge)}`
            : `Model-only: ${formatPercent(model_prob)} (fallback)`;

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
                  type === "MODEL+ODDS" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"
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
              <div className="text-xs text-gray-600">{explanation}</div>
              <div className="text-xs text-gray-500">Starts at: {timeStr}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
