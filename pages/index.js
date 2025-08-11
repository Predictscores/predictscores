// FILE: pages/index.js
import React, { useContext, useEffect, useMemo, useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import { DataContext } from "../contexts/DataContext";

// CombinedBets samo na klijentu (bez SSR) + jednostavan loader
const CombinedBets = dynamic(() => import("../components/CombinedBets"), {
  ssr: false,
  loading: () => (
    <div className="mt-6 text-slate-400 text-sm">Loading suggestions…</div>
  ),
});

// --------- Klijentski Error Boundary (da UI ne ostane na "Loading")
class ClientErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(error) {
    return { err: error };
  }
  componentDidCatch(error, info) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("ClientErrorBoundary:", error, info);
    }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="mt-6 p-4 rounded-xl bg-[#1a1f36] text-rose-300">
          <div className="font-semibold mb-1">Component error</div>
          <div className="text-sm opacity-80">
            Something went wrong while rendering the cards.
          </div>
          <button
            onClick={() => (typeof window !== "undefined" ? window.location.reload() : null)}
            className="mt-3 px-3 py-2 rounded-lg bg-[#202542] text-white text-sm"
            type="button"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  return { toggle, dark };
}

// --------- helperi
function sanitizeIso(s) {
  if (!s) return null;
  let iso = String(s).replace(" ", "T");
  iso = iso.replace("+00:00Z", "Z").replace("Z+00:00", "Z");
  return iso;
}
function parseStartISO(item) {
  try {
    const raw =
      item?.datetime_local?.starting_at?.date_time ||
      item?.datetime_local?.date_time ||
      item?.time?.starting_at?.date_time ||
      item?.kickoff ||
      null;
    if (!raw) return null;
    return sanitizeIso(raw);
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
function toBelgradeHM(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString("sr-RS", {
      timeZone: "Europe/Belgrade",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}
function fmtCountdown(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// --------- Header (sada koristi DataContext umesto zasebnog fetcha)
function HeaderBar() {
  const { toggle, dark } = useDarkMode();
  const {
    football = [],
    nextCryptoUpdate,
    footballLastGeneratedAt,
  } = useContext(DataContext) || {};

  const [now, setNow] = useState(Date.now());
  const [nextKickoffAt, setNextKickoffAt] = useState(null); // ISO
  const [cryptoNextAt, setCryptoNextAt] = useState(null);   // ms

  // tikanje tajmera
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // preračunaj next kickoff kad stigne/izmeni se football lista
  useEffect(() => {
    if (!Array.isArray(football) || football.length === 0) return;
    setNextKickoffAt(nearestFutureKickoff(football));
  }, [football]);

  // preuzmi sledeći crypto refresh iz konteksta
  useEffect(() => {
    if (typeof nextCryptoUpdate === "number") {
      setCryptoNextAt(nextCryptoUpdate);
    }
  }, [nextCryptoUpdate]);

  // countdown-ovi
  const cryptoTL = useMemo(() => {
    if (!cryptoNextAt) return null;
    const ms = Math.max(0, cryptoNextAt - now);
    return fmtCountdown(ms);
  }, [cryptoNextAt, now]);

  const kickoffTL = useMemo(() => {
    if (!nextKickoffAt) return null;
    const ms = Math.max(0, new Date(nextKickoffAt).getTime() - now);
    return fmtCountdown(ms);
  }, [nextKickoffAt, now]);

  const footballGenText = useMemo(() => {
    const iso = sanitizeIso(footballLastGeneratedAt);
    return iso ? toBelgradeHM(iso) : null;
  }, [footballLastGeneratedAt]);

  // ručni refresh: očisti lake lokalne keševe pa reload
  const hardRefresh = () => {
    if (typeof window !== "undefined") {
      try {
        Object.keys(localStorage || {}).forEach((k) => {
          if (k && k.startsWith("valueBets_")) localStorage.removeItem(k);
        });
      } catch {}
      window.location.reload();
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
            onClick={toggle}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            {dark ? "Light mode" : "Dark mode"}
          </button>
        </div>

        <div className="px-4 py-2 rounded-full bg-[#202542] text-white text-sm inline-flex items-center gap-6">
          <span>Crypto next refresh: {cryptoTL || "—"}</span>
          <span>Next kickoff: {kickoffTL || "—"}</span>
          <span>Football last generated: {footballGenText || "—"}</span>
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
      </Head>

      <main className="min-h-screen bg-[#0f1116] text-white">
        <div className="max-w-7xl mx-auto p-4 md:p-6">
          <HeaderBar />

          <div className="mt-6">
            {mounted ? (
              <ClientErrorBoundary>
                <CombinedBets />
              </ClientErrorBoundary>
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
