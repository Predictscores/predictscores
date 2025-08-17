// FILE: components/TicketPanel.jsx
import React, { useMemo } from "react";

// Maks kvote po kategoriji (zadržavamo iste default-e kao do sada)
const MAX_BTTS = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_BTTS || 4.0);
const MAX_OU   = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_OU   || 4.0);
const MAX_1X2  = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_1X2  || 6.0);
const MAX_HTFT = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_HTFT || 9.0);

// UBLAŽENI default pragovi (bez ENV-a)
const MIN_CONF = 45;        // ranije 55
const MIN_BKS_OU_BTTS = 3;  // ranije 5
const MIN_BKS_1X2_HTFT = 2; // ranije 3

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
  const x = Number(n || 0);
  return (cat === "BTTS" || cat === "OU") ? x >= MIN_BKS_OU_BTTS : x >= MIN_BKS_1X2_HTFT;
}
function timeOf(p) {
  try {
    const iso = String(p?.datetime_local?.starting_at?.date_time || "").replace(" ", "T");
    return new Date(iso);
  } catch { return null; }
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
                <span className="font-semibold">{p?.teams?.home?.name}</span> vs{" "}
                <span className="font-semibold">{p?.teams?.away?.name}</span>
              </div>
              <div className="text-slate-400 text-xs">
                {(p?.league?.name || "—")} •{" "}
                {(() => {
                  const d = timeOf(p);
                  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                })()}
              </div>
              <div className="text-slate-300 mt-1">
                <span className="font-semibold">{p.market_label || p.market}</span>: {p.selection}
                {Number.isFinite(p.market_odds) ? ` (${p.market_odds})` : ""}
              </div>
              <div className="text-slate-400 text-xs">
                Zašto: Model {Math.round((p.model_prob || 0) * 100)}% vs {Math.round((p.implied_prob || 0) * 100)}% ·{" "}
                EV {Number.isFinite(p.ev) ? `${Math.round(p.ev * 1000) / 10}%` : "—"} · Bookies {p.bookmakers_count ?? "—"}
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
  const { btts, ou, htft, oneXtwo } = useMemo(() => {
    // filtriraj i rasporedi po kategorijama
    const accepted = (p) => {
      const cat = catOf(p);
      if (cat === "OTHER") return false;
      const conf = Number(p?.confidence_pct || Math.round((p?.model_prob || 0) * 100));
      const odds = Number(p?.market_odds);
      const bks = Number(p?.bookmakers_count || 0);
      return (
        conf >= MIN_CONF &&
        withinOdds(cat, odds) &&
        meetsBookies(cat, bks)
      );
    };

    const sorted = bets
      .filter(accepted)
      .sort((a, b) => {
        const ca = Number(a.confidence_pct || Math.round((a.model_prob || 0) * 100));
        const cb = Number(b.confidence_pct || Math.round((b.model_prob || 0) * 100));
        if (cb !== ca) return cb - ca;
        const eva = Number.isFinite(a.ev) ? a.ev : -Infinity;
        const evb = Number.isFinite(b.ev) ? b.ev : -Infinity;
        if (evb !== eva) return evb - eva;
        const ta = timeOf(a)?.getTime() || 0;
        const tb = timeOf(b)?.getTime() || 0;
        return ta - tb;
      });

    const pickTop3 = (arr) => arr.slice(0, 3);

    const btts = pickTop3(sorted.filter((p) => catOf(p) === "BTTS"));
    const ou   = pickTop3(sorted.filter((p) => catOf(p) === "OU"));
    const htft = pickTop3(sorted.filter((p) => catOf(p) === "HT-FT"));
    const oneXtwo = pickTop3(sorted.filter((p) => catOf(p) === "1X2"));

    return { btts, ou, htft, oneXtwo };
  }, [bets]);

  return (
    <div className="rounded-2xl bg-[#15182a] p-4">
      <div className="text-base font-semibold text-white mb-3">Top lige</div>
      <Section title="BTTS"  items={btts} />
      <Section title="OU 2.5" items={ou} />
      <Section title="HT-FT" items={htft} />
      <Section title="1X2"   items={oneXtwo} />
    </div>
  );
}
