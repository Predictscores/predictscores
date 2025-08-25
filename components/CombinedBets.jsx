'use client';
import React from 'react';

const TZ = 'Europe/Belgrade';

function safeISO(iso) {
  const s = String(iso || '');
  // Ako nema vremensku zonu u stringu, dodaj Z (UTC) da Date ne “pada” u lokalno.
  return /Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
}

function fmtKO(iso) {
  try {
    const dt = new Date(safeISO(iso));
    return new Intl.DateTimeFormat('sr-RS', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
    }).format(dt);
  } catch {
    return '—';
  }
}

function confColor(pct) {
  const c = Number(pct || 0);
  if (c < 50) return 'bg-amber-500';         // Low
  if (c < 75) return 'bg-sky-500';           // Moderate
  return 'bg-emerald-500';                   // High
}

function ConfidenceBar({ value }) {
  const pct = Math.max(0, Math.min(100, Number(value || 0)));
  return (
    <div className="w-full rounded-md bg-gray-200 h-2 relative overflow-hidden">
      <div
        className={`h-2 ${confColor(pct)}`}
        style={{ width: `${pct}%` }}
      />
      <div className="absolute -top-5 right-0 text-xs font-medium">{pct}%</div>
    </div>
  );
}

function Card({ item }) {
  const koIso =
    item?.datetime_local?.starting_at?.date_time ||
    item?.datetime_local?.date_time ||
    item?.time?.starting_at?.date_time;
  const ko = fmtKO(koIso);

  return (
    <div className="rounded-2xl shadow p-4 border border-gray-100 flex flex-col gap-2">
      <div className="text-sm text-gray-500">{ko} • {item?.league?.name || ''}</div>
      <div className="text-base font-semibold">
        {item?.teams?.home?.name} vs {item?.teams?.away?.name}
      </div>
      <div className="text-sm text-gray-600">
        {item?.market} — {item?.selection} @ {Number(item?.market_odds || 0).toFixed(2)}
      </div>
      <ConfidenceBar value={item?.confidence_pct} />
    </div>
  );
}

export default function CombinedBets() {
  const [football, setFootball] = React.useState([]);
  const [crypto, setCrypto] = React.useState([]);
  const [meta, setMeta] = React.useState({ slot: null, built_at: null });

  React.useEffect(() => {
    let mounted = true;

    // FOOTBALL: koristi ISKLJUČIVO zaključani feed
    fetch('/api/value-bets-locked', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (!mounted) return;
        const items = Array.isArray(j?.items) ? j.items : [];
        setFootball(items);
        setMeta({ slot: j?.slot || null, built_at: j?.built_at || null });
      })
      .catch(() => { /* ignore */ });

    // CRYPTO: ne ruši levu kolonu ako je prazno/greška
    fetch('/api/crypto-bets-locked', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.resolve({ items: [] }))
      .then(j => {
        if (!mounted) return;
        setCrypto(Array.isArray(j?.items) ? j.items : []);
      })
      .catch(() => setCrypto([]));

    return () => { mounted = false; };
  }, []);

  const left = football.slice(0, 3);   // Top-3 Football iz aktivnog slota
  const right = crypto.slice(0, 3);     // Top-3 Crypto (ako ima)

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="flex flex-col gap-3">
        <div className="text-sm text-gray-500">
          Football — slot: <b>{meta.slot || '—'}</b> {meta.built_at ? `· built ${new Date(meta.built_at).toLocaleTimeString('sr-RS')}` : ''}
        </div>
        {left.length === 0 ? (
          <div className="text-sm text-gray-500">Nema stavki za trenutni slot.</div>
        ) : (
          left.map((it) => <Card key={`${it.fixture_id}|${it.market}|${it.selection}`} item={it} />)
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm text-gray-500">Crypto</div>
        {right.length === 0 ? (
          <div className="text-sm text-gray-400">—</div>
        ) : (
          right.map((it, idx) => (
            <div key={idx} className="rounded-2xl shadow p-4 border border-gray-100">
              {/* prilagodi po tvom crypto obliku */}
              <div className="text-base font-semibold">{it?.symbol || it?.name}</div>
              <div className="text-sm text-gray-600">{it?.reason || ''}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
