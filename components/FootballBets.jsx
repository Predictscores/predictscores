import React, { useEffect, useMemo, useState } from "react";
import Tabs from "./Tabs";

/* ================= helpers ================= */
function koISO(p) {
  // pokušaj više polja (razne verzije backenda)
  const cands = [
    p?.kickoff,
    p?.ko,
    p?.datetime_local?.starting_at?.date_time,
    p?.datetime_local?.date_time,
    p?.datetime?.starting_at?.date_time,
    p?.datetime?.date_time,
  ].filter(Boolean);

  for (const s of cands) {
    const iso = String(s).includes("T") ? String(s) : String(s).replace(" ", "T");
    const d = new Date(iso);
    if (!Number.isNaN(+d)) return iso;
  }
  return null;
}
function koDate(p) { const s = koISO(p); return s ? new Date(s) : null; }
function conf(p) { const x = Number(p?.confidence_pct || 0); return Number.isFinite(x) ? x : 0; }
function ev(p) { const x = Number(p?.ev || 0); return Number.isFinite(x) ? x : -999; }
function todayYMD() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * Ne budemo previše strogi:
 * - "combined": zadrži sve od -10min do +48h (da ne ostane prazno)
 * - "full":     zadrži od -240min do +48h (da vidiš skorije završene)
 */
function filterByTime(items, mode) {
  const now = Date.now();
  const minPast = mode === "combined" ? -10 : -240; // minute
  const maxFuture = 48 * 60;                        // minute
  return items.filter((p) => {
    const d = koDate(p);
    if (!d) return false;
    const diffMin = Math.round((+d - now) / 60000);
    return diffMin >= minPast && diffMin <= maxFuture;
  });
}

/* Zašto: preferiramo bullets (forma + H2H); fallback: summary */
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
  return summary ? <div className="mt-1 text-slate-300">{summary}</div> : null;
}

/* Kartica meča — “Confidence” traka ispod */
function Card({ p }) {
  const league = p?.league?.name || "";
  const country = p?.league?.country || "";
  const tISO = koISO(p);
  const time = tISO
    ? new Date(tISO).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })
    : "";
  const odds = Number(p?.market_odds || p?.odds || 0);
  const confPct = Math.max(0, Math.min(100, conf(p)));

  return (
    <div className="rounded-2xl bg-[#14182a] p-4 md:p-5 text-slate-200 shadow">
      <div className="text-xs uppercase tracking-wide text-slate-400 flex items-center gap-2">
        <span>🏆 {league}</span>
        {country ? <span>• {country}</span> : null}
        {time ? (<><span>•</span><span>{time}</span></>) : null}
      </div>

      <h3 className="mt-1 text-xl font-semibold">
        {p?.teams?.home?.name || p?.teams?.home} <span className="text-slate-400">vs</span> {p?.teams?.away?.name || p?.teams?.away}
      </h3>

      <div className="mt-2 text-slate-300 font-semibold">
        {p?.market_label || p?.market}: {p?.selection}{" "}
        {Number.isFinite(odds) && <span className="text-slate-400">({odds.toFixed(2)})</span>}
      </div>

      {/* Confidence ispod */}
      <div className="mt-2">
        <div className="text-xs text-slate-400">Confidence</div>
        <div className="h-2 bg-[#0f1424] rounded-full overflow-hidden">
          <div style={{ width: `${confPct}%` }} className="h-2 bg-sky-400" />
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

/* History — /api/history, polling 60 min */
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
    const t = setInterval(load, 60 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
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
            ? `${ko.toLocaleDateString("sv-SE")} • ${ko.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
            : "";
          const badge =
            h.won === true ? (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-emerald-600/20 text-emerald-300">✓ tačno</span>
            ) : h.won === false ? (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-rose-600/20 text-rose-300">✗ promašaj</span>
            ) : (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-slate-600/20 text-slate-300">⏳ u toku</span>
            );

          return (
            <div key={`${h.fixture_id}-${h.market}-${h.selection}`} className="rounded-xl bg-[#14182a] p-4 text-slate-200">
              <div className="text-xs uppercase tracking-wide text-slate-400 flex items-center gap-2">
                <span>🏆 {h?.league?.name}</span>
                {h?.league?.country ? <span>• {h.league.country}</span> : null}
                {when ? (<><span>•</span><span>{when}</span></>) : null}
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
                TR: {h?.final_score ? h.final_score : "—"}{h?.ht_score ? ` · HT: ${h.ht_score}` : ""}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/* ================= glavna ================= */
export default function FootballBets({ limit = 25, layout = "full" }) {
  const [raw, setRaw] = useState([]);
  const [loadedOnce, setLoadedOnce] = useState(false);

  // 1) pokušaj da povučeš iz LS (HeaderBar već snima dnevni snapshot)
  useEffect(() => {
    try {
      const key = `valueBetsLocked_${todayYMD()}`;
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr) && arr.length) {
        setRaw(arr);
        setLoadedOnce(true);
      }
    } catch {}
  }, []);

  // 2) redovan fetch sa cache-busterom; ne briši listu ako API vrati prazno
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/value-bets-locked?_=${Date.now()}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-store" },
        });
        const js = await r.json();
        if (!alive) return;
        const arr = Array.isArray(js?.value_bets) ? js.value_bets : [];
        if (arr.length) {
          setRaw(arr);
          // osveži i LS da Combined/Export imaju iz čega
          try {
            const key = `valueBetsLocked_${todayYMD()}`;
            localStorage.setItem(key, JSON.stringify(arr));
          } catch {}
        } else if (!loadedOnce) {
          // prvi put prazno → ne diraj state (zadrži fallback/LS)
        }
        setLoadedOnce(true);
      } catch {
        // ne diraj state
      }
    };
    load();
    const t = setInterval(load, 60000); // 60s
    return () => { alive = false; clearInterval(t); };
  }, [loadedOnce]);

  // 3) filter + sortiranja
  const filtered = useMemo(() => filterByTime(raw, layout), [raw, layout]);

  // ako posle filtera nema ničeg, prikaži zadnjih 6 nefiltriranih da UI ne bude prazan
  const safeList = filtered.length ? filtered : raw.slice(-6);

  const byKickoff = useMemo(() => {
    const a = [...safeList];
    a.sort((x, y) => +koDate(x) - +koDate(y));
    return a.slice(0, limit);
  }, [safeList, limit]);

  const byConfidence = useMemo(() => {
    const a = [...safeList];
    a.sort((x, y) => conf(y) - conf(x) || ev(y) - ev(x) || +koDate(x) - +koDate(y));
    return a.slice(0, limit);
  }, [safeList, limit]);

  if (layout === "combined") {
    return (
      <div className="grid grid-cols-1 gap-4">
        {byConfidence.slice(0, 3).map((p) => (
          <Card key={`${p.fixture_id}-${p.market}-${p.selection}`} p={p} />
        ))}
      </div>
    );
  }

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
