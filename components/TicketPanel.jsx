// FILE: components/TicketPanel.jsx
import React, { useMemo } from "react";

/**
 * TicketPanel gradi tri tiketa (po 3 para) iz već dobijenih "bets".
 * - Grupe: BTTS, HT-FT, 1X2
 * - Pravila: min odds 1.30, rang EV -> edge_pp -> confidence -> fixture_id
 * - Max 1 par po ligi unutar jednog tiketa, kickoff gap >= 20 min
 * - Dozvoljeno da isti meč bude u različitim tiketima (nema duplikata u istom tiketu)
 */
const MIN_ODDS = 1.30;
const TICKET_EACH = 3;
const TICKET_GROUPS = ["BTTS", "HT-FT", "1X2"];
const MIN_GAP_MIN = 20;

function parseKickoffISO(it) {
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
  const iso = parseKickoffISO(it);
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

function gapOk(a, b) {
  const ta = kickoffMs(a);
  const tb = kickoffMs(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) >= MIN_GAP_MIN * 60_000;
}

function byTicketRank(a, b) {
  const evA = Number.isFinite(a.ev) ? a.ev : -Infinity;
  const evB = Number.isFinite(b.ev) ? b.ev : -Infinity;
  if (evB !== evA) return evB - evA;

  const eA = Number.isFinite(a.edge_pp) ? a.edge_pp : -Infinity;
  const eB = Number.isFinite(b.edge_pp) ? b.edge_pp : -Infinity;
  if (eB !== eA) return eB - eA;

  const cA = Number.isFinite(a.confidence_pct) ? a.confidence_pct : -Infinity;
  const cB = Number.isFinite(b.confidence_pct) ? b.confidence_pct : -Infinity;
  if (cB !== cA) return cB - cA;

  return String(a.fixture_id).localeCompare(String(b.fixture_id));
}

function pickTicket(items, group) {
  // Filtriraj po grupi i min kvoti
  const pool = items
    .filter((it) => {
      // market normalize
      const m = (it.market_label || it.market || "").toUpperCase();
      const odds = Number(it.market_odds);
      if (!Number.isFinite(odds) || odds < MIN_ODDS) return false;
      if (group === "1X2") return m.includes("1X2");
      if (group === "BTTS") return m.includes("BTTS");
      if (group === "HT-FT") return m.includes("HT") || m.includes("HT-FT");
      return false;
    })
    .sort(byTicketRank);

  const out = [];
  const leagues = new Set();

  for (const cand of pool) {
    if (out.length >= TICKET_EACH) break;
    const lg = cand?.league?.name || "";
    if (leagues.has(lg)) continue;

    // gap check vs. već odabranih
    if (out.some((x) => !gapOk(x, cand))) continue;

    out.push(cand);
    leagues.add(lg);
  }

  return out;
}

function Row({ item }) {
  const iso = parseKickoffISO(item);
  const t = iso ? new Date(iso) : null;
  const timeLocal = t
    ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";

  const odds =
    Number.isFinite(item.market_odds) && item.market_odds > 0
      ? item.market_odds.toFixed(2)
      : "—";
  const ev =
    Number.isFinite(item.ev) ? `${(item.ev * 100).toFixed(1)}%` : "—";
  const conf = Number.isFinite(item.confidence_pct)
    ? `${item.confidence_pct}%`
    : "—";

  const label = `${item.market_label || item.market || ""}: ${
    item.selection || ""
  }`;

  return (
    <div className="flex items-center justify-between py-2 border-b border-white/10 last:border-b-0">
      <div className="flex-1 pr-3">
        <div className="text-sm text-white font-semibold">
          {item.teams?.home?.name} vs {item.teams?.away?.name}
        </div>
        <div className="text-xs text-slate-400">
          {item.league?.name || ""} • {timeLocal} • {label}
        </div>
      </div>
      <div className="text-right text-xs">
        <div className="text-white">@ {odds}</div>
        <div className="text-slate-400">EV {ev} · C {conf}</div>
      </div>
    </div>
  );
}

export default function TicketPanel({ bets = [] }) {
  const { btts, htft, oneXtwo } = useMemo(() => {
    const b = pickTicket(bets, "BTTS");
    const h = pickTicket(bets, "HT-FT");
    const x = pickTicket(bets, "1X2");
    return { btts: b, htft: h, oneXtwo: x };
  }, [bets]);

  return (
    <aside className="bg-[#151830] rounded-2xl p-4 md:p-5 shadow-md sticky top-4">
      <h3 className="text-lg font-bold mb-3">Tickets (3×)</h3>

      {/* BTTS */}
      <div className="mb-4">
        <div className="text-sm text-slate-300 mb-1">BTTS (3)</div>
        <div className="bg-white/5 rounded-xl p-2">
          {btts.length ? (
            btts.map((it) => <Row key={`btts-${it.fixture_id}`} item={it} />)
          ) : (
            <div className="text-xs text-slate-400 py-2">
              Nema dovoljno kandidata.
            </div>
          )}
        </div>
      </div>

      {/* HT-FT */}
      <div className="mb-4">
        <div className="text-sm text-slate-300 mb-1">HT-FT (3)</div>
        <div className="bg-white/5 rounded-xl p-2">
          {htft.length ? (
            htft.map((it) => <Row key={`htft-${it.fixture_id}`} item={it} />)
          ) : (
            <div className="text-xs text-slate-400 py-2">
              Nema dovoljno kandidata.
            </div>
          )}
        </div>
      </div>

      {/* 1X2 */}
      <div>
        <div className="text-sm text-slate-300 mb-1">1X2 (3)</div>
        <div className="bg-white/5 rounded-xl p-2">
          {oneXtwo.length ? (
            oneXtwo.map((it) => (
              <Row key={`1x2-${it.fixture_id}`} item={it} />
            ))
          ) : (
            <div className="text-xs text-slate-400 py-2">
              Nema dovoljno kandidata.
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
