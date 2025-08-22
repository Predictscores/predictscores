// components/FootballBets.js
// Prikaz LOCKED liste iz /api/value-bets-locked,
// sa "Zašto" summary + bullets (Forma, H2H) — bez promene vizuelnog stila.

import React, { useEffect, useMemo, useState } from "react";

function parseKO(p){
  const iso = p?.datetime_local?.starting_at?.date_time
           || p?.datetime_local?.date_time
           || p?.time?.starting_at?.date_time
           || null;
  if (!iso) return null;
  try { return new Date(String(iso).replace(" ", "T")); } catch { return null; }
}

function fmtKO(p, tz="Europe/Belgrade"){
  const d = parseKO(p);
  if (!d) return "";
  return d.toLocaleString("sv-SE", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function fetchLocked(){
  const r = await fetch("/api/value-bets-locked", { cache: "no-store" });
  if (!r.ok) throw new Error("locked fetch failed");
  return r.json();
}

export default function FootballBets({ limit = 25, layout = "full" }){
  const [items, setItems] = useState([]);
  const [builtAt, setBuiltAt] = useState(null);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try{
        const data = await fetchLocked();
        const arr = Array.isArray(data?.value_bets) ? data.value_bets : [];
        if (!alive) return;
        setItems(arr);
        setBuiltAt(data?.built_at || null);
      } catch {}
    };

    load();

    // lagani auto-refresh (svakih 60s) — ne troši Football API (samo naš endpoint)
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Top N po confidence→EV→KO (za Combined), inače samo isečemo limit redom
  const sorted = useMemo(() => {
    const arr = [...items];
    if (layout === "combined"){
      arr.sort((a,b)=>{
        const ca = Number(a?.confidence_pct||0), cb = Number(b?.confidence_pct||0);
        if (cb!==ca) return cb-ca;
        const ea = Number(a?.ev||0), eb = Number(b?.ev||0);
        if (eb!==ea) return eb-ea;
        const ta = parseKO(a)?.getTime() ?? 9e15;
        const tb = parseKO(b)?.getTime() ?? 9e15;
        return ta - tb;
      });
    }
    return limit > 0 ? arr.slice(0, limit) : arr;
  }, [items, limit, layout]);

  return (
    <div className="grid grid-cols-1 gap-4">
      {sorted.map((p) => {
        const league = `${p?.league?.name || ""}`;
        const country = p?.league?.country ? ` • ${p.league.country}` : "";
        const ko = fmtKO(p);
        const home = p?.teams?.home?.name || "";
        const away = p?.teams?.away?.name || "";
        const market = p?.market_label || p?.market || "";
        const sel = p?.selection || "";
        const odds = Number.isFinite(p?.market_odds) ? p.market_odds : null;
        const conf = Number(p?.confidence_pct || 0);
        const badge =
          conf >= 90 ? "bg-emerald-500" :
          conf >= 75 ? "bg-emerald-400" :
          conf >= 50 ? "bg-sky-400" :
          "bg-amber-400";

        const summary = p?.explain?.summary || "";
        const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];

        return (
          <div key={`${p.fixture_id}-${market}-${sel}`} className="rounded-2xl p-4 bg-[#151830]">
            <div className="text-slate-300 text-sm mb-1">
              <span className="font-semibold">🏆 {league}</span>
              <span className="opacity-80">{country}</span>
              {ko ? <span className="ml-2">• {ko}</span> : null}
            </div>

            <div className="text-lg font-semibold">
              {home} <span className="opacity-70">vs</span> {away}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="px-3 py-1 rounded-full bg-[#1f2339] text-slate-200 text-sm">
                {market}: <span className="font-bold">{sel}</span>{odds ? ` (${odds})` : ""}
              </div>
              <div className={`px-3 py-1 rounded-full text-white text-sm ${badge}`}>
                {conf >= 90 ? "🔥 Top Pick" :
                 conf >= 75 ? "🟢 High" :
                 conf >= 50 ? "🔵 Moderate" : "🟠 Low"}{" "}
                <span className="opacity-90 ml-1">({conf}%)</span>
              </div>
            </div>

            {/* Zašto: summary + bullets (Forma, H2H…) */}
            {(summary || bullets.length) && (
              <div className="mt-3 text-slate-300 text-sm">
                <div><span className="font-semibold">Zašto:</span> {summary}</div>
                {bullets.length > 0 && (
                  <ul className="mt-1 list-disc list-inside space-y-0.5">
                    {bullets.map((b, i) => (
                      <li key={i} className="opacity-90">{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* sitna napomena o snapshotu */}
      {builtAt && (
        <div className="text-xs text-slate-500 mt-1">
          Snapshot: {new Date(builtAt).toLocaleString("sv-SE", { hour12: false })}
        </div>
      )}
    </div>
  );
}
