import { useEffect, useMemo, useState } from "react";

/**
 * FootballBets: prikazuje kvalifikovane value betove (MODEL+ODDS i fallback).
 * Props:
 *   - date?: string (YYYY-MM-DD)
 *   - limit?: number  -> maksimalan broj kartica za prikaz (npr. 3 na Combined tabu)
 */
export default function FootballBets({ date, limit }) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ---------- helpers ----------
  const formatPercent = (x, d = 1) => {
    if (x == null || Number.isNaN(x)) return "-";
    return `${(x * 100).toFixed(d)}%`;
  };

  const bucketForPct = (pct) => {
    if (pct >= 90) return "TOP";
    if (pct >= 75) return "High";
    if (pct >= 50) return "Moderate";
    return "Low";
  };

  const ensureConfidence = (b) => {
    let pct =
      typeof b.confidence_pct === "number"
        ? b.confidence_pct
        : typeof b.model_prob === "number"
        ? Math.round(b.model_prob * 100)
        : null;

    let bucket = b.confidence_bucket;
    if (!bucket && pct != null) bucket = bucketForPct(pct);

    return { ...b, confidence_pct: pct, confidence_bucket: bucket };
  };

  const sortBets = (arr = []) =>
    arr
      .slice()
      .sort((a, b) => {
        // 1) MODEL+ODDS pre FALLBACK
        if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;

        // 2) veći edge (ako postoji)
        const ea = a.edge ?? -1;
        const eb = b.edge ?? -1;
        if (ea !== eb) return eb - ea;

        // 3) veći confidence_pct
        const ca = a.confidence_pct ?? 0;
        const cb = b.confidence_pct ?? 0;
        return cb - ca;
      });

  // ---------- data fetch ----------
  const fetchBets = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        date: date || "",
        min_edge: "0.05",
        min_odds: "1.3",
      });
      const res = await fetch(`/api/value-bets?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const arr = Array.isArray(json.value_bets) ? json.value_bets : [];
      // obogati confidence i sortiraj
      const enhanced = arr.map(ensureConfidence);
      const sorted = sortBets(enhanced);
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
    fetchBets();
    // refetch na 2h
    const iv = setInterval(fetchBets, 2 * 60 * 60 * 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // render-lista koja POŠTUJE limit bez obzira na stanje u memoriji
  const list = useMemo(() => {
    if (!Array.isArray(bets)) return [];
    return limit ? bets.slice(0, Number(limit)) : bets;
  }, [bets, limit]);

  // ---------- UI ----------
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">All Suggestions</h2>

      {loading && (
        <div className="p-4 bg-white/5 rounded-lg border border-white/10">
          <div>Loading predictions...</div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-500/10 text-red-300 rounded-lg border border-red-500/30">
          {error}
        </div>
      )}

      {!loading && !error && list.length === 0 && (
        <div className="p-4 bg-yellow-500/10 text-yellow-200 rounded-lg border border-yellow-500/20">
          No suggestions available.
        </div>
      )}

      <div className="space-y-4">
        {list.map((bet) => {
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
          } = bet;

          const home = teams?.home?.name || "Home";
          const away = teams?.away?.name || "Away";
          const timeStr =
            datetime_local?.starting_at?.date_time ||
            datetime_local?.date_time ||
            "";

          const badge =
            type === "MODEL+ODDS"
              ? "bg-blue-100 text-blue-800"
              : "bg-gray-200 text-gray-800";

          const confColor =
            confidence_bucket === "TOP"
              ? "bg-orange-500"
              : confidence_bucket === "High"
              ? "bg-green-500"
              : confidence_bucket === "Moderate"
              ? "bg-blue-500"
              : "bg-yellow-400";

          return (
            <div
              key={`${fixture_id}|${market}|${selection}`}
              className="p-4 rounded-2xl bg-[#1f2339] shadow-sm border border-white/5"
            >
              {/* Header row */}
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-white">
                  {home} <span className="text-white/60">vs</span> {away}{" "}
                  <span className="text-sm text-white/50">({market})</span>
                </div>

                {/* League pill */}
                <div className="text-xs px-2 py-1 rounded-full bg-white/10 text-white/80">
                  {league?.name || "League"}
                </div>
              </div>

              {/* Pick / type */}
              <div className="mt-2 flex items-center gap-3 text-sm">
                <div>
                  <span className="text-white/70">Pick:</span>{" "}
                  <span className="font-semibold text-white">{selection}</span>
                  {market_odds ? (
                    <span className="text-white/60"> @ {market_odds}</span>
                  ) : null}
                </div>
                <div className={`text-xs px-2 py-1 rounded ${badge}`}>
                  {type}
                </div>
              </div>

              {/* Model prob & edge */}
              <div className="mt-2 text-xs text-white/70 flex flex-wrap gap-4">
                {model_prob != null && (
                  <div>
                    <span className="text-white/50">Model: </span>
                    <span className="text-white">
                      {formatPercent(model_prob)}
                    </span>
                  </div>
                )}
                {edge != null && (
                  <div>
                    <span className="text-white/50">Edge: </span>
                    <span className="text-white">{formatPercent(edge)}</span>
                  </div>
                )}
                <div className="text-white/50">Starts at: {timeStr}</div>
              </div>

              {/* Confidence bar */}
              <div className="mt-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-white/60">Confidence</span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${confColor} text-black font-semibold`}
                  >
                    {confidence_bucket || "—"}
                  </span>
                  <span className="text-white/60">
                    {confidence_pct != null ? `${confidence_pct}%` : "—"}
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-emerald-400/90"
                    style={{
                      width: `${
                        typeof confidence_pct === "number"
                          ? Math.max(0, Math.min(100, confidence_pct))
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
