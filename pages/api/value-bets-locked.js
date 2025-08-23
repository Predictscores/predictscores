// --- DROP-IN HeaderBar (bez ikakvih cron poziva) ---
import { useEffect, useMemo, useRef, useState } from "react";

// Ako već imaš svoj hook za dark mode, ostavi ga; u suprotnom ovo je no-op:
function useDarkMode() { return { toggle: () => document.documentElement.classList.toggle("dark") }; }

// Helpers
const fmt2 = (n) => String(n).padStart(2, "0");
const todayYMD = () => {
  const d = new Date();
  return `${d.getFullYear()}-${fmt2(d.getMonth()+1)}-${fmt2(d.getDate())}`;
};
const nearestFutureKickoff = (list=[]) => {
  const now = Date.now();
  let best = null;
  for (const x of list) {
    const ko = x?.ko || x?.kickoff || x?.date || x?.time || null;
    const t = ko ? Date.parse(ko) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t > now && (!best || t < best)) best = t;
  }
  return best ? new Date(best).toISOString() : null;
};
const hhmmssLeft = (iso) => {
  if (!iso) return "—";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ss = s%60;
  return `${fmt2(h)}:${fmt2(m)}:${fmt2(ss)}`;
};

async function safeJson(url) {
  try { const r = await fetch(url, { cache: "no-store" }); return await r.json(); }
  catch { return null; }
}

export default function HeaderBar() {
  const { toggle } = useDarkMode();
  const [now, setNow] = useState(Date.now());
  const [nextKickoffAt, setNextKickoffAt] = useState(null);  // ISO
  const [cryptoNextAt, setCryptoNextAt]   = useState(null);  // timestamp (ms)
  const ticking = useRef(false);

  // 1) Ticker za tajmere
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 2) Jedno čitanje zaključenog feeda + crypto tajmera (nema rebuild-a iz UI-ja!)
  useEffect(() => {
    if (ticking.current) return;
    ticking.current = true;
    (async () => {
      const fb = await safeJson("/api/value-bets-locked");
      const list = Array.isArray(fb?.value_bets) ? fb.value_bets : [];
      setNextKickoffAt(nearestFutureKickoff(list));
      try {
        localStorage.setItem(`valueBetsLocked_${todayYMD()}`, JSON.stringify(list));
      } catch {}

      const cr = await safeJson("/api/crypto");
      if (cr) setCryptoNextAt(Date.now() + 10 * 60 * 1000); // ~10 min
    })();
  }, []);

  // 3) Ručni “Refresh all” (dozvoljen, ali retko)
  const handleRefreshAll = async () => {
    // Ako baš želiš, ručni pritisak može da pingne “light” scheduler
    // koji SAM internim pozivom zove rebuild + insights (bez front-loopa).
    await fetch("/api/cron/scheduler", { cache: "no-store" }).catch(() => {});
    const fb = await safeJson("/api/value-bets-locked");
    const list = Array.isArray(fb?.value_bets) ? fb.value_bets : [];
    setNextKickoffAt(nearestFutureKickoff(list));
    try {
      localStorage.setItem(`valueBetsLocked_${todayYMD()}`, JSON.stringify(list));
    } catch {}
  };

  const cryptoLeft = useMemo(() => {
    if (!cryptoNextAt) return "—";
    const ms = cryptoNextAt - now;
    if (ms <= 0) return "—";
    const s = Math.floor(ms/1000);
    const m = Math.floor(s/60);
    const ss = s%60;
    return `${m}:${fmt2(ss)}`;
  }, [cryptoNextAt, now]);

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
        AI Top fudbalske i Kripto Prognoze
      </h1>

      <div className="flex items-center gap-3">
        <button onClick={handleRefreshAll} className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600">
          Refresh all
        </button>
        <button onClick={() => {
          try {
            const ymd = todayYMD();
            const raw = localStorage.getItem(`valueBetsLocked_${ymd}`);
            const list = raw ? JSON.parse(raw) : [];
            const headers = ["league","match","market","pick","odds","kickoff"];
            const rows = list.map(x => [
              x.league || "", `${x.home} vs ${x.away}`, x.market || "", x.pick || "",
              x.market_odds ?? x.odds ?? "", x.ko || x.kickoff || ""
            ]);
            const csv = [headers.join(","), ...rows.map(r => r.map(s => String(s).includes(",")?`"${s}"`:s).join(","))].join("\n");
            const url = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
            const a = document.createElement("a");
            a.href = url; a.download = `predictscores_${todayYMD()}.csv`; a.click(); URL.revokeObjectURL(url);
          } catch { alert("Greška pri izvozu."); }
        }} className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600">
          Export CSV
        </button>
        <button onClick={toggle} className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600">Light mode</button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm text-slate-300">
        <span className="px-3 py-1 rounded-full bg-slate-800">
          Crypto next refresh: {cryptoLeft}
        </span>
        <span className="px-3 py-1 rounded-full bg-slate-800">
          Next kickoff: {hhmmssLeft(nextKickoffAt)}
        </span>
      </div>
    </div>
  );
}
