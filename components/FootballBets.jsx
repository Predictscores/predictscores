// FILE: components/FootballBets.jsx
import { useState, useEffect } from "react";

/**
 * FootballBets: prikazuje value betove (do 10) iz /api/value-bets
 * - Bez promene visine kartice: zadržavamo isto raspoređivanje,
 *   ali “explain” liniju zamenjujemo sa “league • kickoff” i “H2H (5)”.
 */
export default function FootballBets({ date }) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const formatPercent = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);

  const fetchBets = async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (date) q.set("date", date);
      const res = await fetch(`/api/value-bets?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const arr = Array.isArray(json.value_bets) ? json.value_bets : [];
      setBets(arr);
    } catch (e) {
      console.error("FootballBets fetch error", e);
      setError("Failed to load predictions.");
      setBets([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBets();
    const iv = setInterval(fetchBets, 2 * 60 * 60 * 1000); // refresh na 2h
    return () => clearInterval(iv);
  }, [date]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">All Suggestions</h2>

      {loading && (
        <div className="p-4 bg-white/5 rounded border border-white/10 shadow">
          Loading predictions...
        </div>
      )}
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded shadow">
          {error}
        </div>
      )}
      {!loading && !error && bets.length === 0 && (
        <div className="p-4 border rounded bg-yellow-50 text-yellow-900">
          No suggestions available.
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
            league,
            confidence_pct,
            confidence_bucket,
            h2h,
          } = bet;

          const home = teams?.home?.name || "Home";
          const away = teams?.away?.name || "Away";
          const timeStr =
            datetime_local?.starting_at?.date_time || "";

          const confColor =
            confidence_bucket === "TOP"
              ? "bg-orange-500"
              : confidence_bucket === "High"
              ? "bg-green-500"
              : confidence_bucket === "Moderate"
              ? "bg-blue-500"
              : "bg-yellow-500";

          // H2H rezime (jedna linija, bez povećanja kartice)
          const h2hLine =
            h2h && typeof h2h === "object"
              ? `H2H (5): H${h2h.H} D${h2h.D} A${h2h.A} • G: ${h2h.gH}-${h2h.gA}`
              : null;

          return (
            <div
              key={`${fixture_id}|${market}|${selection}`}
              className="p-4 rounded-2xl shadow-sm border border-white/10 bg-[#1f2339] text-white"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="font-semibold text-lg">
                  {home} vs {away}{" "}
                  <span className="text-sm text-gray-400">
                    ({market})
                  </span>
                </div>
                <span
                  className={`text-[10px] px-2 py-1 rounded-full ${confColor}`}
                  title={`Confidence: ${confidence_pct ?? ""}%`}
                >
                  {confidence_bucket || "—"}
                </span>
              </div>

              {/* Liga • kickoff (zamena za stari "explain" red) */}
              <div className="mt-1 text-xs text-gray-300">
                <span className="font-medium">
                  {league?.name || "League"}
                </span>{" "}
                • {timeStr}
              </div>

              {/* Drugi red (i dalje drži istu visinu kao pre): Pick/odds + edge */}
              <div className="text-sm mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <div>
                  <strong>Pick:</strong> {selection}
                  {market_odds ? ` @ ${market_odds}` : ""}
                </div>
                {edge != null && (
                  <div className="text-gray-300">
                    <strong>Edge:</strong> {formatPercent(edge)}
                  </div>
                )}
                <div className="text-gray-300">
                  <strong>Model:</strong> {formatPercent(model_prob)}
                </div>
                <div className="text-gray-300">
                  <strong>Type:</strong>{" "}
                  {type === "MODEL+ODDS" ? "MODEL+ODDS" : "FALLBACK"}
                </div>
              </div>

              {/* Jedna linija za H2H (ako postoji) */}
              {h2hLine && (
                <div className="mt-1 text-xs text-gray-300 truncate">
                  {h2hLine}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
