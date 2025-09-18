// components/HistoryPanel.js
"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * HistoryPanel (always two columns)
 * - Left: Football history (unchanged behavior; list for last N days)
 * - Right: Crypto summary (14d ROI) + Crypto history for a specific day (ymd) or today's date
 *
 * Props:
 *   - days: number (default 14)   -> football lookback
 *   - ymd:  string (YYYY-MM-DD)   -> crypto day; if omitted, uses today in TZ
 */

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

const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

function pushIfValidYmd(list, value) {
  if (isValidYmd(value) && !list.includes(value)) {
    list.push(value);
  }
}

function deriveLatestHistoryYmd(body, items = []) {
  const ymds = [];
  if (body && typeof body === "object") {
    pushIfValidYmd(ymds, body.latestYmd);
    pushIfValidYmd(ymds, body.latest_ymd);
    pushIfValidYmd(ymds, body.ymd);
    if (Array.isArray(body.queried_days)) {
      for (const y of body.queried_days) {
        pushIfValidYmd(ymds, y);
      }
    }
  }
  if (Array.isArray(items)) {
    for (const it of items) {
      pushIfValidYmd(ymds, it?.ymd);
    }
  }
  return ymds.length ? ymds[0] : null;
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

const SLOT_HOUR_HINT = {
  late: 4,
  am: 11,
  pm: 17,
};

function normalizeSlot(raw) {
  if (!raw) return null;
  const txt = String(raw).trim().toLowerCase();
  if (!txt) return null;
  if (["am", "pm", "late"].includes(txt)) return txt;
  if (txt === "morning") return "am";
  if (txt === "afternoon") return "pm";
  if (txt === "early") return "late";
  return null;
}

function extractSlot(it) {
  if (!it || typeof it !== "object") return null;
  const candidates = [
    it.slot,
    it.slot_key,
    it.slotKey,
    it.slot_name,
    it.slotName,
    it.history_slot,
    it.meta?.slot,
    it.meta?.slot_key,
    it.meta?.slotName,
  ];
  for (const cand of candidates) {
    const slot = normalizeSlot(cand);
    if (slot) return slot;
  }
  return null;
}

function parseYmdCandidate(value) {
  if (isValidYmd(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isValidYmd(trimmed)) return trimmed;
    if (trimmed.length >= 10) {
      const firstTen = trimmed.slice(0, 10);
      if (isValidYmd(firstTen)) return firstTen;
    }
  }
  return null;
}

function extractYmd(it) {
  if (!it || typeof it !== "object") return null;
  const candidates = [
    it.ymd,
    it.day,
    it.date,
    it.date_ymd,
    it.meta?.ymd,
    it.meta?.date,
    it.fixture?.ymd,
  ];
  for (const cand of candidates) {
    const y = parseYmdCandidate(cand);
    if (y) return y;
  }
  return null;
}

function coerceEpochMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value > 1e12) return value;
    if (value > 1e9) return Math.floor(value * 1000);
    if (value > 1e6) return Math.floor(value * 1000);
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      if (Math.abs(num) > 1e12) return num;
      if (Math.abs(num) > 1e9) return Math.floor(num * 1000);
      if (Math.abs(num) > 1e6) return Math.floor(num * 1000);
      if (num !== 0) return Math.floor(num * 1000);
      return 0;
    }
    let normalized = trimmed.replace(/\s+/, "T");
    if (!normalized.includes("T")) {
      normalized = `${normalized}T00:00:00`;
    }
    const withZone = /[z+-]\d\d:?\d\d$/i.test(normalized) ? normalized : `${normalized}Z`;
    const parsed = Date.parse(withZone);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object") {
    try {
      if (typeof value.toISOString === "function") {
        const parsed = Date.parse(value.toISOString());
        return Number.isFinite(parsed) ? parsed : null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function deriveYmdSlotTimestamp(it) {
  const ymd = extractYmd(it);
  if (!ymd) return null;
  const base = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  const slot = extractSlot(it);
  const hourHint = SLOT_HOUR_HINT[slot] ?? 0;
  return base + hourHint * 60 * 60 * 1000;
}

function deriveRecencyTimestamp(it) {
  const kickoff = getKickoff(it);
  const kickoffMs = coerceEpochMs(kickoff);
  if (kickoffMs != null) return kickoffMs;

  const fallbackCandidates = [
    it?.timestamp,
    it?.ts,
    it?.created_at,
    it?.updated_at,
    it?.snapshot_at,
    it?.fixture?.timestamp,
    it?.fixture?.ts,
  ];
  for (const cand of fallbackCandidates) {
    const parsed = coerceEpochMs(cand);
    if (parsed != null) return parsed;
  }

  return deriveYmdSlotTimestamp(it);
}

export function sortAndLimitHistoryItems(rawItems, topLimit) {
  if (!Array.isArray(rawItems)) return [];
  const decorated = rawItems.map((item, index) => ({
    item,
    index,
    ts: deriveRecencyTimestamp(item),
  }));

  decorated.sort((a, b) => {
    const ta = Number.isFinite(a.ts) ? a.ts : -Infinity;
    const tb = Number.isFinite(b.ts) ? b.ts : -Infinity;
    if (tb !== ta) {
      return tb - ta;
    }
    return a.index - b.index;
  });

  const sorted = decorated.map((entry) => entry.item);
  if (typeof topLimit === "number" && topLimit > 0) {
    return sorted.slice(0, topLimit);
  }
  return sorted;
}

export default function HistoryPanel({ days = 14, ymd, top }) {
  const topLimit = useMemo(() => {
    const n = Number(top);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }, [top]);

  const [rawItems, setRawItems] = useState([]);
  const [items, setItems] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [historyInfo, setHistoryInfo] = useState({
    ok: null,
    latestYmd: null,
    roi: null,
    fallbackRoi: null,
  });
  const [roiFallbackRequested, setRoiFallbackRequested] = useState(false);
  const dayYmd = useMemo(() => (isValidYmd(ymd) ? ymd : ymdInTZ(new Date())), [ymd]);

  // --- Football history fetch (existing behavior) ---
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setRoiFallbackRequested(false);
    setHistoryInfo({ ok: null, latestYmd: null, roi: null, fallbackRoi: null });
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
        const normalized = Array.isArray(arr) ? arr : [];
        if (!ac.signal.aborted) {
          setRawItems(normalized);
          setTotalCount(normalized.length);
          setErr(null);
          const latestYmd = deriveLatestHistoryYmd(body, normalized);
          const roi = body && typeof body === "object" && body.roi && typeof body.roi === "object"
            ? body.roi
            : null;
          const ok = body && typeof body === "object" ? body.ok !== false : null;
          setHistoryInfo({
            ok,
            latestYmd,
            roi,
            fallbackRoi: null,
          });
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          setErr(String(e?.message || e));
          setRawItems([]);
          setTotalCount(0);
          setHistoryInfo({ ok: false, latestYmd: null, roi: null, fallbackRoi: null });
        }
      } finally {
        if (!ac.signal.aborted) {
          setLoading(false);
        }
      }
    })();
    return () => ac.abort();
  }, [days]);

  useEffect(() => {
    if (Array.isArray(rawItems)) {
      setItems(sortAndLimitHistoryItems(rawItems, topLimit));
    } else {
      setItems([]);
    }
  }, [rawItems, topLimit]);

  // ROI fallback for the latest available football day (kv fallback)
  useEffect(() => {
    if (loading || roiFallbackRequested) {
      return;
    }

    const preferredYmd = historyInfo?.latestYmd;
    const targetYmd = isValidYmd(preferredYmd)
      ? preferredYmd
      : (isValidYmd(dayYmd) ? dayYmd : null);
    if (!targetYmd) return;

    const ac = new AbortController();
    setRoiFallbackRequested(true);

    (async () => {
      try {
        const href = `/api/history-roi?ymd=${encodeURIComponent(targetYmd)}`;
        const r = await fetch(href, { cache: "no-store", signal: ac.signal });
        const j = await r.json().catch(() => null);
        if (!ac.signal.aborted) {
          setHistoryInfo((prev) => ({
            ...prev,
            fallbackRoi: j || { ok: false },
          }));
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          setHistoryInfo((prev) => ({
            ...prev,
            fallbackRoi: { ok: false, error: String(e?.message || e) },
          }));
        }
      }
    })();

    return () => ac.abort();
  }, [dayYmd, historyInfo.latestYmd, loading, roiFallbackRequested]);

  // --- Crypto (right column) ---
  const [cryptoData, setCryptoData] = useState(null);
  const [cryptoStats, setCryptoStats] = useState(null); // 14d ROI summary

  // Daily items for the chosen day
  useEffect(() => {
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

  // 14-day summary (ROI/winrate) — computed on read
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/crypto-stats?days=14`, { cache: "no-store", signal: ac.signal });
        const j = await r.json().catch(() => null);
        setCryptoStats(j || { ok: false });
      } catch {
        setCryptoStats({ ok: false });
      }
    })();
    return () => ac.abort();
  }, []);

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

      {!loading && !err && topLimit && totalCount > items.length && items.length > 0 && (
        <div className="text-xs opacity-60 py-1">
          Showing top {items.length} of {totalCount} entries.
        </div>
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
          const ymdItem = it?.ymd || (k ? ymdInTZ(k) : null);

          return (
            <div key={id} className="py-3">
              <div className="flex items-baseline justify-between">
                <div className="font-medium">{title}</div>
                <div className="text-xs opacity-70">{ymdItem || ""}</div>
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

  // Always two columns: left football, right crypto
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="min-w-0">{FootballList}</div>
      <div className="min-w-0">
        <section>
          <h3 className="font-semibold">Crypto — {dayYmd}</h3>

          {/* 14d ROI summary */}
          {cryptoStats?.ok ? (
            <div className="text-sm opacity-80 mb-3">
              14d decided: {cryptoStats.decided ?? 0}
              {" · "}win-rate: {cryptoStats.win_rate_pct ?? "—"}%
              {" · "}avg RR: {typeof cryptoStats.avg_rr === "number" ? cryptoStats.avg_rr.toFixed(3) : "—"}
              {" · "}median RR: {cryptoStats.median_rr ?? "—"}
            </div>
          ) : (
            <div className="text-sm opacity-60 mb-3">—</div>
          )}

          {/* Per-day items */}
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
