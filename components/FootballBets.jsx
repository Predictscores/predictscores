// FILE: components/FootballBets.jsx
import React, { useEffect, useMemo, useState } from "react";

/**
 * FootballBets
 * - čita /api/value-bets
 * - Combined: header = "Next kickoff in …" (Europe/Belgrade)
 * - Kartice: 🇩🇪 Liga • 19:00  | velika značka tipa + kvota | mini "Top tips" pilovi | confidence pri dnu
 *
 * Props:
 *  - limit: broj prikazanih kartica (default 10)
 *  - layout: "combined" | "full"
 */

export default function FootballBets({ limit = 10, layout = "full" }) {
  const [bets, setBets] = useState([]);
  const [allTimes, setAllTimes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [now, setNow] = useState(Date.now());

  // --- helpers ---------------------------------------------------------------

  const flagFor = (country) => {
    if (!country) return "🌍";
    const c = String(country).toLowerCase();
    const map = {
      germany: "🇩🇪",
      deutschland: "🇩🇪",
      serbia: "🇷🇸",
      srbija: "🇷🇸",
      england: "🇬🇧",
      "united kingdom": "🇬🇧",
      spain: "🇪🇸",
      france: "🇫🇷",
      italy: "🇮🇹",
      netherlands: "🇳🇱",
      belgium: "🇧🇪",
      portugal: "🇵🇹",
      denmark: "🇩🇰",
      sweden: "🇸🇪",
      norway: "🇳🇴",
      iceland: "🇮🇸",
      "faroe-islands": "🇫🇴",
      "faroe islands": "🇫🇴",
      poland: "🇵🇱",
      czechia: "🇨🇿",
      "czech republic": "🇨🇿",
      croatia: "🇭🇷",
      slovenia: "🇸🇮",
      switzerland: "🇨🇭",
      austria: "🇦🇹",
      romania: "🇷🇴",
      bulgaria: "🇧🇬",
      greece: "🇬🇷",
      turkey: "🇹🇷",
      scotland: "🏴",
    };
    return map[c] || "🌍";
  };

  // zadrži ime lige (bez zemlje)
  const shortLeague = (/* country, */ _leagueName) => {
    return _leagueName || "League";
  };

  const toUTCms = (s) => {
    if (!s) return null;
    const iso = s.includes("T") ? s : s.replace(" ", "T");
    const withZ = iso.endsWith("Z") ? iso : iso + "Z";
    const t = Date.parse(withZ);
    return Number.isFinite(t) ? t : null;
  };

  const fmtKickLocal = (s) => {
    const t = toUTCms(s);
    if (!t) return "—";
    try {
      return new Intl.DateTimeFormat("sr-RS", {
        timeZone: "Europe/Belgrade",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(t));
    } catch {
      return "—";
    }
  };

  const countdownToNext = useMemo(() => {
    const future = allTimes
      .map(toUTCms)
      .filter((ms) => ms && ms > now)
      .sort((a, b) => a - b);
    if (!future.length) return null;
    const diff = future[0] - now;
    if (diff <= 0) return "0m 00s";
    const sec = Math.floor(diff / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    }
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }, [allTimes, now]);

  const confColor = (bucket) =>
    bucket === "TOP"
      ? "bg-emerald-500"
      : bucket === "High"
      ? "bg-green-500"
      : bucket === "Moderate"
      ? "bg-blue-500"
      : "bg-yellow-400";

  // --- “top tips” iz dostupnih verovatnoća -------------------------------

  function buildTopTips(bet) {
    const tips = [];

    // 1X2 iz model_probs (ako postoji)
    const mp = bet?.model_probs || bet?.meta?.model_probs || null;
    if (mp && typeof mp === "object") {
      const map = [
        { k: "home", lbl: "1", p: Number(mp.home) || 0 },
        { k: "draw", lbl: "X", p: Number(mp.draw) || 0 },
        { k: "away", lbl: "2", p: Number(mp.away) || 0 },
      ];
      map.sort((a, b) => b.p - a.p);
      if (map[0].p > 0.5) {
        tips.push({ label: map[0].lbl, pct: Math.round(map[0].p * 100) });
      }
      // eventualno drugi ako je blizu i > 0.48
      if (map[1].p > 0.58 && tips.length < 2) {
        tips.push({ label: map[1].lbl, pct: Math.round(map[1].p * 100) });
      }
    }

    // BTTS
    const btts =
      bet?.btts_probability ??
      bet?.meta?.btts_prob ??
      bet?.meta?.btts_probability ??
      null;
    if (typeof btts === "number") {
      if (btts >= 0.58 && tips.length < 2) {
        tips.push({ label: "BTTS", pct: Math.round(btts * 100) });
      } else if (btts <= 0.42 && tips.length < 2) {
        tips.push({ label: "NO BTTS", pct: Math.round((1 - btts) * 100) });
      }
    }

    // Over/Under 2.5
    const o25 =
      bet?.over25_probability ??
      bet?.meta?.over25_prob ??
      bet?.meta?.over25_probability ??
      null;
    if (typeof o25 === "number" && tips.length < 2) {
      if (o25 >= 0.58) {
        tips.push({ label: "O2.5", pct: Math.round(o25 * 100) });
      } else if (o25 <= 0.42) {
        tips.push({ label: "U2.5", pct: Math.round((1 - o25) * 100) });
      }
    }

    return tips.slice(0, 2);
  }

  // --- data fetch ------------------------------------------------------------

  const fetchBets = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/value-bets?max=80`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const arr = Array.isArray(json.value_bets) ? json.value_bets : [];
      setBets(arr.slice(0, limit));
      const times = arr
        .map((b) => b?.datetime_local?.starting_at?.date_time)
        .filter(Boolean);
      setAllTimes(times);
    } catch (e) {
      console.error("FootballBets fetch error", e);
      setErr("Failed to load predictions.");
      setBets([]);
      setAllTimes([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBets();
    const refIv = setInterval(fetchBets, 2 * 60 * 60 * 1000);
    return () => clearInterval(refIv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const wrapperClasses =
    layout === "combined" ? "space-y-3" : "space-y-4";

  return (
    <div className={wrapperClasses}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-base md:text-lg font-semibold">
          {layout === "combined" ? `Top ${limit} Football Picks` : "Football — All Suggestions"}
        </h3>
        <div className="text-[11px] text-gray-400">
          {countdownToNext ? (
            <>
              <span className="font-medium text-gray-300">Next kickoff in:</span>{" "}
              {countdownToNext}
            </>
          ) : (
            <span>Next kickoff: —</span>
          )}
        </div>
      </div>

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

      {/* Cards */}
      <div className="grid grid-cols-1 gap-3">
        {bets.map((bet) => {
          const {
            fixture_id,
            market,
            selection,           // "1" | "X" | "2" | "BTTS" | "O2.5" ...
            market_odds,         // broj (decimal) ili null
            model_prob,
            confidence_pct,
            confidence_bucket,
            datetime_local,
            teams,
            league,
            meta,
          } = bet;

          const home = teams?.home?.name || "Home";
          const away = teams?.away?.name || "Away";
          const leagueName = shortLeague(league?.country, league?.name);
          const leagueFlag = flagFor(league?.country);
          const kickoffRaw = datetime_local?.starting_at?.date_time;
          const kickoffLocal = fmtKickLocal(kickoffRaw);

          const confPct =
            typeof confidence_pct === "number"
              ? Math.max(0, Math.min(100, confidence_pct))
              : Math.round((model_prob || 0) * 100);

          const topTips = buildTopTips(bet);

          return (
            <div
              key={`${fixture_id}|${market}|${selection}`}
              className="bg-[#1f2339] rounded-2xl shadow p-4 flex flex-col gap-3 h-full min-h-[220px]"
            >
              {/* Top row: liga + vreme + tip + kvota */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-lg leading-tight truncate">
                    {home} <span className="text-gray-400">vs</span> {away}
                  </div>

                  <div className="text-xs text-gray-300 mt-1 flex items-center gap-2">
                    <span className="text-lg leading-none">{leagueFlag}</span>
                    <span className="truncate">{leagueName}</span>
                    <span>•</span>
                    <span>{kickoffLocal}</span>
                  </div>

                  {/* mini Top tips pilovi (ako imamo podatke) */}
                  {topTips.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {topTips.map((t, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 text-[11px] rounded-full bg-white/10 border border-white/15 text-gray-100"
                          title="Najjače procene"
                        >
                          {t.label} · {t.pct}%
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* velika značka + kvota */}
                <div className="shrink-0 text-right">
                  <div className="flex items-center gap-2 justify-end">
                    <div className="w-12 h-12 rounded-full bg-indigo-500/20 border border-indigo-400/50 text-indigo-100 grid place-items-center text-lg font-bold">
                      {selection || "—"}
                    </div>
                    <div className="text-xs text-gray-300">
                      <div className="text-[10px] uppercase tracking-wide text-gray-400">
                        {market || "Pick"}
                      </div>
                      <div className="font-semibold">
                        @{market_odds ? Number(market_odds).toFixed(2) : "—"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Info linija (model %) */}
              <div className="text-xs text-gray-300">
                Model: {(Number(model_prob || 0) * 100).toFixed(1)}%
              </div>

              {/* Confidence pri dnu */}
              <div className="mt-auto">
                <div className="flex items-center justify-between text-[11px] text-gray-400 mb-1">
                  <span>Confidence</span>
                  <span className="text-gray-300 font-medium">
                    {confPct}%{" "}
                    <span className="text-gray-400">
                      ({confidence_bucket || "—"})
                    </span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-2 ${confColor(confidence_bucket)} transition-all`}
                    style={{ width: `${confPct}%` }}
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
