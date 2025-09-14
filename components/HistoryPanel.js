// components/HistoryPanel.js
"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * HistoryPanel
 * - Left: Football history (unchanged behavior)
 * - Right: (optional) Crypto history for the same day, behind feature flag
 *
 * To enable the right column, set:
 *   NEXT_PUBLIC_FEATURE_CRYPTO_HISTORY=1
 * If the flag is not "1", this component renders exactly like before (single column).
 */
const FEATURE_CRYPTO = process.env.NEXT_PUBLIC_FEATURE_CRYPTO_HISTORY === "1";
const TZ = (process.env.NEXT_PUBLIC_TZ_DISPLAY || "Europe/Belgrade").trim() || "Europe/Belgrade";

function ymdInTZ(date, tz = TZ) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(date);
  }
}

function J(s) {
  try { return JSON.parse(String(s || "")); } catch { return null; }
}

function coalesceArray(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.history)) return x.history;
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.list)) return x.list;
  }
  return [];
}

// --- Small helpers to format football items robustly (works with several shapes) ---
function getFixtureId(it) {
  return it?.fixture_id || it?.fixture?.id || it?.id || `${it?.league?.id || "?"}-${it?.kickoff || it?.kickoff_utc || it?.ts || Math.random()}`;
}
function getTeamsLabel(it) {
  const a = it?.teams?.home?.name || it?.home?.name || it?.home_name || it?.home || it?.homeTeam || null;
  const b = it?.teams?.away?.name || it?.away?.name || it?.away_name || it?.away || it?.awayTeam || null;
  if (a || b) return `${a || "—"} vs ${b || "—"}`;
  return it?.title || it?.name || "Match";
}
function getKickoff(it) {
  const iso = it?.kickoff_utc || it?.kickoff || it?.fixture?.date || it?.datetime_local?.starting_at?.date_time || it?.time?.starting_at?.date_time;
  return iso ? new Date(iso) : null;
}
function getMarket(it) {
  const m = it?.market_key || it?.market || null;
  return m ? String(m) : null;
}
function getPick(it) {
  return it?.pick || it?.selection_label || it?.bet_pick || null;
}
function getPrice(it) {
  const p = it?.price_snapshot ?? it?.price ?? it?.odds?.price ?? it?.decimal ?? it?.odd;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}
function getResult(it) {
  // Supports both history settled items and combined snapshots without result
  return it?.result || (typeof it?.won !== "undefined" ? (it.won ? "win" : "loss") : null);
}

export default function HistoryPanel({ days = 14 }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  // --- Football history fetch (existing behavior) ---
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const href = `/api/history?days=${encodeURIComponent(days)}`;
        const r = await fetch(href, { cache: "no-store", signal: ac.signal });
        let body;
        try {
          const ct = (r.headers.get("content-type") || "").toLowerCase();
          body = ct.includes("application/json")
            ? await r.json()
            : await r.text().then((t) => J(t));
        } catch {
          body = null;
        }
        const arr = coalesceArray(body) || coalesceArray(body?.history) || [];
        setItems(arr);
        setErr(null);
      } catch (e) {
        setErr(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [days]);

  // --- Crypto (optional right column) ---
  const dayYmd = useMemo(() => ymdInTZ(new Date()), []);
  const [cryptoData, setCryptoData] = useState(null);

  useEffect(() => {
    if (!FEATURE_CRYPTO) return;
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/crypto-history-day?ymd=${dayYmd}`, { cache: "no-store", signal: ac.signal });
        const j = await r.json().catch(() => null);
        setCryptoData(j || { ok: false, items: [] });
      } catch {
        setCryptoData({ ok: false, items: [] });
      }
    })();
    return () => ac.abort();
  }, [dayYmd]);

  // --- Render helpers ---
  const FootballList = (
    <div>
      <h3 className="font-semibold">History — last {days} day(s)</h3>

      {loading && (
        <div className="text-sm opacity-70 py-2">Loading…</div>
      )}
      {err && (
        <div className="text-sm text-red-400 py-2">Error: {err}</div>
      )}

      {!loading && !err && (!items || items.length === 0) && (
        <div className="text-sm opacity-70 py-2">No history for the selected period.</div>
      )}

      <div className="divide-y">
        {items && items.map((it, idx) => {
          const id = getFixtureId(it) + "__" + idx;
          const title = getTeamsLabel(it);
          const k = getKickoff(it);
          const market = getMarket(it);
          const pick = getPick(it);
          const price = getPrice(it);
          const result = getResult(it);
          const ymd = it?.ymd || (k ? ymdInTZ(k) : null);

          return (
            <div key={id} className="py-3">
              <div className="flex items-baseline justify-between">
                <div className="font-medium">{title}</div>
                <div className="text-xs opacity-70">{ymd || ""}</div>
              </div>
              <div className="text-slate-300">
                {market}
                {market ? " → " : ""}
                {pick}
                {Number.isFinite(price) ? ` (${price.toFixed(2)})` : ""}
                {result ? ` · ${result}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (!FEATURE_CRYPTO) {
    // Exact same single-column behavior as before
    return FootballList;
  }

  // Two columns: left football, right crypto
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="min-w-0">{FootballList}</div>
      <div className="min-w-0">
        <section>
          <h3 className="font-semibold">Crypto — {dayYmd}</h3>
          {cryptoData?.ok && Array.isArray(cryptoData.items) && cryptoData.items.length > 0 ? (
            <>
              <div className="text-sm opacity-80 mb-2">
                decided: {cryptoData.totals?.decided ?? 0}
                {" · "}win-rate: {cryptoData.totals?.win_rate_pct ?? "—"}%
                {" · "}avg RR: {typeof cryptoData.totals?.avg_rr === "number" ? cryptoData.totals.avg_rr.toFixed(3) : "—"}
                {" · "}median RR: {cryptoData.totals?.median_rr ?? "—"}
              </div>
              <ul className="divide-y">
                {cryptoData.items.map((it) => (
                  <li key={it.id} className="py-2">
                    <b>{it.symbol}</b>{" "}
                    <span className="opacity-70 text-xs">({it.exchange || "—"})</span>
                    {" · "}{it.side || "—"}{" · "}RR={it.rr ?? "—"}
                    {" → "}<b>{it.outcome || "pending"}</b>
                    {typeof it.realized_rr === "number" ? ` (realized ${it.realized_rr.toFixed(3)})` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="text-sm opacity-70">No crypto entries for this day.</div>
          )}
        </section>
      </div>
    </div>
  );
}
