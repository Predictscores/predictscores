// FILE: components/TicketPanel.jsx
import React, { useMemo } from "react";

const MAX_BTTS = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_BTTS || 4.0);
const MAX_OU   = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_OU   || 4.0);
const MAX_1X2  = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_1X2  || 6.0);
const MAX_HTFT = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_HTFT || 9.0);

const MIN_CONF = Number(process.env.NEXT_PUBLIC_TKT_MIN_CONF || 55);
const MIN_BKS_OU_BTTS = Number(process.env.NEXT_PUBLIC_TKT_MIN_BOOKIES_BOTH || 5);
const MIN_BKS_1X2_HTFT = Number(process.env.NEXT_PUBLIC_TKT_MIN_BOOKIES_1X2 || 3);

function catOf(p) {
  const m = String(p.market_label || p.market || "").toLowerCase();
  if (m.includes("btts")) return "BTTS";
  if (m.includes("over") || m.includes("under") || m.includes("ou")) return "OU";
  if (m.includes("ht-ft") || m.includes("ht/ft")) return "HT-FT";
  if (m.includes("1x2") || m === "1x2" || m.includes("match winner")) return "1X2";
  return "OTHER";
}
function withinOdds(cat, odds) {
  if (!Number.isFinite(odds) || odds <= 0) return false;
  if (cat === "BTTS") return odds <= MAX_BTTS;
  if (cat === "OU") return odds <= MAX_OU;
  if (cat === "1X2") return odds <= MAX_1X2;
  if (cat === "HT-FT") return odds <= MAX_HTFT;
  return false;
}
function meetsBookies(cat, n) {
  const x = Number(n||0);
  return (cat==="BTTS"||cat==="OU") ? x >= MIN_BKS_OU_BTTS : x >= MIN_BKS_1X2_HTFT;
}

function Section({ title, items }) {
  return (
    <div className="mb-4">
      <div className="text-sm font-semibold text-white mb-2">{title} (3)</div>
      {items.length ? (
        <div className="space-y-2 text-sm">
          {items.map((p, i) => (
            <div key={i} className="p-3 rounded-xl bg-[#1f2339]">
              <div className="text-slate-200">
                <span className="font-semibold">{p.teams?.home?.name}</span> vs{" "}
                <span className="font-semibold">{p.teams?.away?.name}</span>
              </div>
              <div className="text-slate-400 text-xs">
                {(p.league?.name || "—")} • {new Date((p.datetime_local?.starting_at?.date_time||"").replace(" ","T")).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}
              </div>
              <div className="text-slate-300 mt-1">
                <span className="font-semibold">{p.market_label || p.market}</span>: {p.selection}
                {Number.isFinite(p.market_odds) ? <span className="text-slate-400"> ({Number(p.market_odds).toFixed(2)})</span> : null}
              </div>
              <div className="text-[12px] text-slate-400 mt-1">
                EV {Number.isFinite(p.edge_pp) ? `${Math.round(p.edge_pp*10)/10}%` : (Number.isFinite(p.ev)?`${Math.round(p.ev*1000)/10}%`:"—")} · C {Number.isFinite(p.confidence_pct) ? Math.round(p.confidence_pct) : "—"}%
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-slate-400 text-sm">Nema dovoljno kandidata.</div>
      )}
    </div>
  );
}

export default function TicketPanel({ bets = [] }) {
  const groups = useMemo(() => {
    const cats = { BTTS: [], OU: [], "1X2": [], "HT-FT": [] };
    for (const p of bets) {
      const cat = catOf(p);
      if (!cats[cat]) continue;

      const conf = Number(p.confidence_pct || 0);
      const odds = Number(p.market_odds);
      const bks  = Number(p.bookmakers_count || 0);

      if (conf < MIN_CONF) continue;
      if (!withinOdds(cat, odds)) continue;
      if (!meetsBookies(cat, bks)) continue;

      cats[cat].push(p);
    }
    // sort: Confidence → EV
    for (const k of Object.keys(cats)) {
      cats[k].sort((a,b) => {
        const ca = Number(a.confidence_pct||0), cb = Number(b.confidence_pct||0);
        if (cb!==ca) return cb - ca;
        const eva = Number.isFinite(a.ev) ? a.ev : (Number.isFinite(a.edge_pp)? a.edge_pp/100 : -Infinity);
        const evb = Number.isFinite(b.ev) ? b.ev : (Number.isFinite(b.edge_pp)? b.edge_pp/100 : -Infinity);
        return evb - eva;
      });
      cats[k] = cats[k].slice(0,3);
    }
    return cats;
  }, [bets]);

  return (
    <div>
      <Section title="BTTS" items={groups.BTTS} />
      <Section title="OU 2.5" items={groups.OU} />
      <Section title="HT-FT" items={groups["HT-FT"]} />
      <Section title="1X2" items={groups["1X2"]} />
    </div>
  );
}
