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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      // normalizovani endpoint sa garantovanim imenima i poslednjih 14 dana
      const r = await safeJson(`/api/history-check?days=14`);
      const arr =
        Array.isArray(r?.history) ? r.history :
        Array.isArray(r?.items) ? r.items :
        Array.isArray(r) ? r : [];
      if (mounted) {
        setItems(arr);
        setLoading(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, []);

  return (
    <div>
      {loading && <div className="text-sm opacity-70 mb-2">Učitavanje istorije…</div>}
      {!loading && items.length === 0 && <div className="text-sm opacity-70">Nema podataka za poslednjih 14 dana.</div>}

      <ul className="space-y-2">
        {items.map((x, i) => {
          const home = x?.teams?.home?.name || x?.home || x?.home_name || "Unknown";
          const away = x?.teams?.away?.name || x?.away || x?.away_name || "Unknown";
          const league = x?.league?.name || x?.league_name || "";
          const country = x?.league?.country || x?.country || "";
          const result = x?.result || x?.outcome || x?.status || "";
          return (
            <li key={`h-${x?.fixture_id || x?.id || i}`} className="p-3 rounded border">
              <div className="text-xs opacity-70">{country ? `${country} — ` : ""}{league}</div>
              <div className="text-base">{home} vs {away}</div>
              <div className="text-xs opacity-70">{result}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
