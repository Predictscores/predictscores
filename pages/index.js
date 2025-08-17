import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";

// CombinedBets samo na klijentu (bez SSR) + jednostavan loader
const CombinedBets = dynamic(() => import("../components/CombinedBets"), {
  ssr: false,
  loading: () => (
    <div className="mt-6 text-slate-400 text-sm">Loading suggestions…</div>
  ),
});

// --------- Dark mode toggle (lokalno)
function useDarkMode() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const saved =
      typeof window !== "undefined" ? localStorage.getItem("theme") : null;
    const isDark = saved ? saved === "dark" : true;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);
  const toggle = () => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      if (typeof window !== "undefined") {
        localStorage.setItem("theme", next ? "dark" : "light");
      }
      return next;
    });
  };
  return { toggle };
}

// --------- helperi
async function safeJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
function parseStartISO(item) {
  try {
    const dt =
      item?.datetime_local?.starting_at?.date_time ||
      item?.datetime_local?.date_time ||
      item?.time?.starting_at?.date_time ||
      null;
    if (!dt) return null;
    return dt.replace(" ", "T");
  } catch {
    return null;
  }
}
function nearestFutureKickoff(items = []) {
  const now = Date.now();
  let best = null;
  for (const it of items) {
    const iso = parseStartISO(it);
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isFinite(t) && t > now) {
      if (!best || t < best) best = t;
    }
  }
  return best ? new Date(best).toISOString() : null;
}
function fmtCountdown(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
function todayYMD() {
  const now = new Date();
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// --------- Export CSV (bez mreže, iz keša)
function exportFootballCSV() {
  try {
    const key = `valueBetsLocked_${todayYMD()}`;
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr) || arr.length === 0) {
      alert("Nema podataka za izvoz (prazno ili nije učitano).");
      return;
    }
    const tz = "Europe/Belgrade";
    const rows = arr.map((p) => {
      const iso =
        p?.datetime_local?.starting_at?.date_time?.replace(" ", "T") || null;
      const dt = iso
        ? new Date(iso).toLocaleString("sv-SE", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      return {
        datetime: dt,
        league: p?.league?.name || "",
        home: p?.teams?.home?.name || "",
        away: p?.teams?.away?.name || "",
        market: p?.market_label || p?.market || "",
        selection: p?.selection || "",
        odds: Number.isFinite(p?.market_odds) ? p.market_odds : "",
        confidence_pct: Number.isFinite(p?.confidence_pct) ? p.confidence_pct : "",
        edge_pp: Number.isFinite(p?.edge_pp) ? p.edge_pp : "",
        ev: Number.isFinite(p?.ev) ? p.ev : "",
      };
    });

    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(","),
      ...rows.map((r) =>
        headers
          .map((h) => {
            const v = r[h];
            if (v === null || v === undefined) return "";
            const s = String(v).replace(/"/g, '""');
            return /[",\n]/.test(s) ? `"${s}"` : s;
          })
          .join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `predictscores_${todayYMD()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("CSV export error:", e);
    alert("Greška pri izvozu.");
  }
}

// --------- Header (bez DataContext-a)
function HeaderBar() {
  const { toggle } = useDarkMode();

  const [now, setNow] = useState(Date.now());
  const [nextKickoffAt, setNextKickoffAt] = useState(null); // ISO string
  const [cryptoNextAt, setCryptoNextAt] = useState(null); // timestamp (ms)

  // tikanje tajmera
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // inicijalno pokupi podatke za tajmere (NE koristi DataContext)
  useEffect(() => {
    (async () => {
      try {
        const [fb, cr] = await Promise.allSettled([
          safeJson("/api/value-bets-locked"),
          safeJson("/api/crypto"),
        ]);
        if (fb.status === "fulfilled") {
          const list = Array.isArray(fb.value?.value_bets)
            ? fb.value.value_bets
            : [];
          setNextKickoffAt(nearestFutureKickoff(list));
          // keširaj u LS da Export ima iz čega da izveze
          try {
            const ymd = todayYMD();
            localStorage.setItem(`valueBetsLocked_${ymd}`, JSON.stringify(list));
          } catch {}
        }
        if (cr.status === "fulfilled") {
          // sledeći refresh ~10 min posle uspešnog poziva
          setCryptoNextAt(Date.now() + 10 * 60 * 1000);
        }
      } catch {
        // ne ruši UI
      }
    })();
  }, []);

  // countdown-ovi
  const cryptoTL = useMemo(() => {
    if (!cryptoNextAt) return null;
    const ms = Math.max(0, cryptoNextAt - now);
    return ms === 0 ? "—" : fmtCountdown(ms);
  }, [cryptoNextAt, now]);

  const kickoffTL = useMemo(() => {
    if (!nextKickoffAt) return null;
    const ms = Math.max(0, new Date(nextKickoffAt).getTime() - now);
    return ms === 0 ? "—" : fmtCountdown(ms);
  }, [nextKickoffAt, now]);

  // ručni refresh: reload (da povuče sve iz nove sesije/keša)
  const hardRefresh = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  const doExport = () => exportFootballCSV();

  return (
    <div className="flex items-start justify-between gap-4">
      <h1 className="text-3xl md:text-4xl font-extrabold text-white">
        AI Top fudbalske i Kripto Prognoze
      </h1>

      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-3">
          <button
            onClick={hardRefresh}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            Refresh all
          </button>
          <button
            onClick={doExport}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
            title="Izvezi današnje fudbalske predloge u CSV"
          >
            Export CSV
          </button>
          <button
            onClick={toggle}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            Light mode
          </button>
        </div>

        <div className="px-4 py-2 rounded-full bg-[#202542] text-white text-sm inline-flex items-center gap-6">
          <span>Crypto next refresh: {cryptoTL || "—"}</span>
          <span>Next kickoff: {kickoffTL || "—"}</span>
        </div>
      </div>
    </div>
  );
}

// --------- Legenda
function Legend() {
  return (
    <div className="mt-10 text-sm text-slate-300 flex flex-wrap items-center gap-4">
      <span>Confidence legend:</span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-full bg-emerald-400" /> High (≥75%)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-full bg-sky-400" /> Moderate (50–75%)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-full bg-amber-400" /> Low (&lt;50%)
      </span>
      <span className="inline-flex items-center gap-1">
        <span>🔥</span> Top Pick (≥90%)
      </span>
    </div>
  );
}

export default function Index() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      <Head>
        <title>Predictscores — Live Picks</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* spreči keširanje HTML-a da ne vidiš stari UI */}
        <meta httpEquiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
        <meta httpEquiv="Pragma" content="no-cache" />
        <meta httpEquiv="Expires" content="0" />
      </Head>

      <main className="min-h-screen bg-[#0f1116] text-white">
        <div className="max-w-7xl mx-auto p-4 md:p-6">
          <HeaderBar />

          <div className="mt-6">
            {mounted ? (
              <CombinedBets />
            ) : (
              <div className="text-slate-400 text-sm">Loading…</div>
            )}
          </div>

          <Legend />
        </div>
      </main>
    </>
  );
}
