// FILE: components/FootballBets.jsx
import { useState, useEffect } from "react";

/**
 * FootballBets: prikazuje value betove.
 * Props:
 *   - date?: string YYYY-MM-DD (ako izostane, koristi se današnji iz API-ja)
 *   - limit?: broj kartica (npr. 3 u Combined, 10 u Football tabu)
 *   - compact?: true za Combined (malo manja tipografija)
 */
export default function FootballBets({ date, limit = 10, compact = false }) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchBets = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/value-bets", window.location.origin);
      url.searchParams.set("sport_key", "soccer");
      if (date) {
        // >>> KLJUČNO: šaljemo date SAMO ako je prosleđen
        url.searchParams.set("date", date);
      }
      url.searchParams.set("min_edge", "0.05");
      url.searchParams.set("min_odds", "1.3");
      url.searchParams.set("fallback_min_prob", "0.52");

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const all = Array.isArray(json.value_bets) ? json.value_bets : [];
      const picked = limit ? all.slice(0, limit) : all;
      setBets(picked);
    } catch (e) {
      console.error("FootballBets fetch error", e);
      setError("Failed to load predictions.");
      setBets([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // više ne blokiramo ako date nije prosleđen; API koristi današnji dan
    fetchBets();
    const iv = setInterval(fetchBets, 2 * 60 * 60 * 1000); // every 2h
    return () => clearInterval(iv);
  }, [date]);

  if (loading) {
    return (
      <div className="space-y-4">
        <h2 className={`font-semibold ${compact ? "text-lg" : "text-xl"}`}>All Suggestions</h2>
        <div className="p-4 rounded-2xl bg-[#1f2339] text-gray-300">Loading predictions...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-4">
        <h2 className={`font-semibold ${compact ? "text-lg" : "text-xl"}`}>All Suggestions</h2>
        <div className="p-4 rounded-2xl bg-red-50 text-red-700">{error}</div>
      </div>
    );
  }
  if (bets.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className={`font-semibold ${compact ? "text-lg" : "text-xl"}`}>All Suggestions</h2>
        <div className="p-4 rounded-2xl bg-yellow-50 text-yellow-800">No suggestions available.</div>
      </div>
    );
  }

  const badgeByBucket = (b) => {
    if (b === "TOP") return "bg-orange-500 text-white";
    if (b === "High") return "bg-emerald-600 text-white";
    if (b === "Moderate") return "bg-sky-600 text-white";
    return "bg-amber-500 text-black";
  };
  const fmtOdds = (o) => (o ? `@${Number(o).toFixed(2)}` : "—");

  return (
    <div className="space-y-4">
      {!compact && <h2 className="text-xl font-semibold">All Suggestions</h2>}
      <div className="space-y-4">
        {bets.map((bet) => {
          const {
            fixture_id,
            market,
            selection,
            type,
            market_odds,
            datetime_local,
            teams,
            league,
            confidence_pct,
            confidence_bucket,
          } = bet;

          const home = teams?.home?.name || "Home";
          const away = teams?.away?.name || "Away";
          const timeStr = datetime_local?.starting_at?.date_time || "";
          const leagueName = league?.name || "League";

          return (
            <div
              key={`${fixture_id}|${market}|${selection}`}
              className="rounded-2xl bg-[#1f2339] text-white shadow p-4 flex flex-col gap-3 min-h-[260px]"
            >
              {/* Match & League */}
              <div className="flex items-center justify-between">
                <div className={`font-semibold ${compact ? "text-base" : "text-lg"}`}>
                  {home} <span className="text-gray-400">vs</span> {away}{" "}
                  <span className="text-xs text-gray-400">({market})</span>
                </div>
                <div className="text-xs px-2 py-1 rounded-full bg-indigo-600/20 border border-indigo-500/50 text-indigo-200">
                  {leagueName}
                </div>
              </div>

              {/* Pick + odds + type */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-sm">
                  <span className="font-semibold">Pick:</span>{" "}
                  <span className="inline-flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-white/10">{selection}</span>
                    <span className="text-gray-300">({market})</span>
                    <span className="px-2 py-0.5 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-200">
                      {fmtOdds(market_odds)}
                    </span>
                  </span>
                </div>
                <div
                  className={`text-[10px] px-2 py-0.5 rounded-full ${
                    type === "MODEL+ODDS"
                      ? "bg-blue-600/20 border border-blue-500/40 text-blue-200"
                      : "bg-gray-600/20 border border-gray-500/40 text-gray-300"
                  }`}
                >
                  {type}
                </div>
              </div>

              {/* Confidence bar */}
              <div className="flex items-center gap-2">
                <span className={`text-[11px] px-2 py-0.5 rounded-full ${badgeByBucket(confidence_bucket)}`}>
                  {confidence_bucket}
                </span>
                <div className="flex-1 h-2 rounded bg-white/10 overflow-hidden">
                  <div
                    className="h-2 bg-emerald-500"
                    style={{ width: `${Math.min(100, Math.max(0, confidence_pct))}%` }}
                  />
                </div>
                <span className="text-xs text-gray-300">{Math.round(confidence_pct)}%</span>
              </div>

              {/* Starts at */}
              <div className="text-xs text-gray-400">Starts at: {timeStr}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
