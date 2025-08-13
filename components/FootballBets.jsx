// FILE: components/FootballBets.jsx
import React, { useMemo, useState } from "react";
import useValueBets from "../hooks/useValueBets";
import TicketPanel from "./TicketPanel";

/** Helpers */
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
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}
function confPct(n) {
  if (Number.isFinite(n)) return `${Math.round(n)}%`;
  if (Number.isFinite(n?.confidence_pct)) return `${Math.round(n.confidence_pct)}%`;
  return "—";
}
const COMBINED_MIN_CONF = 70;

function todayYMD() {
  const now = new Date();
  const y = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return y;
}

/** Tiny helpers for “explain” text (2 kratke linije umesto EV/Edge) */
function shortSummary(pick) {
  // Primarno koristimo explain.summary ako postoji; očistimo brojeve/“pp” itd.
  const raw = pick?.explain?.summary || "";
  if (!raw) return "Solid signal vs market";
  // Ukloni brojeve/pp/%, ostavi kjučne reči
  const cleaned = raw
    .replace(/\b\d+(\.\d+)?%/g, "")
    .replace(/\b\d+(\.\d+)?pp/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[·|]/g, " ")
    .trim();
  // Skrati na ~60 karaktera
  return cleaned.length > 60 ? cleaned.slice(0, 57) + "…" : cleaned || "Model agrees with market";
}
function shortContext(pick) {
  if (pick?.h2h_summary) return "H2H insight present";
  if (pick?.bookmakers_count > 0) return "Broad odds coverage";
  if (pick?.lineups_status && pick.lineups_status !== "unknown") return "Lineups status known";
  return "Recent form considered";
}

/** Confidence badge text/emoji */
function confBadge(pct) {
  if (!Number.isFinite(pct)) return "Low";
  if (pct >= 90) return "🔥 Top";
  if (pct >= 75) return "High";
  if (pct >= 50) return "Moderate";
  return "Low";
}

/** Single card — NOVI raspored, stabilan na mobilu */
function Card({ pick }) {
  const league = pick?.league?.name || "—";
  const market = pick.market_label || pick.market || "";
  const sel = pick.selection || "";
  const odds =
    Number.isFinite(pick.market_odds) && pick.market_odds > 0
      ? pick.market_odds.toFixed(2)
      : null;

  const conf = Number.isFinite(pick.confidence_pct) ? pick.confidence_pct : null;

  return (
    <div className="bg-[#1f2339] rounded-2xl px-4 py-3 md:py-4 h-full flex flex-col">
      {/* Gornji red: liga + vreme  */}
      <div className="text-xs text-slate-400 flex items-center gap-2">
        {/* (opciono mesto za zastavicu) */}
        {/* <span className="text-base leading-none">🇪🇺</span> */}
        <span className="truncate">{league}</span>
        <span className="opacity-60">•</span>
        <span>{fmtTime(pick)}</span>
      </div>

      {/* Par */}
      <div className="mt-1 text-base md:text-lg font-semibold text-white leading-snug line-clamp-2">
        {pick?.teams?.home?.name} vs {pick?.teams?.away?.name}
      </div>

      {/* Igra i kvota */}
      <div className="mt-1 text-sm text-slate-200">
        <span className="font-semibold">{market}</span>
        {sel ? `: ${sel}` : ""}
        {odds ? <span className="text-slate-400"> @ {odds}</span> : null}
      </div>

      {/* Kratko “objašnjenje” – 2 reda */}
      <div className="mt-2 text-[13px] text-slate-300">
        <div className="line-clamp-1">{shortSummary(pick)}</div>
        <div className="line-clamp-1 text-slate-400">{shortContext(pick)}</div>
      </div>

      {/* FILLER */}
      <div className="flex-1" />

      {/* Confidence footer – uvek na dnu, fiksna visina */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
          <span>Confidence</span>
          <span className="text-white">{confPct(conf)}</span>
        </div>
        <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
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
        <div className="mt-1 text-[11px] text-slate-400">{confBadge(conf)}</div>
      </div>
    </div>
  );
}

export default function FootballBets({ limit = 10, layout = "full" }) {
  const date = todayYMD();
  const { bets = [], loading, error } = useValueBets(date);

  const [sortBy, setSortBy] = useState("kickoff"); // "kickoff" | "confidence"

  const filtered = useMemo(() => {
    let arr = Array.isArray(bets) ? bets.slice() : [];

    if (layout === "combined") {
      const strong = arr.filter((b) => (b.confidence_pct || 0) >= COMBINED_MIN_CONF);
      if (strong.length >= limit) {
        arr = strong;
      } else {
        const rest = arr
          .filter((b) => !(b.confidence_pct >= COMBINED_MIN_CONF))
          .sort((a, b) => Number(b.ev || -1) - Number(a.ev || -1));
        arr = strong.concat(rest);
      }
    }

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

  if (loading) return <div className="text-slate-400 text-sm">Loading football…</div>;
  if (error)
    return (
      <div className="text-amber-400 text-sm">
        Football feed error: {String(error)}
      </div>
    );

  /** COMBINED: jednostavna lista (kompaktne kartice) */
  if (layout === "combined") {
    return (
      <div className="grid grid-cols-1 gap-4 items-stretch">
        {top.map((p) => (
          <Card
            key={p.fixture_id || `${p.league?.id}-${p.teams?.home?.name}-${p.teams?.away?.name}`}
            pick={p}
          />
        ))}
        {top.length === 0 && (
          <div className="text-slate-400 text-sm">No football suggestions.</div>
        )}
      </div>
    );
  }

  /** FULL: 2 kolone — levo singles, desno tickets (više mesta za tickets) */
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start md:[grid-template-columns:3fr_2fr]">
      {/* LEFT: Controls + Singles */}
      <div className="md:col-span-1">
        {/* Controls */}
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

        {/* Singles list (kompaktnije na mobilu) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
          {top.map((p) => (
            <Card
              key={p.fixture_id || `${p.league?.id}-${p.teams?.home?.name}-${p.teams?.away?.name}`}
              pick={p}
            />
          ))}
          {top.length === 0 && (
            <div className="text-slate-400 text-sm">No football suggestions.</div>
          )}
        </div>
      </div>

      {/* RIGHT: Tickets (širi stub ~40%) */}
      <div className="md:col-span-1">
        <TicketPanel bets={filtered} />
      </div>
    </div>
  );
}
