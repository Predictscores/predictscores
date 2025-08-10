// FILE: pages/index.js
import React, { useContext, useEffect, useMemo, useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import { DataContext } from "../contexts/DataContext";

// ---- lazy import Combined sa isključenim SSR-om + jednostavan loading
const CombinedBetsLazy = dynamic(() => import("../components/CombinedBets"), {
  ssr: false,
  loading: () => (
    <div className="mt-6 text-slate-400 text-sm">Loading suggestions…</div>
  ),
});

// ---- vrlo jednostavan error boundary (samo za klijent)
function ErrorBoundary({ children }) {
  const [err, setErr] = useState(null);
  if (err) {
    return (
      <div className="mt-6 p-4 rounded-xl bg-[#1a1f36] text-rose-300 text-sm">
        Something went wrong while rendering the list. Try Refresh all.
      </div>
    );
  }
  return (
    <React.Suspense
      fallback={<div className="mt-6 text-slate-400 text-sm">Loading…</div>}
    >
      {React.cloneElement(children, { onError: setErr })}
    </React.Suspense>
  );
}

// ---- Dark mode toggle (samo klijent)
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

// ---- Header sa tajmerima
function HeaderBar() {
  const { refreshAll, nextCryptoUpdate, nextKickoffAt } =
    useContext(DataContext) || {};
  const { toggle } = useDarkMode();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const cryptoTL = useMemo(() => {
    if (!nextCryptoUpdate) return null;
    const ms = Math.max(0, nextCryptoUpdate - now);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }, [nextCryptoUpdate, now]);

  const kickoffTL = useMemo(() => {
    if (!nextKickoffAt) return null;
    const ms = Math.max(0, new Date(nextKickoffAt).getTime() - now);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }, [nextKickoffAt, now]);

  return (
    <div className="flex items-start justify-between gap-4">
      <h1 className="text-3xl md:text-4xl font-extrabold text-white">
        AI Top fudbalske i Kripto Prognoze
      </h1>

      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-3">
          <button
            onClick={refreshAll}
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
            Light mode
          </button>
        </div>

        <div className="px-4 py-2 rounded-full bg-[#202542] text-white text-sm inline-flex items-center gap-6">
          <span>
            Crypto next refresh: {cryptoTL ? cryptoTL : "—"}
          </span>
          <span>Next kickoff: {kickoffTL ? kickoffTL : "—"}</span>
        </div>
      </div>
    </div>
  );
}

// ---- Legenda (ostaje ista)
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

function HomePage() {
  return (
    <>
      <Head>
        <title>Predictscores — Live Picks</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className="min-h-screen bg-[#0f1116] text-white">
        <div className="max-w-7xl mx-auto p-4 md:p-6">
          <HeaderBar />

          {/* >>> OVO VRAĆA TABOVE (Combined/Football/Crypto) <<< */}
          <div className="mt-6">
            <ErrorBoundary>
              <CombinedBetsLazy />
            </ErrorBoundary>
          </div>

          {/* legenda na dnu */}
          <Legend />
        </div>
      </main>
    </>
  );
}

export default function Index() {
  return <HomePage />;
}
