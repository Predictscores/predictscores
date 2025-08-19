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
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-slate-500/20 text-slate-300">
      ⏳ U toku
    </span>
  );
}

function Row({ it }) {
  const market = String(it.market || "").toUpperCase();
  const sel = String(it.selection || "");
  const marketLabel =
    market === "OU" && /OVER|UNDER/.test(sel.toUpperCase())
      ? `OU: ${sel}`
      : (market === "BTTS 1H" ? "BTTS 1H" : market) + (market ? `: ${sel}` : "");

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">
            {it?.teams?.home || "—"} <span className="text-slate-400">vs</span>{" "}
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
            {" · "}Slot: {it.slot || "—"}
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-1">
          <div className="text-sm">
            <span className="font-semibold">{marketLabel}</span>{" "}
            <span className="text-slate-300">
              ({Number(it.odds || 0).toFixed(2)})
            </span>
          </div>

          <div className="text-xs text-slate-300">
            TR:{" "}
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

export default function HistoryPanel({ label = "History", days = 14, refreshMs = 60000 }) {
  const [data, setData] = useState({ items: [], aggregates: {} });
  const [err, setErr] = useState(null);

  async function load() {
    try {
      const j = await fetchJSON(`/api/history?days=${days}`);
      setData(j || { items: [], aggregates: {} });
      setErr(null);
    } catch (e) {
      setErr(String(e && e.message) || "Error");
    }
  }

  useEffect(() => {
    load();
    if (refreshMs > 0) {
      const t = setInterval(load, refreshMs);
      return () => clearInterval(t);
    }
  }, []);

  const items = Array.isArray(data.items) ? data.items : [];
  const ag7 = data?.aggregates?.["7d"];
  const ag14 = data?.aggregates?.["14d"];

  return (
    <div label={label}>
      {/* Mali agregat */}
      <div className="mb-4 p-4 rounded-xl bg-[#1f2339] text-slate-200">
        <div className="text-sm font-semibold mb-1">History — učinak</div>
        <div className="text-sm text-slate-300 flex flex-wrap gap-x-6 gap-y-1">
          <span>
            7d: <strong>{ag7?.win_rate ?? 0}%</strong>
            <span className="text-slate-400"> · ROI </span>
            <strong>
              {Number(ag7?.roi ?? 0) >= 0 ? "+" : ""}
              {Number(ag7?.roi ?? 0).toFixed(2)}
            </strong>
            <span className="text-slate-400"> (N={ag7?.n ?? 0})</span>
          </span>
          <span>
            14d: <strong>{ag14?.win_rate ?? 0}%</strong>
            <span className="text-slate-400"> · ROI </span>
            <strong>
              {Number(ag14?.roi ?? 0) >= 0 ? "+" : ""}
              {Number(ag14?.roi ?? 0).toFixed(2)}
            </strong>
            <span className="text-slate-400"> (N={ag14?.n ?? 0})</span>
          </span>
        </div>
      </div>

      {/* Lista */}
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
