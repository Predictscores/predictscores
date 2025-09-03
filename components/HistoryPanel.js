// components/HistoryPanel.jsx
import React, { useEffect, useState } from "react";

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok:false, error:"non-JSON", raw:t }; }
  } catch (e) {
    return { ok:false, error: String(e?.message || e) };
  }
}

function StatCard({ label, value, accent }) {
  return (
    <div className="p-3 rounded-2xl border shadow-sm">
      <div className="text-xs opacity-60">{label}</div>
      <div className={`text-lg font-semibold ${accent || ""}`}>{value}</div>
    </div>
  );
}

function StatusIcon({ status }) {
  if (status === "win") return <span title="Win" aria-label="Win">✅</span>;
  if (status === "loss") return <span title="Loss" aria-label="Loss">❌</span>;
  if (status === "push") return <span title="Push" aria-label="Push">🟡</span>;
  return <span title="Pending" aria-label="Pending">⏳</span>;
}

export default function HistoryPanel({ days = 14, top = 3, slots = "am,pm,late" }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      // Prefer new ROI endpoint; if fails, we can fallback later if needed
      const url = `/api/history-roi?days=${encodeURIComponent(days)}&top=${encodeURIComponent(top)}&slots=${encodeURIComponent(slots)}`;
      const j = await safeJson(url);
      if (!j?.ok) { setErr(j?.error || "Greška u /api/history-roi"); return; }
      setData(j);
    })();
  }, [days, top, slots]);

  if (err) return <div className="p-3 text-sm text-red-600">History: {err}</div>;
  if (!data) return <div className="p-3 text-sm opacity-70">History: učitavam…</div>;

  const s = data.summary || {};
  const daysArr = data.days || [];

  const wl = `${s.wins ?? 0}-${(s.settled ?? 0) - (s.wins ?? 0)}`;
  const roiClass = (s.profit ?? 0) >= 0 ? "text-green-600" : "text-red-600";

  return (
    <div className="w-full">
      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <StatCard label="Period" value={`${s.days ?? days} dana`} />
        <StatCard label="Top-N po slotu" value={s.top ?? top} />
        <StatCard label="Picks / Settled" value={`${s.picks ?? 0} / ${s.settled ?? 0}`} />
        <StatCard label="W/L" value={wl} />
        <StatCard label="Win rate" value={`${(s.win_rate_pct ?? 0).toFixed(2)}%`} />
        <StatCard label="ROI" value={`${(s.roi_pct ?? 0).toFixed(2)}%`} accent={roiClass} />
      </div>

      {/* Days grouped list */}
      <div className="space-y-5">
        {daysArr.map(day => (
          <div key={day.ymd} className="rounded-2xl border p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold">{day.ymd}</div>
              <div className="text-xs opacity-70">
                Settled {day.settled ?? 0}/{day.picks ?? 0} •
                {' '}Win {(day.win_rate_pct ?? 0).toFixed(2)}% •
                {' '}ROI <span className={`${(day.profit ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {(day.roi_pct ?? 0).toFixed(2)}%
                </span>
              </div>
            </div>

            <div className="divide-y">
              {(day.items || []).map((it, idx) => (
                <div key={`${it.fixture_id || idx}`} className="py-2 flex items-center justify-between">
                  <div className="flex flex-col md:flex-row md:items-center gap-1 md:gap-3">
                    <div className="text-xs opacity-70 w-16">{it.time_hhmm || "—"}</div>
                    <div className="text-sm">
                      <span className="font-medium">{it.home}</span> — <span className="font-medium">{it.away}</span>
                      <span className="ml-2 text-xs opacity-60">{it.league_name || ""}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-xs md:text-sm opacity-80">
                      {String(it.market || "").toUpperCase()} • <span className="font-medium">{it.pick_code || it.selection_label || ""}</span>
                    </div>
                    <div className="text-sm w-14 text-right">{it.odds ? it.odds.toFixed(2) : "—"}</div>
                    <div className="w-6 text-right"><StatusIcon status={it.status} /></div>
                  </div>
                </div>
              ))}
              {(!day.items || day.items.length === 0) && (
                <div className="py-2 text-sm opacity-60">Nema stavki za ovaj dan.</div>
              )}
            </div>
          </div>
        ))}
        {daysArr.length === 0 && (
          <div className="p-3 text-sm opacity-60">Nema istorije za prikaz.</div>
        )}
      </div>
    </div>
  );
}
