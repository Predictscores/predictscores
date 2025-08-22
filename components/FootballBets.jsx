import React, { useEffect, useMemo, useState } from "react";
import Tabs from "./Tabs";

/** Helperi */
function koISO(p) {
  return (
    p?.datetime_local?.starting_at?.date_time?.replace(" ", "T") ||
    p?.datetime_local?.date_time?.replace(" ", "T") ||
    null
  );
}
function koDate(p) {
  const s = koISO(p);
  return s ? new Date(s) : null;
}
function conf(p) {
  const x = Number(p?.confidence_pct || 0);
  return Number.isFinite(x) ? x : 0;
}
function ev(p) {
  const x = Number(p?.ev || 0);
  return Number.isFinite(x) ? x : -999;
}
function isFuture(p, marginMin = 0) {
  const d = koDate(p);
  if (!d) return false;
  return +d > Date.now() + marginMin * 60 * 1000;
}
function Why({ p }) {
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const summary = p?.explain?.summary || "";
  if (bullets.length) {
    return (
      <ul className="mt-1 list-disc list-inside space-y-1">
        {bullets.map((b, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: b }} />
        ))}
      </ul>
    );
  }
  return <div className="mt-1 text-slate-300">{summary}</div>;
}

/** Kartica meča */
function Card({ p }) {
  const league = `${p?.league?.name || ""}`;
  const country = p?.league?.country || "";
  const time = koISO(p)
    ? new Date(koISO(p)).toLocaleTimeString("sv-SE", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  const odds = Number(p?.market_odds || p?.odds || 0);
  const confPct = Math.max(0, Math.min(100, conf(p)));

  return (
    <div className="rounded-2xl bg-[#14182a] p-4 md:p-5 text-slate-200 shadow">
      <div className="text-xs uppercase tracking-wide text-slate-400 flex items-center gap-2">
        <span>🏆 {league}</span>
        {country ? <span>• {country}</span> : null}
        {time ? (
          <>
            <span>•</span>
            <span>{time}</span>
          </>
        ) : null}
      </div>

      <h3 className="mt-1 text-xl font-semibold">
        {p?.teams?.home?.name} <span className="text-slate-400">vs</span> {p?.teams?.away?.name}
      </h3>

      <div className="mt-2 text-slate-300 font-semibold">
        {p?.market_label || p?.market}: {p?.selection}{" "}
        {Number.isFinite(odds) && <span className="text-slate-400">({odds.toFixed(2)})</span>}
      </div>

      {/* Confidence bar (ispod kao ranije) */}
      <div className="mt-2">
        <div className="text-xs text-slate-400">Confidence</div>
        <div className="h-2 bg-[#0f1424] rounded-full overflow-hidden">
          <div
            style={{ width: `${confPct}%` }}
            className="h-2 bg-sky-400"
          />
        </div>
      </div>

      {/* Zašto */}
      <div className="mt-3 text-sm">
        <div className="text-slate-400">Zašto:</div>
        <Why p={p} />
      </div>
    </div>
  );
}

/** History lista */
function HistoryList() {
  const [items, setItems] = useState([]);
  const [agg, setAgg] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/history?days=14&_=${Date.now()}`, { cache: "no-store" });
        const js = await r.json();
        if (!alive) return;
        setItems(Array.isArray(js?.items) ? js.items : []);
        setAgg(js?.aggregates || null);
      } catch {}
    };
    load();
    const t = setInterval(load, 60 * 60 * 1000); // 60 min, dovoljno retko
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="space-y-3">
      {agg ? (
        <div className="rounded-xl bg-[#101427] p-3 text-sm text-slate-300 flex gap-6">
          <span>History — učinak</span>
          <span>7d: {agg["7d"].win_rate}% · ROI {agg["7d"].roi.toFixed(2)} (N={agg["7d"].n})</span>
          <span>14d: {agg["14d"].win_rate}% · ROI {agg["14d"].roi.toFixed(2)} (N={agg["14d"].n})</span>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="text-slate-400 text-sm">Još nema zaključanih parova u istoriji.</div>
      ) : (
        items.map((h) => {
          const ko = h?.kickoff ? new Date(h.kickoff) : null;
          const when = ko
            ? `${ko.toLocaleDateString("sv-SE")} • ${ko.toLocaleTimeString("sv-SE", {
                hour: "2-digit",
                minute: "2-digit",
              })}`
            : "";
          const badge =
            h.won === true ? (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-emerald-600/20 text-emerald-300">
                ✓ tačno
              </span>
            ) : h.won === false ? (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-rose-600/20 text-rose-300">
                ✗ promašaj
              </span>
            ) : (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-slate-600/20 text-slate-300">
                ⏳ u toku
              </span>
            );

          return (
            <div
              key={`${h.fixture_id}-${h.market}-${h.selection}`}
              className="rounded-xl bg-[#14182a] p-4 text-slate-200"
            >
              <div className="text-xs uppercase tracking-wide text-slate-400 flex items-center gap-2">
                <span>🏆 {h?.league?.name}</span>
                {h?.league?.country ? <span>• {h.league.country}</span> : null}
                {when ? (
                  <>
                    <span>•</span>
                    <span>{when}</span>
                  </>
                ) : null}
                <span>• Slot: {h?.slot || "-"}</span>
              </div>

              <div className="mt-1 font-semibold">
                {h?.teams?.home} <span className="text-slate-400">vs</span> {h?.teams?.away}
              </div>

              <div className="mt-1 text-slate-300 flex items-center gap-2">
                {h?.market}: {h?.selection}{" "}
                {Number.isFinite(h?.odds) && <span className="text-slate-400">({h.odds.toFixed(2)})</span>}
                {badge}
              </div>

              <div className="mt-1 text-sm text-slate-400">
                TR: {h?.final_score ? h.final_score : "—"}
                {h?.ht_score ? ` · HT: ${h.ht_score}` : ""}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export default function FootballBets({ limit = 25 }) {
  const [raw, setRaw] = useState([]);

  // učitaj zaključane predloge; bust cache i filtriraj prošle
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/value-bets-locked?_=${Date.now()}`, { cache: "no-store" });
        const js = await r.json();
        if (!alive) return;
        const arr = Array.isArray(js?.value_bets) ? js.value_bets : [];
        setRaw(arr.filter((p) => isFuture(p, -120))); // prikaži i do 120 min unazad u Football tabu (da ljudi vide šta je bilo), ali Combined filtrira strože
      } catch {}
    };
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // pogledi
  const byKickoff = useMemo(() => {
    const a = [...raw];
    a.sort((x, y) => +koDate(x) - +koDate(y));
    return a.slice(0, limit);
  }, [raw, limit]);

  const byConfidence = useMemo(() => {
    const a = [...raw];
    a.sort((x, y) => conf(y) - conf(x) || ev(y) - ev(x) || +koDate(x) - +koDate(y));
    return a.slice(0, limit);
  }, [raw, limit]);

  return (
    <Tabs defaultLabel="Kick-Off">
      <div label="Kick-Off">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {byKickoff.map((p) => (
            <Card key={`${p.fixture_id}-${p.market}-${p.selection}`} p={p} />
          ))}
        </div>
      </div>

      <div label="Confidence">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {byConfidence.map((p) => (
            <Card key={`${p.fixture_id}-${p.market}-${p.selection}`} p={p} />
          ))}
        </div>
      </div>

      <div label="History">
        <HistoryList />
      </div>
    </Tabs>
  );
}
