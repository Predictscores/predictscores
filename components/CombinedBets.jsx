import React, { useEffect, useMemo, useState } from "react";
import Tabs from "./Tabs";
import CryptoTopSignals from "./CryptoTopSignals";

/** Helperi */
function parseKO(p) {
  const s =
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.time?.starting_at?.date_time ||
    null;
  return s ? new Date(s.replace(" ", "T")) : null;
}
function isFuture(p, marginMin = 0) {
  const ko = parseKO(p);
  if (!ko) return false;
  const now = Date.now() + marginMin * 60 * 1000;
  return +ko > now;
}
function conf(p) {
  const x = Number(p?.confidence_pct || 0);
  return Number.isFinite(x) ? x : 0;
}
function ev(p) {
  const x = Number(p?.ev || 0);
  return Number.isFinite(x) ? x : -999;
}

/** Kartica fudbala (isti izgled kao u Football tabu) */
function FootballCard({ p }) {
  const league = `${p?.league?.name || ""}`;
  const country = p?.league?.country || "";
  const koISO =
    p?.datetime_local?.starting_at?.date_time?.replace(" ", "T") || null;

  // "Zašto": koristimo bullets ako postoje; fallback na summary.
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const summary = p?.explain?.summary || "";

  return (
    <div className="rounded-2xl bg-[#14182a] p-4 md:p-5 text-slate-200 shadow">
      <div className="text-xs uppercase tracking-wide text-slate-400 flex items-center gap-2">
        <span>🏆 {league}</span>
        {country ? <span>• {country}</span> : null}
        {koISO ? (
          <>
            <span>•</span>
            <span>{new Date(koISO).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}</span>
          </>
        ) : null}
      </div>

      <h3 className="mt-1 text-xl font-semibold">
        {p?.teams?.home?.name} <span className="text-slate-400">vs</span> {p?.teams?.away?.name}
      </h3>

      <div className="mt-2 text-slate-300 font-semibold">
        {p?.market_label || p?.market}: {p?.selection}{" "}
        <span className="text-slate-400">({Number(p?.market_odds || p?.odds).toFixed(2)})</span>
      </div>

      {/* Confidence bar (vizuelno isto kao pre) */}
      <div className="mt-2">
        <div className="text-xs text-slate-400">Confidence</div>
        <div className="h-2 bg-[#0f1424] rounded-full overflow-hidden">
          <div
            style={{ width: `${Math.max(0, Math.min(100, conf(p)))}%` }}
            className="h-2 bg-sky-400"
          />
        </div>
      </div>

      {/* Zašto */}
      <div className="mt-3 text-sm">
        <div className="text-slate-400">Zašto:</div>
        {bullets.length ? (
          <ul className="mt-1 list-disc list-inside space-y-1">
            {bullets.map((b, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: b }} />
            ))}
          </ul>
        ) : (
          <div className="mt-1 text-slate-300">{summary}</div>
        )}
      </div>
    </div>
  );
}

/** Top 3 fudbal (samo za Combined) */
function FootballTop3() {
  const [list, setList] = useState([]);
  const [tick, setTick] = useState(0);

  // Povlačenje sa “cache buster”-om + 60s polling (lagano)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/value-bets-locked?_=${Date.now()}`, { cache: "no-store" });
        const js = await r.json();
        const arr = Array.isArray(js?.value_bets) ? js.value_bets : [];
        if (!alive) return;

        // odbaci parove koji su već prošli (5 min margina)
        const future = arr.filter((p) => isFuture(p, 5));

        // sortiraj po confidence desc, pa EV desc, pa najskori kickoff
        future.sort((a, b) => ev(b) - ev(a) || conf(b) - conf(a));
        future.sort((a, b) => conf(b) - conf(a) || ev(b) - ev(a));

        setList(future.slice(0, 3));
      } catch {
        // ignoriši
      }
    };

    load();
    const t = setInterval(() => {
      setTick((x) => x + 1);
      load();
    }, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!list.length) {
    return <div className="text-slate-400 text-sm">Nema kandidata za prikaz.</div>;
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {list.map((p) => (
        <FootballCard key={`${p.fixture_id}-${p.market}-${p.selection}`} p={p} />
      ))}
    </div>
  );
}

export default function CombinedBets() {
  return (
    <Tabs>
      <div label="Combined">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
          <div className="md:col-span-1">
            <FootballTop3 />
          </div>
          <div className="md:col-span-2">
            <CryptoTopSignals limit={3} />
          </div>
        </div>
      </div>

      <div label="Football">
        {/* Sav detaljni prikaz sa Kick-Off / Confidence / History je u FootballBets komponenti */}
        <FootballFull />
      </div>

      <div label="Crypto">
        <CryptoTopSignals limit={10} />
      </div>
    </Tabs>
  );
}

/** Lazy import da zadržimo SSR ponašanje isto kao ranije */
function FootballFull() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./FootballBets").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) return <div className="mt-6 text-slate-400 text-sm">Loading…</div>;
  return <Comp limit={25} layout="full" />;
}
