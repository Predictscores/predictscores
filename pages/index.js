// FILE: pages/index.js
import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';

const CombinedBets = dynamic(() => import('../components/CombinedBets'), { ssr: false });

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
              if (typeof window !== 'undefined')
                localStorage.setItem('theme', nextDark ? 'dark' : 'light');
            }}
            className="px-4 py-2 rounded-xl bg-[#202542] text-white font-semibold"
            type="button"
          >
            Light mode
          </button>
        </div>

        <div className="px-4 py-2 rounded-full bg-[#202542] text-white text-sm inline-flex items-center gap-6">
          <span>
            {cryptoCd?.m != null ? `Crypto next refresh: ${cryptoCd.m}m ${String(cryptoCd.s).padStart(2,'0')}s`
                                  : 'Crypto next refresh: —'}
          </span>
          <span>
            {kickoffCd?.m != null ? `Next kickoff: ${kickoffCd.m}m ${String(kickoffCd.s).padStart(2,'0')}s`
                                   : 'Next kickoff: —'}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Index() {
  // 10-min kružni crypto timer (ne zavisi od DataContext-a)
  const [cycleBase, setCycleBase] = useState(null);
  useEffect(() => { setCycleBase(Date.now()); }, []);
  const cryptoNextTs = useMemo(() => (cycleBase ? cycleBase + 10 * 60 * 1000 : null), [cycleBase]);
  const cryptoCd = useCountdown(cryptoNextTs);
  useEffect(() => {
    if (!cryptoNextTs) return;
    const t = setInterval(() => {
      if (Date.now() >= cryptoNextTs) setCycleBase(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, [cryptoNextTs]);

  // Next kickoff iz /api/value-bets (poll 60s)
  const [kickTs, setKickTs] = useState(null);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch('/api/value-bets', { cache: 'no-store' });
        const json = await res.json();
        const list = Array.isArray(json?.value_bets) ? json.value_bets : [];
        const candidates = list
          .map(v => v?.datetime_local?.starting_at?.date_time)
          .filter(Boolean)
          .map(s => new Date(s.replace(' ', 'T')).getTime())
          .filter(ts => Number.isFinite(ts) && ts > Date.now());
        const next = candidates.length ? Math.min(...candidates) : null;
        if (alive) setKickTs(next);
      } catch {}
    }
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const kickoffCd = useCountdown(kickTs);

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
            <CombinedBets />
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
