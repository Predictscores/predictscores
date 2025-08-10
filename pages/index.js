// FILE: pages/index.js
import Head from 'next/head';
import dynamic from 'next/dynamic';
import React, { useEffect, useMemo, useState } from 'react';

// Klijent-only import sa fallbackom (sprečava SSR i “ćutljivi” pad)
const CombinedBets = dynamic(() => import('../components/CombinedBets'), {
  ssr: false,
  loading: () => <div className="text-slate-400">Loading picks…</div>,
});

// Mali ErrorBoundary da ne proguta celu sekciju ako neki child baci grešku
class SafeBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err) { console.error('Combined section error:', err); }
  render() {
    if (this.state.hasError) {
      return <div className="text-rose-400">Couldn’t render picks. Refresh and try again.</div>;
    }
    return this.props.children;
  }
}

function useCountdown(targetTs) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = targetTs ? Math.max(0, targetTs - now) : null;
  const m = ms != null ? Math.floor(ms / 60000) : null;
  const s = ms != null ? Math.floor((ms % 60000) / 1000) : null;
  return { m, s, ms };
}

function HeaderBar({ cryptoCd, kickoffCd }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <h1 className="text-3xl md:text-4xl font-extrabold text-white">
        AI Top fudbalske i Kripto Prognoze
      </h1>

      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => (typeof window !== 'undefined') && window.location.reload()}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            Refresh all
          </button>
          <button
            onClick={() => {
              const el = document.documentElement;
              const nextDark = !el.classList.contains('dark');
              el.classList.toggle('dark', nextDark);
              if (typeof window !== 'undefined') {
                localStorage.setItem('theme', nextDark ? 'dark' : 'light');
              }
            }}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            Light mode
          </button>
        </div>

        <div className="px-4 py-2 rounded-full bg-[#202542] text-white text-sm inline-flex items-center gap-6">
          <span>
            {cryptoCd?.m != null
              ? `Crypto next refresh: ${cryptoCd.m}m ${String(cryptoCd.s).padStart(2,'0')}s`
              : 'Crypto next refresh: —'}
          </span>
          <span>
            {kickoffCd?.m != null
              ? `Next kickoff: ${kickoffCd.m}m ${String(kickoffCd.s).padStart(2,'0')}s`
              : 'Next kickoff: —'}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Index() {
  // Tema – inicijalizacija tek posle mount-a (da ne “puca” na SSR/hydration)
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('theme') : null;
    const wantDark = saved ? saved === 'dark' : true;
    document.documentElement.classList.toggle('dark', wantDark);
  }, []);

  // 10-min ciklični crypto timer (lokalno, stabilno)
  const [cycleBase, setCycleBase] = useState(null);
  useEffect(() => { setCycleBase(Date.now()); }, []);
  const cryptoNextTs = useMemo(
    () => (cycleBase ? cycleBase + 10 * 60 * 1000 : null),
    [cycleBase]
  );
  const cryptoCd = useCountdown(cryptoNextTs);
  useEffect(() => {
    if (!cryptoNextTs) return;
    const t = setInterval(() => {
      if (Date.now() >= cryptoNextTs) setCycleBase(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, [cryptoNextTs]);

  // Next kickoff iz API-ja (poll 60s)
  const [kickTs, setKickTs] = useState(null);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch('/api/value-bets', { cache: 'no-store' });
        const json = await res.json();
        const list = Array.isArray(json?.value_bets) ? json.value_bets : [];
        const ts = list
          .map(v => v?.datetime_local?.starting_at?.date_time)
          .filter(Boolean)
          .map(s => new Date(s.replace(' ', 'T')).getTime())
          .filter(t => Number.isFinite(t) && t > Date.now());
        const next = ts.length ? Math.min(...ts) : null;
        if (alive) setKickTs(next);
      } catch (e) {
        console.warn('kickoff fetch failed', e);
      }
    }
    load();
    const timer = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const kickoffCd = useCountdown(kickTs);

  // Client-only mount gate (ako nešto u Combined zavisi od window/ctx)
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
          <HeaderBar cryptoCd={cryptoCd} kickoffCd={kickoffCd} />

          <div className="mt-6">
            {mounted ? (
              <SafeBoundary>
                <CombinedBets />
              </SafeBoundary>
            ) : (
              <div className="text-slate-400">Loading picks…</div>
            )}
          </div>

          <div className="mt-8 text-sm text-slate-300 flex flex-wrap items-center gap-3">
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
        </div>
      </main>
    </>
  );
}
