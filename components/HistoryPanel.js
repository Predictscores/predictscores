import React, { useEffect, useState } from "react";

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

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
  return null; // u History nema "u toku"
}

function Row({ it }) {
  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">
            {it?.teams?.home || "—"}{" "}
            <span className="text-slate-400">vs</span>{" "}
            {it?.teams?.away || "—"}
          </div>
          <div className="text-xs text-slate-400">
            {(it?.league?.name || "—")}
            {" · "}
            {new Date(it.kickoff).toLocaleString("sv-SE", {
              timeZone: "Europe/Belgrade",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-1">
          <div className="text-sm">
            <span className="font-semibold">
              {it.market || ""} {it.selection || ""}
            </span>{" "}
            <span className="text-slate-300">
              ({Number(it.odds || 0).toFixed(2)})
            </span>
          </div>

          <div className="text-xs text-slate-300">
            Rezultat:{" "}
            {it.final_score ? (
              <span className="font-mono">{it.final_score}</span>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </div>

          <Outcome won={it.won} />
        </div>
      </div>
    </div>
  );
}

export default function HistoryPanel({ label = "History", days = 14 }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);

  async function load() {
    try {
      const j = await fetchJSON(`/api/history?days=${days}`);
      const arr = Array.isArray(j?.items) ? j.items : [];

      // filtriraj SAMO završene i SAMO top3 (proveri marker: top3/tracked/rank<=3)
      const filtered = arr.filter(
        (it) =>
          (it.won === true || it.won === false) &&
          (it.top3 === true ||
            it.tracked === true ||
            (typeof it.rank === "number" && it.rank <= 3))
      );

      setItems(filtered);
      setErr(null);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  useEffect(() => {
    load();
  }, [days]);

  return (
    <div label={label}>
      {err ? (
        <div className="p-4 rounded-xl bg-[#1f2339] text-rose-300 text-sm">
          Greška: {err}
        </div>
      ) : items.length === 0 ? (
        <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">
          Još uvek nema istorije za prikaz.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {items.map((it) => (
            <Row key={`${it.fixture_id}-${it.locked_at}`} it={it} />
          ))}
        </div>
      )}
    </div>
  );
  }
