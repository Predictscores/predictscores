// components/HistoryPanel.js
"use client";

import { useEffect, useState } from "react";

export default function HistoryPanel({ days = 14 }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      let done = false;
      try {
        setLoading(true);
        setErr(null);

        // Uvek gađaj isti origin (izbegava NEXT_PUBLIC_BASE_URL mismatch)
        const href = `/api/history?days=${encodeURIComponent(days)}`;
        const r = await fetch(href, { cache: "no-store", signal: ac.signal });

        // Ako CDN/edge promeni header, i dalje pokušaj JSON
        let body;
        try {
          const ct = (r.headers.get("content-type") || "").toLowerCase();
          body = ct.includes("application/json") ? await r.json() : await r.text().then((t) => {
            try { return JSON.parse(t); } catch { return { ok:false, error:"non-JSON", raw:t }; }
          });
        } catch (e) {
          // fallback: tekst → JSON
          const t = await r.text().catch(() => "");
          try { body = JSON.parse(t); } catch { body = { ok:false, error: "parse-failed", raw:t }; }
        }

        const arr =
          Array.isArray(body?.items) ? body.items :
          Array.isArray(body?.history) ? body.history :
          Array.isArray(body) ? body : [];

        setItems(arr);
        done = true;
      } catch (e) {
        if (e && (e.name === "AbortError" || e.code === 20)) return;
        setErr(String(e?.message || e));
      } finally {
        if (!done) {
          // Ako je fetch pukao/presretnut, ipak spusti loading
          setItems((prev) => Array.isArray(prev) ? prev : []);
        }
        setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [days]);

  if (loading) return <div className="text-slate-400 text-sm">History: učitavam…</div>;
  if (err)      return <div className="text-red-400 text-sm">History greška: {err}</div>;
  if (!items.length) return <div className="text-slate-400 text-sm">Nema istorije u poslednjih {days} dana.</div>;

  return (
    <div className="space-y-2">
      {items.map((x, i) => {
        const league = x?.league_name || x?.league || "";
        const home = x?.home?.name || x?.home || "—";
        const away = x?.away?.name || x?.away || "—";
        const market = x?.market || x?.market_label || "";
        const pick = x?.selection_label || x?.pick || x?.selection || "";
        const price = Number(x?.odds?.price ?? x?.price);
        const result = (x?.result || x?.outcome || x?.settle || "").toString().toUpperCase();

        return (
          <div key={x?.id || x?.fixture_id || `${i}-${home}-${away}-${market}-${pick}`} className="p-3 rounded-xl bg-[#1f2339] text-sm">
            <div className="text-slate-400">{league}</div>
            <div className="font-semibold">
              {home} <span className="text-slate-400">vs</span> {away}
            </div>
            <div className="text-slate-300">
              {market}{market ? " → " : ""}{pick}
              {Number.isFinite(price) ? ` (${price.toFixed(2)})` : ""}
              {result ? ` · ${result}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
