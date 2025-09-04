// components/HistoryPanel.js
"use client";

import React, { useEffect, useMemo, useState } from "react";

const TZ = "Europe/Belgrade";

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok:false, error:"non-JSON", raw:t }; }
  } catch (e) {
    return { ok:false, error:String(e?.message||e) };
  }
}

function statusIcon(status) {
  const s = String(status||"").toLowerCase();
  if (s === "win") return "✅";
  if (s === "loss") return "❌";
  if (s === "push" || s === "void") return "⏸";
  return "⏳"; // pending / unknown
}

function fmtOdd(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function Row({ it }) {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl bg-[#1f2339]">
      <div className="min-w-0">
        <div className="text-xs text-slate-400">
          {it.ymd} {it.time_hhmm || ""} · {it.league_name || it.league_country || ""}
        </div>
        <div className="font-semibold truncate">
          {it.home} <span className="text-slate-400">vs</span> {it.away}
        </div>
        <div className="text-sm text-slate-300">
          {it.market || "—"}{it.selection_label ? " → " : ""}{it.selection_label || it.pick || "—"}{" "}
          <span className="text-slate-400">({fmtOdd(it.odds)})</span>
        </div>
      </div>
      <div className="text-xl pl-3 shrink-0">
        {statusIcon(it.status)}
      </div>
    </div>
  );
}

export default function HistoryPanel({ days = 14, top = 3 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const j = await safeJson(`/api/history-roi?days=${days}&top=${top}`);
      if (j?.ok) setData(j);
      else {
        setErr(j?.error || "Greška u /api/history-roi");
        setData(null);
      }
    } catch (e) {
      setErr(String(e?.message || e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [days, top]);

  const flatItems = useMemo(() => {
    const arr = [];
    const daysArr = Array.isArray(data?.days) ? data.days : [];
    for (const d of daysArr) {
      const items = Array.isArray(d?.items) ? d.items : [];
      for (const it of items) {
        arr.push({
          key: `${d.ymd}:${it.fixture_id || it.home+'-'+it.away}:${it.market || ""}:${it.pick_code || ""}`,
          ymd: d.ymd,
          ...it,
        });
      }
    }
    return arr;
  }, [data]);

  const summary = data?.summary || null;

  return (
    <div className="space-y-4">
      {loading ? (
        <div className="text-slate-400 text-sm">Učitavam…</div>
      ) : err ? (
        <div className="text-red-400 text-sm">Greška: {err}</div>
      ) : !summary ? (
        <div className="text-slate-400 text-sm">Nema podataka za poslednjih {days} dana.</div>
      ) : (
        <>
          {/* Summary header */}
          <div className="rounded-2xl bg-[#15182a] p-4">
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-200">
              <div className="font-semibold">History — {summary.days}d</div>
              <div>Picks: <b>{summary.picks}</b></div>
              <div>Settled: <b>{summary.settled}</b></div>
              <div>W/L: <b>{summary.wins}</b> / <b>{Math.max(0, (summary.settled||0) - (summary.wins||0) - (summary.pushes||0))}</b></div>
              <div>Push: <b>{summary.pushes}</b></div>
              <div>Profit: <b>{Number(summary.profit||0).toFixed(3)}</b>u</div>
              <div>ROI: <b>{Number(summary.roi_pct||0).toFixed(2)}%</b></div>
              <div>Win%: <b>{Number(summary.win_rate_pct||0).toFixed(2)}%</b></div>
            </div>
          </div>

          {/* List */}
          <div className="rounded-2xl bg-[#15182a] p-4">
            <div className="text-base font-semibold text-white mb-3">Rezultati</div>
            {!flatItems.length ? (
              <div className="text-slate-400 text-sm">Još nema završenih mečeva u periodu.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {flatItems.map((it) => <Row key={it.key} it={it} />)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
