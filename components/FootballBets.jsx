// FILE: components/FootballBets.jsx
import React, { useEffect, useMemo, useState } from "react";

/**
 * FootballBets
 * - Čita /api/value-bets
 * - Prikazuje Top N (po server-sidu rangirane)
 * - Ima "last generated" tajmer (živ), i kompaktan prikaz za Combined
 *
 * Props:
 *  - limit: broj kartica (default 10)
 *  - layout: "combined" | "full"  (combined = tanje kartice + bez velikog naslova)
 */
export default function FootballBets({ limit = 10, layout = "full" }) {
  const [bets, setBets] = useState([]);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [now, setNow] = useState(Date.now());

  const fetchBets = async () => {
    setLoading(true);
    setErr(null);
    try {
      // uzmi malo veći pool, server će rangirati, a ovde sečemo na limit
      const res = await fetch(`/api/value-bets?max=60`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const all = Array.isArray(json.value_bets) ? json.value_bets : [];
      setBets(all.slice(0, limit));
      setGeneratedAt(json.generated_at || null);
    } catch (e) {
      console.error("FootballBets fetch error", e);
      setErr("Failed to load predictions.");
      setBets([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBets();
    const iv = setInterval(fetchBets, 2 * 60 * 60 * 1000); // refresh na 2h
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  // živi "ago" tajmer
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  const lastGeneratedAgo = useMemo(() => {
    if (!generatedAt) return null;
    const t = new Date(generatedAt).getTime();
    if (!Number.isFinite(t)) return null;
    const diffMs = now - t;
    if (diffMs < 0) return "just now";
    const s = Math.floor(diffMs / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  }, [generatedAt, now]);

  const formatPct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  const formatPct0 = (x) => (x == null ? "—" : `${x.toFixed(0)}%`);
  const confColor = (bucket) =>
    bucket === "TOP"
      ? "bg-emerald-500"
      : bucket === "High"
      ? "bg-green-500"
      : bucket === "Moderate"
      ? "bg-blue-500"
      : "bg-yellow-400";

  const wrapperClasses =
    layout === "combined"
      ? "space-y-3"
      : "space-y-4";

  const titleBlock =
    layout === "combined" ? null : (
      <div className="flex items-end justify-between">
        <h2 className="text-xl font-semibold">Football — All Suggestions</h2>
        <div className="text-xs text-gray-400">
          {generatedAt ? (
            <>
              <span className="font-medium text-gray-300">Last generated:</span>{" "}
              {new Date(generatedAt).toLocaleString("en-GB", {
                hour12: false,
              })}{" "}
              <span className="opacity-75">({lastGeneratedAgo})</span>
            </>
          ) : (
            <span>—</span>
          )}
        </div>
      </div>
    );

  return (
    <div className={wrapperClasses}>
      {/* Header for combined: mali, poravnat desno ispod top dugmića */}
      {layout === "combined" && (
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Top {limit} Football Picks</h3>
          <div className="text-[11px] text-gray-400">
            {generatedAt ? (
              <>
                <span className="font-medium text-gray-300">Football last generated:</span>{" "}
                {lastGeneratedAgo}
              </>
            ) : (
              <span>—</span>
            )}
          </div>
        </div>
      )}

      {layout !== "combined" && titleBlock}

      {loading && (
        <div className="p-4 bg-[#1f2339] rounded-2xl shadow">
          <div className="text-sm">Loading predictions…</div>
        </div>
      )}
      {err && (
        <div className="p-4 bg-red-50 rounded-2xl shadow">
          <div className="text-red-600">{err}</div>
        </div>
      )}
      {!loading && !err && bets.length === 0 && (
        <div className="p-4 border rounded-2xl bg-yellow-50">
          <div>No suggestions available.</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {bets.map((bet) => {
          const {
            fixture_id,
            market,
            selection,
            type,
            model_prob,
            market_odds,
            confidence_pct,
            confidence_bucket,
            datetime_local,
            teams,
            league,
          } = bet;

          const home = teams?.home?.name || "Home";
          const away = teams?.away?.name || "Away";
          const leagueName = league?.name || "League";
          const timeStr =
            datetime_local?.starting_at?.date_time ||
            "";

          return (
            <div
              key={`${fixture_id}|${market}|${selection}`}
              className="bg-[#1f2339] rounded-2xl shadow p-4 flex flex-col gap-3 h-full min-h-48"
            >
              {/* Header row: timovi + liga + kickoff */}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold text-lg leading-tight">
                    {home} <span className="text-gray-400">vs</span> {away}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {leagueName} • {timeStr}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* selection pill */}
                  <div className="text-[11px] px-2 py-1 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-200">
                    {market}: <span className="font-semibold">{selection}</span>
                    {market_odds ? ` @ ${market_odds}` : ""}
                  </div>
                  {/* type badge */}
                  <div
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${
                      type === "MODEL+ODDS"
                        ? "border-green-500 text-green-300"
                        : "border-gray-500 text-gray-300"
                    }`}
                  >
                    {type}
                  </div>
                </div>
              </div>

              {/* Sadržaj: dva stuba – levo objašnjenje, desno confidence bar */}
              <div className="flex items-end gap-4">
                <div className="text-xs text-gray-300 flex-1">
                  {/* kratko objašnjenje bez zauzimanja mnogo prostora */}
                  Model: {formatPct(model_prob)}{" "}
                  {market_odds ? (
                    <>
                      • EV target ≥ 3% • bookies ≥ 6
                    </>
                  ) : (
                    <>• Fallback (no market)</>
                  )}
                </div>

                {/* Confidence bar */}
                <div className="flex-1">
                  <div className="flex items-center justify-between text-[11px] text-gray-400 mb-1">
                    <span>Confidence</span>
                    <span className="text-gray-300 font-medium">
                      {formatPct0(confidence_pct || 0)}{" "}
                      <span className="text-gray-400">
                        ({confidence_bucket || "—"})
                      </span>
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={`h-2 ${confColor(confidence_bucket)} transition-all`}
                      style={{ width: `${confidence_pct || 0}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer last generated (za full layout dole) */}
      {layout !== "combined" && (
        <div className="flex justify-end">
          <div className="text-xs text-gray-400">
            {generatedAt ? (
              <>
                <span className="font-medium text-gray-300">Last generated:</span>{" "}
                {new Date(generatedAt).toLocaleString("en-GB", { hour12: false })}{" "}
                <span className="opacity-75">({lastGeneratedAgo})</span>
              </>
            ) : (
              <span>—</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
