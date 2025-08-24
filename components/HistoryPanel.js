import React, { useEffect, useMemo, useState } from "react";

/** 🔧 PODESI OVO: stavi tačan URL tvog endpointa koji već vraća SAMO završene Top-3 za 14 dana. */
const HISTORY_URL = "/api/api14days"; 
// Primer alternative ako ti je to zapravo ovo:
// const HISTORY_URL = "/api/history?days=14";

/* ───────────────── helpers ───────────────── */

const TZ = "Europe/Belgrade";

function fmtLocal(isoLike) {
  try {
    const d = new Date(isoLike);
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return isoLike || "";
  }
}

function dayKey(isoLike) {
  try {
    const d = new Date(isoLike);
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return "—";
  }
}

function flagEmoji(country = "") {
  const map = {
    Albania: "🇦🇱", Algeria: "🇩🇿", Argentina: "🇦🇷", Australia: "🇦🇺",
    Austria: "🇦🇹", Belgium: "🇧🇪", Bosnia: "🇧🇦", Brazil: "🇧🇷",
    Bulgaria: "🇧🇬", Chile: "🇨🇱", China: "🇨🇳", Colombia: "🇨🇴",
    Croatia: "🇭🇷", Cyprus: "🇨🇾", Czech: "🇨🇿", Denmark: "🇩🇰",
    Ecuador: "🇪🇨", England: "🏴", Estonia: "🇪🇪", Finland: "🇫🇮",
    France: "🇫🇷", Georgia: "🇬🇪", Germany: "🇩🇪", Greece: "🇬🇷",
    Hungary: "🇭🇺", Iceland: "🇮🇸", India: "🇮🇳", Iran: "🇮🇷",
    Ireland: "🇮🇪", Israel: "🇮🇱", Italy: "🇮🇹", Japan: "🇯🇵",
    Korea: "🇰🇷", Lithuania: "🇱🇹", Malaysia: "🇲🇾", Mexico: "🇲🇽",
    Morocco: "🇲🇦", Netherlands: "🇳🇱", Norway: "🇳🇴", Poland: "🇵🇱",
    Portugal: "🇵🇹", Romania: "🇷🇴", Russia: "🇷🇺", Saudi: "🇸🇦",
    Scotland: "🏴", Serbia: "🇷🇸", Slovakia: "🇸🇰", Slovenia: "🇸🇮",
    Spain: "🇪🇸", Sweden: "🇸🇪", Switzerland: "🇨🇭", Turkey: "🇹🇷",
    USA: "🇺🇸", Ukraine: "🇺🇦", Uruguay: "🇺🇾", Wales: "🏴",
  };
  const key = Object.keys(map).find((k) =>
    country.toLowerCase().includes(k.toLowerCase())
  );
  return key ? map[key] : "🏳️";
}

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { return { ok:false, error:"non-JSON", raw: txt }; }
  } catch (e) {
    return { ok:false, error: String(e?.message || e) };
  }
}

/* ───────────────── UI dijelovi ───────────────── */

function Outcome({ won }) {
  if (won === true) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300">
        ✅ Pogodak
      </span>
    );
  }
  if (won === false) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300">
        ❌ Promašaj
      </span>
    );
  }
  // Po tvom zahtevu: u History nema "U toku" — ako endpoint slučajno vrati nešto nesettlovano, jednostavno ne prikazujemo badge.
  return null;
}

function Row({ it }) {
  const leagueName = it?.league?.name || "—";
  const country = it?.league?.country || "";
  const flag = flagEmoji(country);

  const ko =
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.time?.starting_at?.date_time ||
    "";

  const home = it?.teams?.home?.name || it?.teams?.home || "—";
  const away = it?.teams?.away?.name || it?.teams?.away || "—";

  const market = it?.market_label || it?.market || "";
  const selection = it?.selection || "";
  const odds = Number.isFinite(it?.odds || it?.market_odds)
    ? (it?.odds || it?.market_odds)
    : null;

  const score = it?.final_score || "";
  const ht = it?.ht_score || "";
  const won = it?.won;

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">
            {home} <span className="text-slate-400">vs</span> {away}
          </div>
          <div className="text-xs text-slate-400">
            {leagueName} {country ? `· ${flag}` : ""} {" · "}
            {fmtLocal(ko)}
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-1">
          <div className="text-sm">
            <span className="font-semibold">
              {market ? `${market} → ${selection}` : selection}
            </span>{" "}
            {odds ? <span className="text-slate-300">({Number(odds).toFixed(2)})</span> : null}
          </div>

          {score ? (
            <div className="text-xs text-slate-300">
              TR: <span className="font-mono">{score}</span>
              {ht ? <span className="text-slate-400"> (HT {ht})</span> : null}
            </div>
          ) : null}

          <Outcome won={won} />
        </div>
      </div>
    </div>
  );
}

/* ───────────────── Glavni panel ───────────────── */

export default function HistoryPanel({ label = "History" }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    (async () => {
      const j = await safeJson(HISTORY_URL);
      if (j && j.ok === false) {
        // ako endpoint vrati grešku, NE briši prethodni dobar state
        if (!loadedOnce) setItems([]);
        setErr(j.error || "Greška pri čitanju istorije.");
        setLoadedOnce(true);
        return;
      }
      const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
      // Ako backend već vraća SAMO završene Top-3, ništa dodatno ne filtriramo.
      // Za svaki slučaj (defenzivno): zadrži samo one sa konačnim ishodom.
      const finished = arr.filter((it) => typeof it?.won === "boolean" && !!it?.final_score);

      // Sortiraj po kickoff opadajuće (najnovije prvo)
      finished.sort((a, b) => {
        const ta = new Date(a?.kickoff || a?.datetime_local?.starting_at?.date_time || 0).getTime();
        const tb = new Date(b?.kickoff || b?.datetime_local?.starting_at?.date_time || 0).getTime();
        return tb - ta;
      });

      setItems(finished);
      setErr(null);
      setLoadedOnce(true);
    })();
  }, []);

  // Grupisanje po danu
  const groups = useMemo(() => {
    const g = new Map();
    for (const it of items) {
      const key =
        dayKey(it?.kickoff || it?.datetime_local?.starting_at?.date_time || "");
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(it);
    }
    return Array.from(g.entries()); // [ [day, arr], ... ]
  }, [items]);

  return (
    <div label={label}>
      {/* zaglavlje panela (bez ROI/7d/14d jer tražiš čist top3 history) */}
      <div className="mb-4 p-4 rounded-xl bg-[#1f2339] text-slate-200">
        <div className="text-sm font-semibold">History — Top 3 (završene)</div>
        <div className="text-xs text-slate-400">Prikazuju se samo mečevi koji su bili u Top-3 Football (Combined) i koji su završeni.</div>
      </div>

      {err ? (
        <div className="p-4 rounded-xl bg-[#1f2339] text-rose-300 text-sm">
          Greška: {err}
        </div>
      ) : groups.length === 0 ? (
        <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">
          Nema završених Top-3 mečeva za prikaz.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(([day, arr]) => (
            <div key={day}>
              <div className="text-slate-300 text-sm mb-2">{day}</div>
              <div className="grid grid-cols-1 gap-3">
                {arr.map((it) => (
                  <Row key={`${it.fixture_id}-${it.locked_at || it.kickoff}`} it={it} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
