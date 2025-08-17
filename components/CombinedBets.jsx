// components/CombinedBets.jsx
import React, { useEffect, useMemo, useState } from "react";

// === Helpers ===
function parseStartISO(item) {
  try {
    const dt =
      item?.datetime_local?.starting_at?.date_time ||
      item?.datetime_local?.date_time ||
      item?.time?.starting_at?.date_time ||
      null;
    return dt ? dt.replace(" ", "T") : null;
  } catch {
    return null;
  }
}
function kickoffTs(item) {
  const iso = parseStartISO(item);
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}
function marketOf(p) {
  const m = String(p?.market_label || p?.market || "").toUpperCase();
  if (m.includes("1X2")) return "1X2";
  if (m.includes("BTTS")) return "BTTS";
  if (m.includes("HT") && m.includes("FT")) return "HT-FT";
  if (m.includes("OVER") || m.includes("UNDER") || m.includes("OU")) return "OU";
  return "OTHER";
}
function rankKey(p) {
  const safe = p?.safe ? 1 : 0;
  const conf = Number(
    p?.confidence_pct || Math.round((p?.model_prob || 0) * 100)
  );
  const ev = Number.isFinite(p?.ev) ? Number(p.ev) : -Infinity;
  const ko = kickoffTs(p);
  return { safe, conf, ev, ko };
}
function pickBestPerFixture(picks) {
  // Za Combined: tačno 1 kartica po fixture_id (najbolji po SAFE → conf → EV → kickoff)
  const best = new Map();
  for (const p of picks) {
    const id = p?.fixture_id;
    if (!id) continue;
    const cur = best.get(id);
    if (!cur) {
      best.set(id, p);
    } else {
      const A = rankKey(p);
      const B = rankKey(cur);
      const better =
        A.safe !== B.safe ? A.safe > B.safe :
        A.conf !== B.conf ? A.conf > B.conf :
        A.ev !== B.ev ? A.ev > B.ev :
        A.ko < B.ko;
      if (better) best.set(id, p);
    }
  }
  return Array.from(best.values());
}

// === UI helpers (male karte identične stilu) ===
function ConfidenceBar({ pct = 0 }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="mt-2">
      <div className="text-sm text-slate-300 mb-1">Confidence</div>
      <div className="w-full h-2 rounded bg-slate-700/60 overflow-hidden">
        <div className="h-2 bg-emerald-500" style={{ width: `${v}%` }} />
      </div>
      <div className="text-right text-xs text-slate-400 mt-1">{v}%</div>
    </div>
  );
}

function Card({ p }) {
  const league = `${p?.league?.name || ""}`;
  const country = `${p?.league?.country || ""}`;
  const koISO = parseStartISO(p);
  const koTxt = koISO
    ? new Date(koISO).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const teams = `${p?.teams?.home?.name || "?"} vs ${p?.teams?.away?.name || "?"}`;
  const odds =
    Number.isFinite(p?.market_odds) ? ` (${Number(p.market_odds).toFixed(2)})` : "";
  const conf = Number(p?.confidence_pct || Math.round((p?.model_prob || 0) * 100));
  const badge =
    p?.safe ? "High" : conf >= 75 ? "High" : conf >= 50 ? "Moderate" : "Low";

  return (
    <div className="rounded-2xl bg-[#11182a] p-4 shadow-lg">
      <div className="text-xs text-slate-300 mb-1">
        {country} {league} • {koTxt}
        <span
          className={`ml-2 inline-flex items-center gap-1 text-[11px] ${
            badge === "High"
              ? "text-emerald-400"
              : badge === "Moderate"
              ? "text-sky-300"
              : "text-yellow-300"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              badge === "High"
                ? "bg-emerald-400"
                : badge === "Moderate"
                ? "bg-sky-300"
                : "bg-yellow-300"
            }`}
          />
          {badge}
        </span>
      </div>

      <div className="text-lg font-semibold">{teams}</div>
      <div className="mt-2 text-slate-200 font-medium">
        {(p?.market_label || p?.market) ?? ""}: {String(p?.selection ?? "")}
        {odds}
      </div>
      <div className="mt-1 text-slate-400 text-sm">
        Zašto: {p?.explain?.summary || "—"}
      </div>

      <ConfidenceBar pct={conf} />
    </div>
  );
}

// === Glavna komponenta (tabovi + sort) ===
export default function CombinedBets() {
  const [tab, setTab] = useState("Combined"); // "Combined" | "Football" | "Crypto"
  const [sortKey, setSortKey] = useState("kickoff"); // "kickoff" | "confidence"
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Uzimamo LOCKED feed (ne generator)
  useEffect(() => {
    let abort = new AbortController();
    setLoading(true);
    fetch("/api/value-bets-locked", { signal: abort.signal, cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setData(j))
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => abort.abort();
  }, []);

  const raw = Array.isArray(data?.value_bets) ? data.value_bets : [];

  const shown = useMemo(() => {
    let arr = raw;

    // Combined = 1 kartica po meču (nema duplikata istog fixture-a)
    if (tab === "Combined") {
      arr = pickBestPerFixture(arr);
    } else if (tab === "Football") {
      // ostavi sve markete (kao do sada)
      arr = raw;
    } else {
      // Crypto tab trenutno nema feed
      arr = [];
    }

    // sortiranje (primarni ključ je ono što klikneš)
    const sorted = [...arr].sort((a, b) => {
      const A = rankKey(a);
      const B = rankKey(b);

      // SAFE uvek ispred
      if (B.safe !== A.safe) return B.safe - A.safe;

      if (sortKey === "confidence") {
        if (B.conf !== A.conf) return B.conf - A.conf;
        if (B.ev !== A.ev) return B.ev - A.ev;
        return A.ko - B.ko; // skoriji kickoff poslednji kriterijum
      } else {
        // kickoff
        if (A.ko !== B.ko) return A.ko - B.ko;
        if (B.conf !== A.conf) return B.conf - A.conf;
        return B.ev - A.ev;
      }
    });

    return sorted;
  }, [raw, tab, sortKey]);

  return (
    <div>
      {/* Tabovi (isti raspored/stil) */}
      <div className="flex items-center gap-3">
        {["Combined", "Football", "Crypto"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full ${
              tab === t ? "bg-blue-600 text-white" : "bg-[#202542] text-white/90"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Sort by… (isti raspored/stil) */}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-slate-300 text-sm mr-2">Sort by:</span>
        <button
          onClick={() => setSortKey("kickoff")}
          className={`px-3 py-1 rounded-xl text-sm ${
            sortKey === "kickoff" ? "bg-emerald-600" : "bg-[#202542]"
          }`}
        >
          Kickoff (Soonest)
        </button>
        <button
          onClick={() => setSortKey("confidence")}
          className={`px-3 py-1 rounded-xl text-sm ${
            sortKey === "confidence" ? "bg-emerald-600" : "bg-[#202542]"
          }`}
        >
          Confidence (High → Low)
        </button>
      </div>

      <div className="text-sm text-slate-400 mt-3">
        {loading ? "Loading…" : `Found ${shown.length} picks · source: ${data?.source || "locked-cache"}`}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-1">
        {shown.map((p) => (
          <Card
            key={`${p.fixture_id}-${marketOf(p)}-${p.selection ?? ""}`}
            p={p}
          />
        ))}
        {!loading && shown.length === 0 && (
          <div className="text-slate-400">No football suggestions.</div>
        )}
      </div>
    </div>
  );
}
