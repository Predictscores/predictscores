// pages/crypto/index.js
import { useEffect, useState, useMemo } from "react";

export default function CryptoSignalsPage() {
  const [data, setData] = useState({ ok: true, items: [], count: 0, ts: 0, ttl_min: null, source: "cache" });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  async function load() {
    try {
      setErr("");
      const r = await fetch("/api/crypto", { cache: "no-store" });
      const j = await r.json();
      setData(j || { ok: false, items: [] });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // 60s poll
    return () => clearInterval(id);
  }, []);

  const items = useMemo(() => Array.isArray(data?.items) ? data.items : [], [data]);

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-6xl mx-auto px-4 py-6">
        <header className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Crypto – Top Signals</h1>
            <p className="text-sm text-gray-600">
              Source: {data?.source || "?"} • Updated: {data?.ts ? new Date(data.ts).toLocaleString() : "—"}
              {data?.ttl_min ? ` • TTL: ${data.ttl_min}m` : ""}
            </p>
          </div>
          <button
            onClick={load}
            className="px-3 py-2 rounded-lg bg-black text-white text-sm hover:bg-gray-800"
            disabled={loading}
            title="Refresh"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </header>

        {err && <div className="mb-4 p-3 bg-red-100 text-red-700 rounded">{err}</div>}

        {loading && items.length === 0 ? (
          <SkeletonGrid />
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((it) => <SignalCard key={it.symbol} it={it} />)}
          </div>
        )}
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-10 text-center bg-white">
      <p className="text-lg font-semibold">Trenutno nema jakih signala.</p>
      <p className="text-sm text-gray-600 mt-1">Vrati se kasnije – osvežava se automatski.</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl bg-white border p-4 animate-pulse">
          <div className="h-5 w-24 bg-gray-200 rounded mb-2" />
          <div className="h-4 w-40 bg-gray-200 rounded mb-4" />
          <div className="h-6 w-20 bg-gray-200 rounded mb-4" />
          <div className="space-y-2">
            <div className="h-3 w-full bg-gray-200 rounded" />
            <div className="h-3 w-5/6 bg-gray-200 rounded" />
            <div className="h-3 w-2/3 bg-gray-200 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SignalCard({ it }) {
  const dirColor = it.signal === "LONG" ? "bg-green-600" : "bg-red-600";
  const dirText  = it.signal === "LONG" ? "LONG" : "SHORT";

  const pct = (v) => (v == null ? "—" : `${Number(v).toFixed(2)}%`);
  const bnLink = it?.pair ? `https://www.binance.com/en/trade/${encodeURIComponent(it.pair.replace("USDT","_USDT"))}?type=spot` : null;

  return (
    <div className="rounded-xl bg-white border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {it.image ? <img src={it.image} alt={it.symbol} className="h-8 w-8 rounded" /> : null}
          <div>
            <div className="font-semibold">{it.name} <span className="text-gray-500">({it.symbol})</span></div>
            <div className="text-xs text-gray-500">Price: {it.price != null ? `$${it.price}` : "—"}{it.pair ? ` • ${it.pair}` : ""}</div>
          </div>
        </div>
        <span className={`text-white text-xs px-2 py-1 rounded-lg ${dirColor}`}>{dirText}</span>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Confidence</span>
          <span className="text-gray-700">{it.confidence_pct}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded h-2 mt-1">
          <div className={`${dirColor} h-2 rounded`} style={{ width: `${it.confidence_pct || 0}%` }} />
        </div>
      </div>

      <ul className="text-sm text-gray-700 space-y-1">
        <li>30m: <b>{pct(it.m30_pct)}</b> • 1h: <b>{pct(it.h1_pct)}</b> • 4h: <b>{pct(it.h4_pct)}</b></li>
        <li>24h: <b>{pct(it.d24_pct)}</b> • 7d: <b>{pct(it.d7_pct)}</b></li>
        {it.tp && it.sl ? <li>Entry: <b>${it.entry}</b> • TP: <b>${it.tp}</b> • SL: <b>${it.sl}</b></li> : null}
      </ul>

      {bnLink ? (
        <a className="inline-block mt-3 text-sm text-blue-600 hover:underline" href={bnLink} target="_blank" rel="noreferrer">
          Open on Binance
        </a>
      ) : null}
    </div>
  );
}
