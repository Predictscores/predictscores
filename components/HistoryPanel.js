'use client';
import React from 'react';

const TZ = 'Europe/Belgrade';
function fmtKO(iso) {
  try {
    const dt = new Date(String(iso || '').replace(' ', 'T'));
    return new Intl.DateTimeFormat('sr-RS', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(dt);
  } catch { return '—'; }
}

export default function HistoryPanel() {
  const [items, setItems] = React.useState([]);
  const [aggr, setAggr] = React.useState({});

  React.useEffect(() => {
    let mounted = true;

    // prvo probaj zaključani endpoint; ako ne postoji, fallback na /api/history
    const fetchOne = (url) =>
      fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.resolve(null)).catch(() => null);

    (async () => {
      const locked = await fetchOne('/api/history-locked');
      const data = locked || (await fetchOne('/api/history')) || {};
      if (!mounted) return;

      const all = Array.isArray(data?.items) ? data.items : [];
      // samo završene Top-3 iz prethodnih slotova (ako dolaze grupisane, uzmi sve pa filtriraj na finished=true)
      const finished = all.filter(x => x?.finished || x?.status === 'FT' || x?.result != null);
      setItems(finished);

      setAggr(data?.aggregates || {});
    })();

    return () => { mounted = false; };
  }, []);

  const a7 = aggr?.['7d'] || {};
  const a14 = aggr?.['14d'] || {};

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="text-sm text-gray-300">
        History · 7d: <b>{a7.win_pct != null ? `${Math.round(a7.win_pct)}%` : '—'} / {a7.roi_pct != null ? `${Math.round(a7.roi_pct)}% ROI` : '—'}</b>
        {'  '}· 14d: <b>{a14.win_pct != null ? `${Math.round(a14.win_pct)}%` : '—'} / {a14.roi_pct != null ? `${Math.round(a14.roi_pct)}% ROI` : '—'}</b>
      </div>

      <div className="rounded-2xl border border-gray-800/30 overflow-hidden">
        {items.length === 0 ? (
          <div className="p-4 text-sm text-gray-400">Još nema završених Top-3 iz prethodnih slotova.</div>
        ) : (
          items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-12 items-center gap-3 py-2 px-3 border-b border-gray-800/30">
              <div className="col-span-3 text-xs text-gray-500">{fmtKO(it?.datetime_local?.starting_at?.date_time || it?.ko)}</div>
              <div className="col-span-5 text-sm text-white">{it?.teams?.home?.name} vs {it?.teams?.away?.name}</div>
              <div className="col-span-2 text-sm text-gray-300">{it?.market} — {it?.selection}</div>
              <div className="col-span-2 text-sm font-semibold" style={{color: it?.won ? '#10b981' : '#ef4444'}}>{it?.won ? 'WIN' : 'LOSE'}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
