import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";

const CombinedBets = dynamic(() => import("../components/CombinedBets"), {
  ssr: false,
  loading: () => <div className="mt-6 text-slate-400 text-sm">Loading suggestions…</div>,
});

function useDarkMode() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("theme") : null;
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

function fmtCountdown(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export default function Index() {
  const { toggle } = useDarkMode();
  const [now, setNow] = useState(Date.now());
  const [cryptoNextAt, setCryptoNextAt] = useState(null);
  const [mounted, setMounted] = useState(false);

  // Tabs
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto
  const [subTab, setSubTab] = useState("Kick-Off"); // Kick-Off | Confidence | History

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setCryptoNextAt(Date.now() + 10 * 60 * 1000);
  }, []);

  const cryptoTL = useMemo(() => {
    if (!cryptoNextAt) return null;
    const ms = Math.max(0, cryptoNextAt - now);
    return ms === 0 ? "—" : fmtCountdown(ms);
  }, [cryptoNextAt, now]);

  const TabBtn = ({ active, children, onClick }) => (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-sm font-semibold ${
        active ? "bg-[#23304f] text-white" : "bg-[#151a2b] text-slate-300"
      }`}
      type="button"
    >
      {children}
    </button>
  );

  return (
    <>
      <Head>
        <title>Predictscores — Live Picks</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className="min-h-screen bg-[#0f1116] text-white">
        <div className="max-w-7xl mx-auto p-4 md:p-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-3xl md:text-4xl font-extrabold text-white">
              AI Top fudbalske i Kripto Prognoze
            </h1>

            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.location.reload()}
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
                <span>Crypto next refresh: {cryptoTL || "—"}</span>
              </div>
            </div>
          </div>

          {/* Top tabs */}
          <div className="flex items-center gap-3 mt-6">
            <TabBtn active={tab === "Combined"} onClick={() => setTab("Combined")}>Combined</TabBtn>
            <TabBtn active={tab === "Football"} onClick={() => setTab("Football")}>Football</TabBtn>
            <TabBtn active={tab === "Crypto"} onClick={() => setTab("Crypto")}>Crypto</TabBtn>
          </div>

          {/* Football sub-tabs */}
          {tab === "Football" && (
            <div className="flex items-center gap-3 mt-4">
              <TabBtn active={subTab === "Kick-Off"} onClick={() => setSubTab("Kick-Off")}>Kick-Off</TabBtn>
              <TabBtn active={subTab === "Confidence"} onClick={() => setSubTab("Confidence")}>Confidence</TabBtn>
              <TabBtn active={subTab === "History"} onClick={() => setSubTab("History")}>History</TabBtn>
            </div>
          )}

          {/* Content */}
          <div className="mt-6">
            {mounted ? (
              <CombinedBets currentTab={tab} subTab={subTab} />
            ) : (
              <div className="text-slate-400 text-sm">Loading…</div>
            )}
          </div>

          {/* Legenda */}
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
        </div>
      </main>
    </>
  );
 }
