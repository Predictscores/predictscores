// FILE: components/FootballBets.jsx
import React, { useEffect, useState } from "react";
import TicketPanel from "./TicketPanel";

// Mala unutrašnja komponenta za istoriju (poslednjih 30 dana)
function HistoryCard() {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.history)) {
          setRows(data.history);
        }
      })
      .catch(() => {});
  }, []);

  if (!rows.length) return null;

  return (
    <div className="mt-6 p-4 bg-[#1f2339] rounded-2xl">
      <div className="text-sm font-semibold text-white mb-2">
        History (30 dana)
      </div>
      <div className="space-y-1 text-xs text-slate-300">
        {rows.map((m, i) => (
          <div key={i} className="flex justify-between">
            <span className="truncate">
              {m.home} vs {m.away} — {m.market} {m.selection} (
              {m.odds?.toFixed ? m.odds.toFixed(2) : m.odds})
            </span>
            <span
              className={
                m.status === "won" ? "text-emerald-400" : "text-rose-400"
              }
            >
              {m.status === "won" ? "✅" : "❌"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FootballBets({ bets }) {
  const [filtered, setFiltered] = useState([]);

  useEffect(() => {
    // Filtriranje ili druga logika
    if (Array.isArray(bets)) {
      setFiltered(bets);
    }
  }, [bets]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
      <div className="md:col-span-2">
        {/* controls + singles list */}
        {/* ... tvoj postojeći levi stub */}
      </div>

      <div className="md:col-span-1">
        <TicketPanel bets={filtered} />
        <HistoryCard /> {/* NOVO */}
      </div>
    </div>
  );
}
