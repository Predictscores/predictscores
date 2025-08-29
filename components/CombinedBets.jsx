// components/CombinedBets.jsx
import React, { useEffect, useState, useCallback } from "react";

export default function CombinedBets({ slot = "pm" }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // Combined = TOP 3 (bez &full=1)
      const res = await fetch(`/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, {
        cache: "no-store",
      });
      const j = await res.json();
      const arr = Array.isArray(j?.items) ? j.items.slice(0, 3) : [];
      setItems(arr);
    } catch (e) {
      console.error("CombinedBets fetch error:", e);
      setErr("Neuspešno učitavanje.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [slot]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div>Učitavam kombinovane predloge…</div>;
  }

  if (err) {
    return (
      <div>
        {err}{" "}
        <button onClick={load} type="button">
          Pokušaj ponovo
        </button>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div>
        Nema kombinovanih predloga za ovaj slot.
        <button onClick={load} type="button" style={{ marginLeft: 8 }}>
          Osveži
        </button>
      </div>
    );
  }

  return (
    <div className="combined-bets space-y-4">
      {items.map((item, idx) => (
        <div key={idx} className="card p-4 rounded-xl">
          <div className="text-sm opacity-80 mb-1">
            {item.league?.name} · {item?.datetime_local?.date_time || item?.kickoff}
          </div>
          <div className="text-xl font-semibold mb-2">
            {item.teams?.home?.name} <span className="opacity-70">vs</span>{" "}
            {item.teams?.away?.name}
          </div>
          <div className="mb-1">
            {item.market_label} → <b>{item.selection}</b>{" "}
            <span className="opacity-80">
              ({Number(item.odds).toFixed ? Number(item.odds).toFixed(2) : item.odds})
            </span>
          </div>
          <div className="text-sm opacity-80 mb-2">
            {Array.isArray(item.explain?.bullets)
              ? item.explain.bullets.join(" · ")
              : ""}
          </div>
          <div className="text-sm">
            <span className="opacity-80">Confidence</span>{" "}
            <b>{item.confidence_pct}%</b>
          </div>
        </div>
      ))}
      <div>
        <button onClick={load} type="button" className="px-3 py-2 rounded-lg">
          Osveži
        </button>
      </div>
    </div>
  );
}
