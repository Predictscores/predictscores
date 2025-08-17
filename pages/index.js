import { useEffect, useMemo, useState } from "react";

/**
 * Ova stranica:
 * - Učitava feed sa /api/value-bets-locked (KV snapshot)
 * - Sort: Kickoff (soonest) ili Confidence (high→low)
 * - Combined: 1 kartica po meču (najbolji pick za taj fixture)
 * - Football: opcioni filter po tržištu (All / 1X2 / BTTS / OU / HT-FT)
 * - Nema Crypto (placeholder)
 */

const MARKET_LABELS = ["1X2", "BTTS", "OU", "HT-FT"];

function parseKickoff(ms) {
  if (!ms) return 0;
  const t = new Date(String(ms).replace(" ", "T")).getTime();
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
  // globalni sekundarni kriterijumi (koristimo i za “najbolji pick po meču”)
  const safe = p?.safe ? 1 : 0;
  const conf = Number(p?.confidence_pct || Math.round((p?.model_prob || 0) * 100));
  const ev = Number.isFinite(p?.ev) ? Number(p.ev) : -Infinity;
  const ko = parseKickoff(p?.datetime_local?.starting_at?.date_time);
  return { safe, conf, ev, ko };
}

function bestByFixture(picks) {
  // Daje mapu fixture_id -> NAJBOLJI pick, prema (SAFE, confidence, EV, kickoff)
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
      // p je bolji od cur?
      if (
        A.safe !== B.safe ? A.safe > B.safe :
        A.conf !== B.conf ? A.conf > B.conf :
        A.ev !== B.ev ? A.ev > B.ev :
        A.ko < B.ko
      ) {
        best.set(id, p);
      }
    }
  }
  return Array.from(best.values());
}

export default function Home() {
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto
  const [subTab, setSubTab] = useState("All"); // All | 1X2 | BTTS | OU | HT-FT (samo za Football)
  const [sortKey, setSortKey] = useState("kickoff"); // kickoff | confidence
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // fetch locked feed
  useEffect(() => {
    let abort = new AbortController();
    setLoading(true);
    fetch("/api/value-bets-locked", { signal: abort.signal, cache: "no-store" })
      .then(r => r.json())
      .then(j => setData(j))
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => abort.abort();
  }, []);

  const raw = Array.isArray(data?.value_bets) ? data.value_bets : [];

  // priprema listi po tabu
  const list = useMemo(() => {
    if (!raw.length) return [];

    // 1) filtriranje po tabu
    let arr = raw;
    if (tab === "Football") {
      if (subTab !== "All") {
        arr = arr.filter(p => marketOf(p) === subTab);
      }
    } else if (tab === "Combined") {
      // kombinovani prikaz: 1 pick po meču (najbolji po (SAFE,conf,EV,KO))
      arr = bestByFixture(arr);
    } else {
      // Crypto (placeholder) – trenutno nema feed
      arr = [];
    }

    // 2) sortiranje (primarni je ono što klikneš)
    arr = [...arr]; // copy
    arr.sort((a, b) => {
      const A = rankKey(a);
      const B = rankKey(b);

      // SAFE uvek ispred
      if (B.safe !== A.safe) return B.safe - A.safe;

      if (sortKey === "confidence") {
        if (B.conf !== A.conf) return B.conf - A.conf;
        if (B.ev !== A.ev) return B.ev - A.ev;
        return A.ko - B.ko; // skoriji kickoff
      } else {
        // kickoff
        if (A.ko !== B.ko) return A.ko - B.ko; // skoriji kickoff
        if (B.conf !== A.conf) return B.conf - A.conf;
        return B.ev - A.ev;
      }
    });

    return arr;
  }, [raw, tab, subTab, sortKey]);

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-white">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <h1 className="text-3xl font-bold mb-4">AI Top fudbalske i Kripto Prognoze</h1>

        {/* Tabovi */}
        <div className="flex gap-3 mb-4">
          {["Combined","Football","Crypto"].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-full ${tab===t ? "bg-blue-600" : "bg-slate-700/60"}`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Sub-tab za Football */}
        {tab === "Football" && (
          <div className="flex gap-2 mb-4">
            {["All", ...MARKET_LABELS].map(s => (
              <button
                key={s}
                onClick={() => setSubTab(s)}
                className={`px-3 py-1 rounded-lg text-sm ${subTab===s ? "bg-blue-500" : "bg-slate-700/60"}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Sort dugmad */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setSortKey("kickoff")}
            className={`px-3 py-1 rounded-lg text-sm ${sortKey==="kickoff" ? "bg-emerald-600" : "bg-slate-700/60"}`}
          >
            Kickoff (Soonest)
          </button>
          <button
            onClick={() => setSortKey("confidence")}
            className={`px-3 py-1 rounded-lg text-sm ${sortKey==="confidence" ? "bg-emerald-600" : "bg-slate-700/60"}`}
          >
            Confidence (High → Low)
          </button>
        </div>

        {/* Info bar */}
        <div className="text-sm text-slate-300 mb-3">
          {loading ? "Loading…" : `Found ${list.length} picks · source: ${data?.source || "locked-cache"}`}
        </div>

        {/* Lista kartica */}
        <div className="grid gap-4">
          {list.map(p => (
            <Card key={`${p.fixture_id}-${p.market}-${p.selection}`} p={p} />
          ))}
          {!loading && list.length === 0 && (
            <div className="text-slate-400">Nema predloga.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ p }) {
  const league = `${p?.league?.country || ""} ${p?.league?.name || ""}`.trim();
  const koISO = p?.datetime_local?.starting_at?.date_time;
  const ko = koISO ? new Date(koISO) : null;
  const koTxt = ko ? ko.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}) : "—";
  const teams = `${p?.teams?.home?.name || "?"} vs ${p?.teams?.away?.name || "?"}`;
  const odds = Number.isFinite(p?.market_odds) ? `(${Number(p.market_odds).toFixed(2)})` : "";
  const conf = Number(p?.confidence_pct || Math.round((p?.model_prob||0)*100));
  const badge = p?.safe ? "High" : conf >= 75 ? "High" : conf >= 50 ? "Moderate" : "Low";

  return (
    <div className="rounded-2xl bg-[#11182a] p-4 shadow-lg">
      <div className="text-xs text-slate-300 mb-1">
        {league} • {koTxt}
        <span className={`ml-2 inline-flex items-center gap-1 text-[11px] ${badge==="High"?"text-emerald-400":badge==="Moderate"?"text-sky-300":"text-yellow-300"}`}>
          <span className={`w-2 h-2 rounded-full ${badge==="High"?"bg-emerald-400":badge==="Moderate"?"bg-sky-300":"bg-yellow-300"}`}></span>
          {badge}
        </span>
      </div>
      <div className="text-lg font-semibold">{teams}</div>
      <div className="mt-2 text-slate-200 font-medium">
        {String(p.market_label || p.market)}: {String(p.selection)} {odds}
      </div>
      <div className="mt-1 text-slate-400 text-sm">
        Zašto: {p?.explain?.summary || "—"}
      </div>
      <div className="mt-3">
        <div className="text-sm text-slate-300 mb-1">Confidence</div>
        <div className="w-full h-2 rounded bg-slate-700/60 overflow-hidden">
          <div
            className="h-2 bg-emerald-500"
            style={{ width: `${Math.max(0, Math.min(100, conf))}%` }}
          />
        </div>
        <div className="text-right text-xs text-slate-400 mt-1">{conf}%</div>
      </div>
    </div>
  );
}
