// FILE: components/FootballBets.jsx
import React, { useContext, useMemo } from "react";
import { DataContext } from "../contexts/DataContext";

// ---------- helpers (lokalne, da ništa ne fali) ----------
function ccToFlag(cc) {
  const code = String(cc || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65))
  );
}

// dopunjeno mapiranje (zemlje + heuristike po ligama)
const NAME_TO_CC = {
  // countries
  usa: "US",
  "united states": "US",
  america: "US",
  iceland: "IS",
  japan: "JP",
  germany: "DE",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "faroe-islands": "FO",
  denmark: "DK",
  sweden: "SE",
  norway: "NO",
  finland: "FI",
  portugal: "PT",
  spain: "ES",
  italy: "IT",
  france: "FR",
  netherlands: "NL",
  belgium: "BE",
  austria: "AT",
  switzerland: "CH",
  turkey: "TR",
  greece: "GR",
  serbia: "RS",
  croatia: "HR",
  slovenia: "SI",
  bosnia: "BA",
  montenegro: "ME",
  "north macedonia": "MK",
  albania: "AL",
  mexico: "MX",
  nicaragua: "NI",
  // leagues / heuristics
  bund: "DE",
  laliga: "ES",
  seriea: "IT",
  ligue: "FR",
  eredivisie: "NL",
  primeira: "PT",
  j1: "JP",
  urvalsdeild: "IS",
  meistaradeildin: "FO",
  usl: "US",
  mls: "US",
  "mls next pro": "US",
  championship: "GB",
};

function guessFlag(league = {}) {
  const country = String(league.country || "").toLowerCase();
  const name = String(league.name || "").toLowerCase();

  for (const key of Object.keys(NAME_TO_CC)) {
    if (country.includes(key)) return ccToFlag(NAME_TO_CC[key]);
  }
  for (const key of Object.keys(NAME_TO_CC)) {
    if (name.includes(key)) return ccToFlag(NAME_TO_CC[key]);
  }
  return "";
}

function sanitizeIso(s) {
  if (!s || typeof s !== "string") return null;
  let iso = s.trim();
  // tipičan problem iz API-ja: "...+00:00Z" (dupla zona) → skini višak
  iso = iso.replace("+00:00Z", "Z").replace("Z+00:00", "Z");
  // ako je slučajno "YYYY-MM-DD HH:mm:ss", prebaci u ISO
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:?\d{0,2}$/.test(iso)) {
    iso = iso.replace(" ", "T") + "Z";
  }
  return iso;
}

function extractKickoffISO(v) {
  const dt =
    v?.datetime_local?.starting_at?.date_time ||
    v?.datetime_local?.date_time ||
    v?.time?.starting_at?.date_time ||
    v?.kickoff ||
    null;
  return sanitizeIso(dt);
}

function toBelgradeHM(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString("sr-RS", {
      timeZone: "Europe/Belgrade",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtOdds(x) {
  return typeof x === "number" && isFinite(x) ? x.toFixed(2) : "—";
}
function fmtPct(x) {
  const n = typeof x === "number" ? x : 0;
  return `${Math.round(n)}%`;
}

function pickLabel(sel, home, away) {
  if (sel === "1") return `${home} (1)`;
  if (sel === "2") return `${away} (2)`;
  if (sel?.toUpperCase() === "X") return "Draw (X)";
  return String(sel || "—");
}

function sortValueBets(bets = []) {
  return bets
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "MODEL+ODDS" ? -1 : 1;
      }
      const eA = a.edge ?? 0;
      const eB = b.edge ?? 0;
      if (eB !== eA) return eB - eA;
      return (b.model_prob ?? 0) - (a.model_prob ?? 0);
    });
}

function bucket(conf) {
  const c = typeof conf === "number" ? conf : 0;
  if (c >= 90) return { text: "Top Pick", cls: "text-orange-400" };
  if (c >= 75) return { text: "High", cls: "text-emerald-400" };
  if (c >= 50) return { text: "Moderate", cls: "text-sky-400" };
  return { text: "Low", cls: "text-amber-400" };
}

// ---------- UI ----------
function FootballCard({ v, layout = "full" }) {
  const league = v?.league || {};
  const home = v?.teams?.home?.name || "Home";
  const away = v?.teams?.away?.name || "Away";
  const iso = extractKickoffISO(v);
  const when = iso ? toBelgradeHM(iso) : "—";
  const flag = guessFlag(league);
  const confPct =
    typeof v?.confidence_pct === "number" ? Math.max(0, Math.min(100, v.confidence_pct)) : 0;
  const b = bucket(confPct);

  const odds =
    v?.market_odds && typeof v.market_odds === "number" ? v.market_odds : null;

  return (
    <div className="w-full bg-[#1f2339] p-5 rounded-2xl shadow flex flex-col min-h-[180px]">
      {/* Header liga + vreme */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">{flag}</span>
          <div className="text-sm text-slate-300">
            <div className="font-semibold text-white">
              {league?.name || "League"}
            </div>
            <div className="text-slate-400">{when} (Beograd)</div>
          </div>
        </div>

        <div className="text-xs px-2 py-1 rounded-full border border-white/10 text-slate-300">
          {v?.type === "MODEL+ODDS" ? "MODEL+ODDS" : "FALLBACK"}
        </div>
      </div>

      {/* Timovi */}
      <div className="mt-3 text-lg font-semibold">
        {home} <span className="text-slate-400">vs</span> {away}
      </div>

      {/* Predlog / kvota / confidence */}
      <div className="mt-2 text-sm flex flex-wrap items-center gap-3">
        <div>
          Pick:{" "}
          <span className="text-white font-bold">
            {pickLabel(v?.selection, home, away)}
          </span>{" "}
          <span className="text-slate-400">[{v?.market || "—"}]</span>
        </div>
        <div className="text-slate-300">
          Odds: <span className="font-semibold">{fmtOdds(odds)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className={b.cls}>●</span>
          <span className="text-slate-200">{b.text}</span>
          <span className="text-slate-400">({fmtPct(confPct)})</span>
        </div>
      </div>

      {/* Micro red (edge / model), samo informativno */}
      <div className="mt-1 text-[11px] text-slate-400">
        {typeof v?.edge === "number"
          ? `Edge: ${(v.edge * 100).toFixed(1)}%`
          : v?.model_prob
          ? `Model: ${(v.model_prob * 100).toFixed(1)}%`
          : ""}
      </div>
    </div>
  );
}

export default function FootballBets({ limit = 10, layout = "full" }) {
  const { football = [], loadingFootball } = useContext(DataContext) || {};

  const list = useMemo(() => {
    const base = Array.isArray(football) ? football : [];
    const sorted = sortValueBets(base);
    return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
  }, [football, limit]);

  if (loadingFootball) {
    return <div className="text-slate-400 text-sm">Loading football picks…</div>;
  }

  if (!list.length) {
    return (
      <div className="text-slate-400 text-sm">
        No football suggestions at the moment.
      </div>
    );
  }

  // layout: combined → grid=1 kolona; full → lista
  if (layout === "combined") {
    return (
      <div className="grid grid-cols-1 gap-4 items-stretch">
        {list.map((v) => (
          <FootballCard key={v?.fixture_id || `${v?.league?.id}-${v?.teams?.home?.name}-${v?.teams?.away?.name}`} v={v} layout="combined" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {list.map((v) => (
        <FootballCard
          key={v?.fixture_id || `${v?.league?.id}-${v?.teams?.home?.name}-${v?.teams?.away?.name}`}
          v={v}
          layout="full"
        />
      ))}
    </div>
  );
}
