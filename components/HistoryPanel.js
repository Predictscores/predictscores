import React, { useEffect, useState } from "react";

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok:false, error:"non-JSON", raw:t }; }
  } catch (e) {
    return { ok:false, error: String(e?.message || e) };
  }
}

export default function HistoryPanel() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let abort = false;
    (async () => {
      setLoading(true);
      const j = await safeJson("/api/history?days=14");
      if (!abort) {
        const arr = Array.isArray(j?.items) ? j.items : [];
        setItems(arr);
        setLoading(false);
      }
    })();
    return () => { abort = true; };
  }, []);

  return (
    <div>
      {loading && <div className="text-sm opacity-70 mb-2">Učitavanje istorije…</div>}
      {!loading && items.length === 0 && (
        <div className="text-sm opacity-70">Nema podataka za poslednjih 14 dana.</div>
      )}

      <ul className="space-y-2">
        {items.map((x, i) => {
          // Robustno čitanje imena (podržava i starije zapise gde su bili stringovi)
          const home =
            (typeof x?.teams?.home === "string" ? x.teams.home : x?.teams?.home?.name) ||
            x?.home || x?.home_name || "Unknown";
          const away =
            (typeof x?.teams?.away === "string" ? x.teams.away : x?.teams?.away?.name) ||
            x?.away || x?.away_name || "Unknown";

          const league = x?.league?.name || x?.league_name || "";
          const country = x?.league?.country || x?.country || "";
          const result = x?.result || x?.outcome || x?.status || "";
          const kickoff = x?.kickoff || x?.datetime_local?.starting_at?.date_time || "";

          return (
            <li key={`h-${x?.fixture_id || x?.id || i}`} className="p-3 rounded border">
              <div className="text-xs opacity-70">
                {country ? `${country} — ` : ""}{league}
              </div>
              <div className="font-medium">
                {home} — {away}
              </div>
              <div className="text-xs opacity-70">
                {kickoff?.replace("T"," ")} {result ? `• ${result}` : ""}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
