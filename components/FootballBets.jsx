// FILE: components/FootballBets.jsx
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Minimalan fetch direktno iz API-ja (ne oslanja se na DataContext),
 * da bi promena bila izolovana u jednom fajlu.
 */
async function fetchValueBets() {
  try {
    const res = await fetch('/api/value-bets', { cache: 'no-store' });
    const json = await res.json();
    return Array.isArray(json?.value_bets) ? json.value_bets : [];
  } catch {
    return [];
  }
}

/* ----------------- Zastavice ----------------- */
const NAME_TO_CC = {
  // po zemlji
  iceland: 'IS',
  japan: 'JP',
  germany: 'DE',
  england: 'GB',
  scotland: 'GB', // (UK) nema posebne regionalne zastavice u standardnim emoji-ima
  wales: 'GB',
  'faroe-islands': 'FO',
  denmark: 'DK',
  sweden: 'SE',
  norway: 'NO',
  finland: 'FI',
  portugal: 'PT',
  spain: 'ES',
  italy: 'IT',
  france: 'FR',
  netherlands: 'NL',
  belgium: 'BE',
  austria: 'AT',
  switzerland: 'CH',
  turkey: 'TR',
  greece: 'GR',
  serbia: 'RS',
  croatia: 'HR',
  slovenia: 'SI',
  bosnia: 'BA',
  montenegro: 'ME',
  'north macedonia': 'MK',
  albania: 'AL',

  // po nazivu lige
  bund: 'DE', // (Bundesliga, U19 Bundesliga…)
  laLiga: 'ES',
  seriea: 'IT',
  ligue: 'FR',
  eredivisie: 'NL',
  primeira: 'PT',
  j1: 'JP',
  urvalsdeild: 'IS',
  meistaradeildin: 'FO',
};

function ccToFlag(cc) {
  if (!cc) return '';
  return cc
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .replace(/./g, (ch) => String.fromCodePoint(ch.charCodeAt(0) + 127397));
}

function guessFlag(league = {}) {
  const country = String(league.country || '').toLowerCase();
  const name = String(league.name || '').toLowerCase();

  // 1) Probaj preko country
  for (const key of Object.keys(NAME_TO_CC)) {
    if (country.includes(key)) return ccToFlag(NAME_TO_CC[key]);
  }

  // 2) Probaj preko imena lige (heuristike)
  if (name.includes('bundes')) return ccToFlag(NAME_TO_CC.bund);
  if (name.includes('ligue')) return ccToFlag(NAME_TO_CC.ligue);
  if (name.includes('serie a')) return ccToFlag(NAME_TO_CC.seriea);
  if (name.includes('la liga')) return ccToFlag(NAME_TO_CC.laLiga);
  if (name.includes('erediv')) return ccToFlag(NAME_TO_CC.eredivisie);
  if (name.includes('primeira')) return ccToFlag(NAME_TO_CC.primeira);
  if (name.includes('j1')) return ccToFlag(NAME_TO_CC.j1);
  if (name.includes('úrvals') || name.includes('urvals')) return ccToFlag(NAME_TO_CC.urvalsdeild);
  if (name.includes('meistaradeildin')) return ccToFlag(NAME_TO_CC.meistaradeildin);

  return ''; // fallback: bez zastave
}

/* ----------------- UI pomoćnici ----------------- */
function pct(n) {
  const x = typeof n === 'number' ? n : 0;
  return `${Math.round(x)}%`;
}

function bucketColor(bucket) {
  switch (bucket) {
    case 'TOP':
    case 'High':
      return 'bg-emerald-400';
    case 'Moderate':
      return 'bg-sky-400';
    default:
      return 'bg-amber-400';
  }
}

function formatKickoffLocal(dt) {
  // "YYYY-MM-DD HH:mm:ss" -> "HH:mm"
  if (!dt) return '';
  const d = new Date(dt.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Form (last5) sažetak ako postoji u meta.form:
 * home: { wins, draws, losses, gf, ga } | away: {...}
 */
function shortForm(meta) {
  const h = meta?.form?.home;
  const a = meta?.form?.away;
  if (!h || !a) return null;

  const hStr = `H W${h.wins ?? 0} D${h.draws ?? 0} L${h.losses ?? 0}`;
  const aStr = `A W${a.wins ?? 0} D${a.draws ?? 0} L${a.losses ?? 0}`;
  const gsStr = `GS ${h.gf ?? 0}:${h.ga ?? 0} • ${a.gf ?? 0}:${a.ga ?? 0}`;
  return `${hStr} • ${aStr} • ${gsStr}`;
}

/* ----------------- Kartica ----------------- */
function FootballCard({ pick }) {
  const flag = guessFlag(pick.league);
  const kickoff = formatKickoffLocal(pick?.datetime_local?.starting_at?.date_time);
  const confPct = pick?.confidence_pct ?? Math.round((pick?.model_prob || 0) * 100);
  const bucket = pick?.confidence_bucket || (confPct >= 75 ? 'High' : confPct >= 50 ? 'Moderate' : 'Low');

  const selectionLabel = pick?.selection ? String(pick.selection).toUpperCase() : '';
  const odds = pick?.market_odds;
  const market = pick?.market || '1X2';

  const micro = shortForm(pick?.meta);

  return (
    <div className="bg-[#1a2036] rounded-2xl p-4 shadow-sm flex flex-col gap-3 min-h-[150px]">
      {/* Timovi */}
      <div className="text-lg font-semibold text-white">
        {pick?.teams?.home?.name} <span className="text-slate-400">vs</span> {pick?.teams?.away?.name}
      </div>

      {/* Liga + vreme */}
      <div className="text-xs text-slate-300 flex items-center gap-2">
        {flag && <span className="text-base leading-none">{flag}</span>}
        <span className="truncate">{pick?.league?.name}</span>
        {kickoff && <span className="text-slate-400">• {kickoff}</span>}
      </div>

      {/* Predlog (market + selection + kvota ako postoji) */}
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 text-xs rounded-full bg-[#11162a] text-slate-200">{market}</span>
        {selectionLabel && (
          <span className="px-2 py-0.5 text-xs rounded-full bg-[#11162a] text-slate-200">{selectionLabel}</span>
        )}
        {typeof odds === 'number' && odds > 1 ? (
          <span className="px-2 py-0.5 text-xs rounded-full bg-[#21304d] text-slate-100">@ {odds.toFixed(2)}</span>
        ) : null}
      </div>

      {/* Confidence bar */}
      <div className="flex items-center justify-between text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <span>Confidence</span>
          <span className={`inline-block w-2 h-2 rounded-full ${bucketColor(bucket)}`} />
          <span className="text-slate-200">{bucket}</span>
        </div>
        <div className="text-slate-200">{confPct}%</div>
      </div>
      <div className="w-full h-2 bg-[#101427] rounded-full overflow-hidden">
        <div
          className={`h-full ${bucketColor(bucket)}`}
          style={{ width: `${Math.max(3, Math.min(100, confPct))}%` }}
        />
      </div>

      {/* Mikro tekst (Form/H2H skraćeno) */}
      {micro && <div className="text-[11px] text-slate-400 mt-1">{micro}</div>}
    </div>
  );
}

/* ----------------- Glavna lista ----------------- */
export default function FootballBets({ limit = 10, layout = 'full' }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // učitavanje svakih ~90s, ali ne agresivno
  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      const data = await fetchValueBets();
      if (alive) {
        setItems(Array.isArray(data) ? data : []);
        setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 90_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // sortiraj po _score pa po confidence
  const sorted = useMemo(() => {
    return items
      .slice()
      .sort((a, b) => {
        const s = (b?._score ?? 0) - (a?._score ?? 0);
        if (s !== 0) return s;
        const c = (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0);
        return c;
      })
      .slice(0, limit);
  }, [items, limit]);

  if (loading && sorted.length === 0) {
    return <div className="text-slate-400 text-sm">Loading football picks…</div>;
  }

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl bg-[#151a2b] text-[15px] text-slate-300 px-4 py-3">
        No suggestions available.
      </div>
    );
  }

  // layout: u "combined" želimo da kartice lepo popunjavaju levu kolonu (≈33% širine).
  return (
    <div className={`flex flex-col gap-4 ${layout === 'combined' ? 'justify-stretch' : ''}`}>
      {sorted.map((pick) => (
        <FootballCard key={pick.fixture_id ?? `${pick?.teams?.home?.name}-${pick?.teams?.away?.name}`} pick={pick} />
      ))}
    </div>
  );
}
