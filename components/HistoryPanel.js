import React, { useEffect, useMemo, useState } from "react";

/** Izvor istorije — po tvom, ovde već dolazi Top-3 i samo završene stavke. */
const HISTORY_URL = "/api/history?days=14";
const TZ = "Europe/Belgrade";

/* ---------------------------- helpers ---------------------------- */

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
    country && country.toLowerCase().includes(k.toLowerCase())
  );
  return key ? map[key] : "";
}

function teamName(side) {
  if (!side) return "—";
  if (typeof side === "string") return side || "—";
  if (typeof side === "object") return side.name || "—";
  return "—";
}

/* ---------------------------- subviews ---------------------------- */

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
  // History prikazuje samo završene; ako server ipak vrati bez won, ništa ne prikazujemo.
  return null;
}

function Row({ it }) {
  const ko =
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.time?.starting_at?.date_time ||
    "";

  const home = teamName(it?.teams?.home || it?.teams?.Home || it?.home);
  const away = teamName(it?.teams?.away || it?.teams?.Away || it?.away);

  const leagueName = it?.league?.name || "—";
  const country = it?.league?.country || "";
  const flag = flagEmoji(country);

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
            {leagueName} {flag ? `· ${flag}` : ""} {" · "} {fmtLocal(ko)}
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-1">
          <div className="text-sm">
            <span className="font-semibold">
              {market ? `${market} → ${selection}` : selection}
            </span>{" "}
            {odds ? (
              <span className="text-slate-300">({Number(odds).toFixed(2)})</span>
            ) : null}
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

/* ---------------------------- main ---------------------------- */

export default function HistoryPanel({ label = "History" }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    (async () => {
      const j = await safeJson(HISTORY_URL);
      if (j && j.ok === false) {
        if (!loadedOnce) setItems([]);
        setErr(j.error || "Greška pri čitanju istorije.");
        setLoadedOnce(true);
        return;
      }

      // Endpoint već vraća ono što hoćemo; zadržavamo samo završene — defanzivno.
      const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
      const finished = arr.filter(
        (it) => typeof it?.won === "boolean" && !!it?.final_score
      );

      // Sort: najnovije prvo
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

  // Grupisanje po danu (CET)
  const groups = useMemo(() => {
    const g = new Map();
    for (const it of items) {
      const key = dayKey(
        it?.kickoff || it?.datetime_local?.starting_at?.date_time || ""
      );
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(it);
    }
    return Array.from(g.entries()); // [ [day, arr], ... ]
  }, [items]);

  return (
    <div label={label}>
      {/* jednostavno zaglavlje panela */}
      <div className="mb-4 p-4 rounded-xl bg-[#1f2339] text-slate-200">
        <div className="text-sm font-semibold">History — Top 3 (završene)</div>
        <div className="text-xs text-slate-400">
          Prikazuju se samo mečevi koji su bili u Top-3 Football (Combined) i koji su završeni.
        </div>
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
                  <Row
                    key={`${it.fixture_id}-${it.locked_at || it.kickoff || it.final_score}`}
                    it={it}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
