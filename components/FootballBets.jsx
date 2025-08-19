// FILE: components/FootballBets.jsx
import React, { useMemo } from "react";
import useValueBets from "../hooks/useValueBets";
import TicketPanel from "./TicketPanel";
import Tabs from "./Tabs";
import HistoryPanel from "./HistoryPanel";

/** Utils */
function parseISO(it) {
  try {
    const dt =
      it?.datetime_local?.starting_at?.date_time ||
      it?.datetime_local?.date_time ||
      it?.time?.starting_at?.date_time ||
      null;
    if (!dt) return null;
    const s = dt.replace(" ", "T");
    const hasTZ = /Z$|[+-]\d{2}:\d{2}$/.test(s);
    return hasTZ ? s : `${s}Z`;
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
    ? d.toLocaleTimeString([], {
        timeZone: "Europe/Belgrade",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}
function confPct(n) {
  if (Number.isFinite(n)) return `${Math.round(n)}%`;
  if (Number.isFinite(n?.confidence_pct)) return `${Math.round(n.confidence_pct)}%`;
  return "—";
}
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
// simple country -> emoji (fallback UEFA trophy)
const FLAG = new Map(Object.entries({
  "world": "🏆", "uefa": "🏆",
  "england":"🇬🇧","scotland":"🏴","wales":"🏴","northern ireland":"🏴",
  "spain":"🇪🇸","france":"🇫🇷","germany":"🇩🇪","italy":"🇮🇹","portugal":"🇵🇹","netherlands":"🇳🇱",
  "belgium":"🇧🇪","switzerland":"🇨🇭","austria":"🇦🇹","croatia":"🇭🇷","serbia":"🇷🇸","bosnia and herzegovina":"🇧🇦","slovenia":"🇸🇮","hungary":"🇭🇺","romania":"🇷🇴","bulgaria":"🇧🇬","greece":"🇬🇷","turkiye":"🇹🇷","turkey":"🇹🇷",
  "russia":"🇷🇺","ukraine":"🇺🇦","poland":"🇵🇱","czech-republic":"🇨🇿","czech republic":"🇨🇿","slovakia":"🇸🇰",
  "usa":"🇺🇸","united-states":"🇺🇸","united states":"🇺🇸","canada":"🇨🇦","mexico":"🇲🇽","brazil":"🇧🇷","argentina":"🇦🇷","uruguay":"🇺🇾","chile":"🇨🇱","colombia":"🇨🇴","peru":"🇵🇪",
  "japan":"🇯🇵","south-korea":"🇰🇷","south korea":"🇰🇷","china":"🇨🇳","india":"🇮🇳","bhutan":"🇧🇹","egypt":"🇪🇬","morocco":"🇲🇦",
}));
function flagEmoji(country, leagueName="") {
  const c = String(country||"").toLowerCase().trim();
  if (!c || c==="null" || c==="undefined" || c==="world") {
    if (/uefa|champions|europa|conference/i.test(leagueName||"")) return "🏆";
    return "🌍";
  }
  return FLAG.get(c) || "🏳️";
}

// ---- badge za confidence
function confBadge(conf) {
  if (conf >= 90) return "🔥 Top Pick";
  if (conf >= 75) return "🟢 High";
  if (conf >= 50) return "🔵 Moderate";
  return "🟡 Low";
}

function shortWhy(p) {
  const s = p?.explain?.summary;
  if (s && typeof s === "string" && s.trim()) return s.trim();
  const mk = p?.market_label || p?.market || "";
  const sel = p?.selection || "";
  return [mk && sel ? `${mk}: ${sel}` : null].filter(Boolean).join(" · ");
}

/** Single card */
function Card({ pick }) {
  const market = pick.market_label || pick.market || "";
  const sel = pick.selection || "";
  const odds = Number.isFinite(pick.market_odds) && pick.market_odds > 0 ? pick.market_odds.toFixed(2) : null;
  const conf = Number.isFinite(pick.confidence_pct) ? pick.confidence_pct : null;

  const leagueName = pick.league?.name || "—";
  const country = pick.league?.country || pick.league?.cc || null;
  const flag = flagEmoji(country, leagueName);

  return (
    <div className="bg-[#1f2339] rounded-2xl p-4 h-full flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-slate-400 truncate">
            <span className="mr-1">{flag}</span>{leagueName} • {fmtTime(pick)}
          </div>
          <div className="text-base font-semibold text-white leading-snug">
            <span className="truncate block">
              {pick.teams?.home?.name} vs {pick.teams?.away?.name}
            </span>
          </div>

          <div className="text-sm text-slate-200 mt-1">
            <span className="font-semibold">{market}</span>: {sel}
            {odds ? <span className="text-slate-400"> ({odds})</span> : null}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-xs text-slate-300">{confBadge(conf || 0)}</div>
        </div>
      </div>

      <div className="mt-3 text-[13px] text-slate-300">
        <span className="text-slate-400">Zašto: </span>
        {shortWhy(pick) || "Povoljan odnos kvote i modela."}
      </div>

      {pick._insight_line ? (
        <div className="mt-2 text-[12px] text-slate-400">
          {pick._insight_line}
        </div>
      ) : null}

      <div className="flex-1" />

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Confidence</span>
          <span className="text-white">{confPct(conf)}</span>
        </div>
        <div className="mt-1 w-full h-2 bg-white/10 rounded-full overflow-hidden">
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
      </div>
    </div>
  );
}

export default function FootballBets({ limit = 10, layout = "full" }) {
  const date = todayYMD();
  const { bets = [], loading, error } = useValueBets(date);

  // Pripremi dve sortirane varijante
  const base = Array.isArray(bets) ? bets.slice() : [];

  const byKickoff = useMemo(() => {
    const arr = base.slice();
    arr.sort((a, b) => kickoffMs(a) - kickoffMs(b));
    return arr;
  }, [base]);

  const byConfidence = useMemo(() => {
    const arr = base.slice();
    arr.sort((a, b) => (b.confidence_pct || 0) - (a.confidence_pct || 0) || ((Number.isFinite(b.ev)?b.ev:-Infinity) - (Number.isFinite(a.ev)?a.ev:-Infinity)));
    return arr;
  }, [base]);

  if (loading) return <div className="text-slate-400 text-sm">Loading football…</div>;
  if (error) return <div className="text-amber-400 text-sm">Football feed error: {String(error)}</div>;

  if (layout === "combined") {
    // Combined ostaje isti — Top N po confidence
    const topCombined = byConfidence.slice(0, limit);
    return (
      <div className="grid grid-cols-1 gap-4 items-stretch">
        {topCombined.map((p) => (
          <Card key={p.fixture_id || `${p.league?.id}-${p.teams?.home?.name}`} pick={p} />
        ))}
        {topCombined.length === 0 && <div className="text-slate-400 text-sm">No football suggestions.</div>}
      </div>
    );
  }

  // FULL layout: tri taba — Kick-Off / Confidence / History
  return (
    <Tabs defaultLabel="Kick-Off">
      {/* Kick-Off tab (Soonest) */}
      <div label="Kick-Off">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          {/* LEFT: Singles (Top N) */}
          <div className="md:col-span-2">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
              {byKickoff.slice(0, limit).map((p) => (
                <Card key={p.fixture_id || `${p.league?.id}-${p.teams?.home?.name}`} pick={p} />
              ))}
              {byKickoff.length === 0 && <div className="text-slate-400 text-sm">No football suggestions.</div>}
            </div>
          </div>

          {/* RIGHT: Tickets */}
          <div className="md:col-span-1">
            <TicketPanel bets={byKickoff} />
          </div>
        </div>
      </div>

      {/* Confidence tab (High → Low) */}
      <div label="Confidence">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          {/* LEFT: Singles (Top N) */}
          <div className="md:col-span-2">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
              {byConfidence.slice(0, limit).map((p) => (
                <Card key={p.fixture_id || `${p.league?.id}-${p.teams?.home?.name}`} pick={p} />
              ))}
              {byConfidence.length === 0 && <div className="text-slate-400 text-sm">No football suggestions.</div>}
            </div>
          </div>

          {/* RIGHT: Tickets */}
          <div className="md:col-span-1">
            <TicketPanel bets={byConfidence} />
          </div>
        </div>
      </div>

      {/* History tab (Top pickovi po slotu sa FT ishodom) */}
      <HistoryPanel label="History" />
    </Tabs>
  );
}
