'use client';
import React from 'react';

const TZ = 'Europe/Belgrade';

function fmtKO(iso) {
  try {
    const dt = new Date(String(iso || '').replace(' ', 'T'));
    return new Intl.DateTimeFormat('sr-RS', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
    }).format(dt);
  } catch {
    return '—';
  }
}

// fiksne boje (bez Tailwind dinamike)
function confColor(pct) {
  const c = Number(pct || 0);
  if (c < 50) return '#f59e0b'; // Low
  if (c < 75) return '#0ea5e9'; // Moderate
  return '#10b981';             // High
}
function ConfidenceBar({ value }) {
  const pct = Math.max(0, Math.min(100, Number(value || 0)));
  return (
    <div style={{ width: '100%', height: 8, borderRadius: 6, background: '#e5e7eb', position: 'relative', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: 8, background: confColor(pct), borderRadius: 6 }} />
      <div style={{ position: 'absolute', top: -18, right: 0, fontSize: 12, fontWeight: 600 }}>{pct}%</div>
    </div>
  );
}

function Card({ item }) {
  const koIso =
    item?.datetime_local?.starting_at?.date_time ||
    item?.datetime_local?.date_time ||
    item?.time?.starting_at?.date_time ||
    '';
  const ko = fmtKO(koIso);
  const odds = Number(item?.market_odds || 0);

  return (
    <div className="rounded-2xl shadow p-4 border border-gray-800/30 bg-[#0f172a] flex flex-col gap-2">
      <div className="text-sm text-gray-400">{ko} • {item?.league?.name || ''}</div>
      <div className="text-base font-semibold text-white">
        {item?.teams?.home?.name} vs {item?.teams?.away?.name}
      </div>
      <div className="text-sm text-gray-300">
        {item?.market} — {item?.selection}{' '}
        {odds ? <span className="text-gray-200">@ {odds.toFixed(2)}</span> : null}
      </div>
      <ConfidenceBar value={item?.confidence_pct} />
    </div>
  );
}

export default function CombinedBets() {
  const [football, setFootball] = React.useState([]);
  const [crypto, setCrypto] = React.useState([]);
  const [meta, setMeta] = React.useState({ slot: null, built_at: null, nextKO: '—' });

  React.useEffect(() => {
    let mounted = true;

    fetch('/api/value-bets-locked', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (!mounted) return;
        const items = Array.isArray(j?.items) ? j.items : [];
        setFootball(items);

        // Next kickoff iz dobijenih stavki (bez buducnost filtera jer želiš ceo slot)
        const times = items
          .map(it => it?.datetime_local?.starting_at?.date_time || it?.datetime_local?.date_time || it?.time?.starting_at?.date_time)
          .filter(Boolean)
          .map(s => new Date(String(s).replace(' ', 'T')))
          .sort((a,b) => a - b);
        const nextKO = times[0]
          ? new Intl.DateTimeFormat('sr-RS', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(times[0])
          : '—';

        setMeta({ slot: j?.slot || null, built_at: j?.built_at || null, nextKO });
      })
      .catch(() => {});

    fetch('/api/crypto-bets-locked', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.resolve({ items: [] })))
      .then(j => { if (!mounted) return; setCrypto(Array.isArray(j?.items) ? j.items : []); })
      .catch(() => setCrypto([]));

    return () => { mounted = false; };
  }, []);

  const left = football.slice(0, 3);   // Top-3 Football
  const right = crypto.slice(0, 3);     // Top-3 Crypto

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="flex flex-col gap-3">
        <div className="text-sm text-gray-300">
          Football — slot: <b>{meta.slot || '—'}</b>{' '}
          {meta.built_at ? `· built ${new Date(meta.built_at).toLocaleTimeString('sr-RS')}` : ''}{' '}
          · Next kickoff: <b>{meta.nextKO}</b>
        </div>
        {left.length === 0 ? (
          <div className="text-sm text-gray-400">Nema stavki za ovaj slot.</div>
        ) : (
          left.map((it) => <Card key={`${it.fixture_id}|${it.market}|${it.selection}`} item={it} />)
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm text-gray-300">Crypto</div>
        {right.length === 0 ? (
          <div className="text-sm text-gray-500">—</div>
        ) : (
          right.map((it, idx) => (
            <div key={idx} className="rounded-2xl shadow p-4 border border-gray-800/30 bg-[#0f172a]">
              <div className="text-base font-semibold text-white">{it?.symbol || it?.name}</div>
              <div className="text-sm text-gray-300">{it?.reason || ''}</div>
            </div>
          ))
        )}
      </div>

      <div className="col-span-2 text-xs text-gray-400 mt-2">
        Confidence legend: <span style={{ color: '#10b981' }}>High (≥75%)</span> ·{' '}
        <span style={{ color: '#0ea5e9' }}>Moderate (50–75%)</span> ·{' '}
        <span style={{ color: '#f59e0b' }}>Low (&lt;50%)</span>
      </div>
    </div>
  );
}
