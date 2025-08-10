// FILE: components/FootballBets.jsx
import React, { useEffect, useMemo, useState } from 'react';

// Helperi
const TZ = 'Europe/Belgrade';
function toLocal(dateStr) {
  try {
    if (!dateStr) return '—';
    const d = new Date(dateStr.endsWith('Z') ? dateStr : `${dateStr}Z`);
    const dateFmt = new Intl.DateTimeFormat('sr-RS', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
    });
    return dateFmt.format(d);
  } catch {
    return '—';
  }
}
function confBucket(pct) {
  if (pct >= 90) return { label: 'Top', color: 'bg-orange-500' };
  if (pct >= 75) return { label: 'High', color: 'bg-emerald-500' };
  if (pct >= 50) return { label: 'Moderate', color: 'bg-sky-500' };
  return { label: 'Low', color: 'bg-amber-500' };
}
function safePct(val) {
  if (typeof val === 'number') {
    if (val <= 1) return Math.round(val * 100);
    return Math.round(val);
  }
  return 0;
}

export default function FootballBets({ limit = 10, layout = 'full' }) {
  const [loading, setLoading] = useState(true);
  const [picks, setPicks] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const res = await fetch('/api/value-bets');
        const json = await res.json();
        if (!alive) return;
        setPicks(Array.isArray(json?.value_bets) ? json.value_bets : []);
      } catch (e) {
        if (!alive) return;
        setErr('Greška pri učitavanju');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Sort po našem skor-u (ako postoji), pa po confidence-u
  const ordered = useMemo(() => {
    const rows = picks.slice();
    rows.sort((a, b) => {
      const s = (b?._score ?? 0) - (a?._score ?? 0);
      if (s !== 0) return s;
      const ca = safePct(a?.confidence_pct ?? a?.model_prob);
      const cb = safePct(b?.confidence_pct ?? b?.model_prob);
      return cb - ca;
    });
    return rows.slice(0, limit);
  }, [picks, limit]);

  if (loading) return <div className="text-slate-400 text-sm">Učitavam fudbalske predloge…</div>;
  if (err) return <div className="text-rose-400 text-sm">{err}</div>;
  if (!ordered.length) {
    return (
      <div className="rounded-xl bg-[#141827] text-amber-200/90 px-4 py-3">
        No suggestions available.
      </div>
    );
  }

  return (
    <div className={layout === 'combined' ? 'space-y-4' : 'space-y-4'}>
      {ordered.map((p) => {
        const home = p?.teams?.home?.name ?? 'Home';
        const away = p?.teams?.away?.name ?? 'Away';
        const league = p?.league?.name ?? 'League';
        // vreme
        const dtRaw = p?.datetime_local?.starting_at?.date_time || p?.datetime_local?.date_time;
        const kickoff = toLocal(dtRaw);

        // tip i kvota
        const pick = (p?.selection ?? '').toString().toUpperCase(); // '1', 'X', '2'…
        const odds = p?.market_odds ? Number(p.market_odds).toFixed(2) : null;

        // confidence
        const pct = safePct(p?.confidence_pct ?? p?.model_prob);
        const bucket = confBucket(pct);

        return (
          <div
            key={`${p.fixture_id}-${home}-${away}-${kickoff}`}
            className="
              bg-[#141827] rounded-2xl p-4
              flex flex-col justify-between
              min-h-[168px] md:min-h-[184px]  /* ujednači visinu u odnosu na kripto kartice */
              border border-transparent hover:border-slate-700/60 transition
            "
          >
            {/* Gornji red: timovi + tip/kvota desno */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-slate-100 font-semibold truncate">
                  {home} <span className="text-slate-400">vs</span> {away}
                </div>

                <div className="mt-1 text-xs text-slate-400 flex items-center gap-2">
                  {/* liga i vreme; bez zemlje kako si tražio */}
                  <span className="px-2 py-0.5 rounded-full bg-slate-700/40 text-slate-200">{league}</span>
                  <span>•</span>
                  <span>{kickoff}</span>
                </div>
              </div>

              {/* Tip (1/X/2) + kvota ako postoji – NEMA više “FALLBACK” */}
              <div className="shrink-0 flex items-center gap-2">
                <span
                  className="
                    inline-flex items-center justify-center
                    w-8 h-8 rounded-full bg-indigo-500/15 text-indigo-300
                    font-semibold text-sm
                  "
                  title="Predlog tip"
                >
                  {pick || '—'}
                </span>
                {odds && (
                  <span className="text-xs text-slate-300 bg-slate-700/40 rounded-full px-2 py-0.5">
                    @ {odds}
                  </span>
                )}
              </div>
            </div>

            {/* Donji deo: confidence kao na kriptu */}
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <div className="flex items-center gap-2">
                  <span>Confidence</span>
                  <span className={`inline-block w-2 h-2 rounded-full ${bucket.color}`} />
                  <span className="text-slate-400">{bucket.label}</span>
                </div>
                <span className="text-slate-400">{pct}%</span>
              </div>

              <div className="mt-2 h-2 rounded-full bg-slate-700/40 overflow-hidden">
                <div
                  className="h-2 bg-gradient-to-r from-emerald-400 via-sky-400 to-indigo-400"
                  style={{ width: `${Math.max(5, Math.min(100, pct))}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
