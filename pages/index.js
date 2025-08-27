// pages/index.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";

const CombinedBets = dynamic(() => import("../components/CombinedBets"), {
  ssr: false,
  loading: () => <div className="mt-6 text-slate-400 text-sm">Loading…</div>,
});

// ---------- utils (lokalno; bez mreže)
const TZ = "Europe/Belgrade";

function toYMD(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function parseStartISO(item) {
  try {
    const dt =
      item?.datetime_local?.starting_at?.date_time ||
      item?.datetime_local?.date_time ||
      item?.time?.starting_at?.date_time ||
      item?.kickoff ||
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
async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const txt = await r.text();
    try {
      return JSON.parse(txt);
    } catch {
      return { ok: false, error: "non-JSON", raw: txt };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------- Header bar (bez cron poziva; samo čita API-je)
function HeaderBar() {
  const [now, setNow] = useState(Date.now());
  const [kickoffAt, setKickoffAt] = useState(null);
  const [cryptoNextAt, setCryptoNextAt] = useState(null);
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      if (loadedOnceRef.current) return;
      loadedOnceRef.current = true;

      // Pročitaj zaključani feed (slot) – ovo je uvek preferirano
      const fb = await safeJson("/api/value-bets-locked");
      const list = Array.isArray(fb?.items || fb?.value_bets)
        ? (fb.items || fb.value_bets)
        : [];

      try {
        localStorage.setItem(`valueBetsLocked_${toYMD()}`, JSON.stringify(list));
      } catch {}

      setKickoffAt(nearestFutureKickoff(list));

      // Crypto heartbeat (frontend tajmer; pravi refreshovi su na backendu)
      const cr = await safeJson("/api/crypto");
      if (cr && cr.ok !== false) {
        // vizuelni tajmer na 10 min
        setCryptoNextAt(Date.now() + 10 * 60 * 1000);
      }
    })();
  }, []);

  const cryptoTL = useMemo(() => {
    if (!cryptoNextAt) return "—";
    const ms = Math.max(0, cryptoNextAt - now);
    return ms === 0 ? "—" : fmtCountdown(ms);
  }, [cryptoNextAt, now]);

  const kickoffTL = useMemo(() => {
    if (!kickoffAt) return "—";
    const ms = Math.max(0, new Date(kickoffAt).getTime() - now);
    return ms === 0 ? "—" : fmtCountdown(ms);
  }, [kickoffAt, now]);

  const hardRefresh = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  const exportCSV = () => {
    try {
      const key = `valueBetsLocked_${toYMD()}`;
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr) || arr.length === 0) {
        alert("Nema podataka za izvoz.");
        return;
      }
      const rows = arr.map((p) => {
        const iso = parseStartISO(p);
        const dt = iso
          ? new Date(iso).toLocaleString("sv-SE", {
              timeZone: TZ,
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
          home: p?.teams?.home?.name || p?.home || p?.home_name || "",
          away: p?.teams?.away?.name || p?.away || p?.away_name || "",
          market: p?.market_label || p?.market || "",
          selection: p?.selection || "",
          odds:
            Number.isFinite(p?.closing_odds_decimal) ? p.closing_odds_decimal :
            Number.isFinite(p?.market_odds_decimal) ? p.market_odds_decimal :
            Number.isFinite(p?.market_odds) ? p.market_odds : "",
          confidence_pct: Number.isFinite(p?.confidence_pct) ? p.confidence_pct : "",
          edge_pp: Number.isFinite(p?.edge_pp) ? p.edge_pp : "",
          ev: Number.isFinite(p?.ev) ? p.ev : Number.isFinite(p?.ev_pct) ? p.ev_pct : "",
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
      a.download = `predictscores_${toYMD()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("CSV export error:", e);
      alert("Greška pri izvozu.");
    }
  };

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
            onClick={exportCSV}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            Export CSV
          </button>
          <button
            onClick={() => {
              const html = document.documentElement;
              const next = !html.classList.contains("dark");
              html.classList.toggle("dark", next);
            }}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            Light mode
          </button>
        </div>

        <div className="px-4 py-2 rounded-full bg-[#202542] text-white text-sm inline-flex items-center gap-6">
          <span>Crypto next refresh: {cryptoTL}</span>
          <span>Next kickoff: {kickoffTL}</span>
        </div>
      </div>
    </div>
  );
}

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
    </div>
  );
}

export default function IndexPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      <Head>
        <title>Predictscores — Live Picks</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Spriječi keširanje da UI uvek vidi fresh locked slot/history */}
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
