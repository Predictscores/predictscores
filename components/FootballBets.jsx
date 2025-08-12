// FILE: components/FootballBets.jsx
import React, { useMemo, useState } from "react";
import useValueBets from "../hooks/useValueBets";
import TicketPanel from "./TicketPanel";

/** Utils */
function parseISO(it) {
  try {
    const dt =
      it?.datetime_local?.starting_at?.date_time ||
      it?.datetime_local?.date_time ||
      it?.time?.starting_at?.date_time ||
      null;
    return dt ? dt.replace(" ", "T") : null;
  } catch {
    return null;
  }
}
function kickoffMs(it) {
  const iso = parseISO(it);
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}
function fmtTime(it) {
  const iso = parseISO(it);
  const d = iso ? new Date(iso) : null;
  return d
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
}
function confPct(n) {
  if (Number.isFinite(n)) return `${Math.round(n)}%`;
  if (Number.isFinite(n?.confidence_pct)) return `${Math.round(n.confidence_pct)}%`;
  return "—";
}

const COMBINED_MIN_CONF = 70; // Combined: tražimo ≥70%, dopuna po EV

function todayYMD() {
  const now = new Date();
  // uvek Beograd za konzistentnost prikaza
  const y = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return y; // "YYYY-MM-DD"
}

/** Single card */
function Card({ pick }) {
  const market = pick.market_label || pick.market || "";
  const sel = pick.selection || "";
  const odds =
    Number.isFinite(pick.market_odds) && pick.market_odds > 0
      ? pick.market_odds.toFixed(2)
      : null;

  const conf =
    Number.isFinite(pick.confidence_pct) ? pick.confidence_pct : null;
  let bucket = "Low";
  if (conf >= 90) bucket = "Top Pick";
  else if (conf >= 75) bucket = "High";
  else if (conf >= 50) bucket = "Moderate";

  const edgePP =
    Number.isFinite(pick.edge_pp) ? `${pick.edge_pp.toFixed(1)} pp` : "—";
  const evTxt =
    Number.isFinite(pick.ev) ? `${(pick.ev * 100).toFixed(1)}%` : "—";

  return (
    <div className="bg-[#1f2339] rounded-2xl p-4 h-full flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400">
            {pick.league?.name || "—"} • {fmtTime(pick)}
          </div>
          <div className="text-base font-semibold text-white">
            {pick.teams?.home?.name} vs {pick.teams?.away?.name}
          </div>
          <div className="text-sm text-slate-200 mt-1">
            <span className="font-semibold">{market}</span>: {sel}
            {odds ? <span className="text-slate-400"> @ {odds}</span> : null}
          </div>
        </div>

        {/* Confidence pill */}
        <div className="text-right">
          <div className="text-xs text-slate-400">Confidence</div>
          <div className="flex items-center gap-2">
            <div className="w-28 h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className={`h-2 ${
                  conf >= 90
                    ? "bg-orange-400"
                    : conf >= 75
                    ? "bg-emerald-400"
                    : conf >= 50
                    ? "bg-sky-400"
                    : "bg-amber-400"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, conf || 0))}%` }}
              />
            </div>
            <div className="text-xs text-white">{confPct(conf)}</div>
          </div>
          <div className="text-[11px] text-slate-400">{bucket}</div>
        </div>
      </div>

      {/* Micro row */}
      <div className="mt-3 text-xs text-slate-400">
        EV {evTxt} · Edge {edgePP} · {pick.bookmakers_count || 0} bookies
        {pick.h2h_summary ? ` · H2H ${pick.h2h_summary}` : ""}
      </div>

      {/* Why this pick */}
      {pick.explain?.summary ? (
        <div className="mt-3 text-[13px] text-slate-300">
          <span className="text-slate-400">Why: </span>
          {pick.explain.summary}
        </div>
      ) : null}

      <div className="flex-1" />
      <div className="mt-3 text-[11px] text-slate-500">
        {pick.type === "MODEL+ODDS" ? "Model + Odds" : "Model-only"}
      </div>
    </div>
  );
}

export default function FootballBets({ limit = 10, layout = "full" }) {
  const date = todayYMD();
  const { bets = [], loading, error } = useValueBets(date);

  // DVA dugmeta: Kickoff / Confidence
  const [sortBy, setSortBy] = useState("kickoff"); // "kickoff" | "confidence"

  const filtered = useMemo(() => {
    let arr = Array.isArray(bets) ? bets.slice() : [];

    // Combined: stroži filter (≥70%), dopuna po EV ako nema dovoljno
    if (layout === "combined") {
      const strong = arr.filter((b) => (b.confidence_pct || 0) >= COMBINED_MIN_CONF);
      if (strong.length >= limit) {
        arr = strong;
      } else {
        const rest = arr
          .filter((b) => !(b.confidence_pct >= COMBINED_MIN_CONF))
          .sort((a, b) => (Number(b.ev || -1) - Number(a.ev || -1)));
        arr = strong.concat(rest);
      }
    }

    // Sortiranje (samo u full layoutu)
    if (layout === "full") {
      if (sortBy === "kickoff") {
        arr.sort((a, b) => kickoffMs(a) - kickoffMs(b));
      } else {
        arr.sort((a, b) => (b.confidence_pct || 0) - (a.confidence_pct || 0));
      }
    }

    return arr;
  }, [bets, layout, limit, sortBy]);

  const top = useMemo(() => filtered.slice(0, limit), [filtered, limit]);

  if (loading)
    return <div className="text-slate-400 text-sm">Loading football…</div>;
  if (error)
    return (
        <div className="text-amber-400 text-sm">
          Football feed error: {String(error)}
        </div>
    );

  // ----- COMBINED: samo lista -----
  if (layout === "combined") {
    return (
      <div className="grid grid-cols-1 gap-4 items-stretch">
        {top.map((p) => (
          <Card key={p.fixture_id || `${p.league?.id}-${p.teams?.home?.name}`} pick={p} />
        ))}
        {top.length === 0 && (
          <div className="text-slate-400 text-sm">No football suggestions.</div>
        )}
      </div>
    );
  }

  // ----- FULL: levi stub (singles) + desni stub (tickets) -----
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
      {/* LEFT: Controls + Singles */}
      <div className="md:col-span-2">
        {/* Controls: dva dugmeta */}
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs text-slate-300">Sort by:</span>
          <div className="inline-flex rounded-lg overflow-hidden bg-[#1f2339]">
            <button
              type="button"
              onClick={() => setSortBy("kickoff")}
              className={
                "px-3 py-2 text-xs font-semibold transition " +
                (sortBy === "kickoff"
                  ? "bg-[#151830] text-white"
                  : "text-slate-300 hover:bg-[#202542]")
              }
            >
              Kickoff (Soonest)
            </button>
            <button
              type="button"
              onClick={() => setSortBy("confidence")}
              className={
                "px-3 py-2 text-xs font-semibold transition " +
                (sortBy === "confidence"
                  ? "bg-[#151830] text-white"
                  : "text-slate-300 hover:bg-[#202542]")
              }
            >
              Confidence (High → Low)
            </button>
          </div>
        </div>

        {/* Singles list */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
          {top.map((p) => (
            <Card key={p.fixture_id || `${p.league?.id}-${p.teams?.home?.name}`} pick={p} />
          ))}
          {top.length === 0 && (
            <div className="text-slate-400 text-sm">No football suggestions.</div>
          )}
        </div>
      </div>

      {/* RIGHT: Tickets 3× */}
      <div className="md:col-span-1">
        <TicketPanel bets={filtered} />
      </div>
    </div>
  );
}
