// components/HistoryPanel.js
"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * HistoryPanel (always two columns)
 * - Left: Football history (Top-3 H2H snapshot for last N days)
 * - Right: Crypto summary (14d ROI) + Crypto history for a specific day (ymd) or today's date
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
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
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

const toNumberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const parsePercentish = (value) => {
  if (typeof value === "string") {
    const s = value.trim();
    if (s.endsWith("%")) {
      const n = Number(s.slice(0, -1));
      if (Number.isFinite(n)) return n / 100;
    }
  }
  return toNumberOrNull(value);
};
function normalizeRoi(obj) {
  if (!obj || typeof obj !== "object") return null;
  const played = toNumberOrNull(obj.played ?? obj.decided ?? obj.settled);
  const wins = toNumberOrNull(obj.wins ?? obj.win ?? obj.won);
  let profit = toNumberOrNull(obj.profit);
  const staked = toNumberOrNull(obj.staked ?? obj.played ?? obj.settled);
  const returned = toNumberOrNull(obj.returned);
  if (profit == null && staked != null && returned != null) profit = returned - staked;
  let roi = parsePercentish(obj.roi);
  if (roi == null && obj.roi_pct != null) roi = parsePercentish(obj.roi_pct);
  if (roi == null && obj.roi_percent != null) roi = parsePercentish(obj.roi_percent);
  if (roi == null && profit != null && staked) roi = staked !== 0 ? profit / staked : null;
  const avgOdds = toNumberOrNull(obj.avg_odds ?? obj.avgOdds ?? obj.average_odds);
  let winrate = parsePercentish(obj.winrate ?? obj.win_rate ?? obj.winRate);
  if (winrate == null && wins != null && played) winrate = played ? wins / played : null;

  const out = {
    played: played != null ? played : null,
    wins: wins != null ? wins : null,
    profit: profit != null ? profit : null,
    roi: roi != null ? roi : null,
    avg_odds: avgOdds != null ? avgOdds : null,
    winrate: winrate != null ? winrate : null,
  };
  if (typeof obj.source === "string" && obj.source) out.source = obj.source;

  const has = Object.values(out).some((v) => v != null);
  return has ? out : null;
}

const ROI_SOURCE_LABEL = {
  history: "KV snapshot",
  "history-roi": "history-roi fallback",
  computed: "computed from items",
  aggregate: "aggregate (range)",
};

const formatInteger = (value) => (Number.isFinite(value) ? value : "—");
const formatProfit = (value) =>
  Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}` : "—";
const formatRoi = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—");
const formatOdds = (value) => (Number.isFinite(value) ? value.toFixed(2) : "—");
const formatRange = (range) => {
  if (!range) return null;
  const latest = typeof range.latest === "string" ? range.latest : null;
  const earliest = typeof range.earliest === "string" ? range.earliest : null;
  if (latest && earliest) {
    if (latest === earliest) return latest;
    return `${earliest} → ${latest}`;
  }
  return latest || earliest || null;
};

export default function HistoryPanel({ days = 14, ymd }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const dayYmd = useMemo(() => (isValidYmd(ymd) ? ymd : ymdInTZ(new Date())), [ymd]);
  const [historyInfo, setHistoryInfo] = useState({ range: null, latestYmd: null, daysUsed: days });
  const [historyRoi, setHistoryRoi] = useState(null);
  const [roiFallbackRequested, setRoiFallbackRequested] = useState(false);

  const [cryptoData, setCryptoData] = useState(null);
  const [cryptoStats, setCryptoStats] = useState(null);

  // --- Football history fetch (Top-3 H2H snapshot) ---
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setHistoryRoi(null);
    setHistoryInfo({ range: null, latestYmd: null, daysUsed: days });
    setRoiFallbackRequested(false);
    (async () => {
      try {
        const href = `/api/history?days=${encodeURIComponent(days)}`;
        const r = await fetch(href, { cache: "no-store", signal: ac.signal });
        let body;
        try {
          const ct = (r.headers.get("content-type") || "").toLowerCase();
          body = ct.includes("application/json") ? await r.json() : await r.text().then((t) => J(t));
        } catch {
          body = null;
        }
        const arr = coalesceArray(body) || coalesceArray(body?.history) || [];
        setItems(arr);
        const roiCandidate = body?.roi ?? body;
        const normalizedRaw = normalizeRoi(roiCandidate);
        const normalizedRoi = normalizedRaw
          ? {
              ...normalizedRaw,
              ...(roiCandidate && typeof roiCandidate.source === "string"
                ? { source: roiCandidate.source }
                : {}),
            }
          : null;
        setHistoryRoi(normalizedRoi);

        const range = body?.range && (body.range.latest || body.range.earliest)
          ? body.range
          : body?.ymd && isValidYmd(body.ymd)
          ? { latest: body.ymd, earliest: body.ymd }
          : null;
        const serverDays = Number(body?.days);
        const daysUsed = Number.isFinite(serverDays) && serverDays > 0 ? serverDays : days;
        const latestFromRange =
          (range && range.latest && isValidYmd(range.latest) ? range.latest : null) ||
          (typeof body?.ymd === "string" && isValidYmd(body.ymd) ? body.ymd : null) ||
          (arr.find((it) => typeof it?.ymd === "string" && isValidYmd(it.ymd))?.ymd ?? null);
        setHistoryInfo({ range, latestYmd: latestFromRange, daysUsed });
        setErr(null);
      } catch (e) {
        setErr(String(e?.message || e));
        setItems([]);
        setHistoryRoi(null);
        setHistoryInfo({ range: null, latestYmd: null, daysUsed: days });
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [days]);

  // Fallback ROI fetch via /api/history-roi if API snapshot lacks ROI
  useEffect(() => {
    if (historyRoi || roiFallbackRequested) return;
    const fallbackYmd =
      (historyInfo?.latestYmd && isValidYmd(historyInfo.latestYmd) ? historyInfo.latestYmd : null) ||
      (isValidYmd(dayYmd) ? dayYmd : null);
    if (!fallbackYmd) return;
    const ac = new AbortController();
    setRoiFallbackRequested(true);
    (async () => {
      try {
        const r = await fetch(`/api/history-roi?ymd=${fallbackYmd}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        const j = await r.json().catch(() => null);
        if (j?.ok) {
          const normalized = normalizeRoi(j);
          if (normalized) {
            setHistoryRoi({ ...normalized, source: "history-roi" });
          }
        }
      } catch {
        /* noop */
      }
    })();
    return () => ac.abort();
  }, [historyRoi, roiFallbackRequested, historyInfo?.latestYmd, dayYmd]);

  // --- Crypto (right column) ---
  const dayForCrypto = useMemo(() => dayYmd, [dayYmd]);

  // Daily items for the chosen day
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/crypto-history-day?ymd=${dayForCrypto}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        const j = await r.json().catch(() => null);
        setCryptoData(j || { ok: false, items: [] });
      } catch {
        setCryptoData({ ok: false, items: [] });
      }
    })();
    return () => ac.abort();
  }, [dayForCrypto]);

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
  const historyRangeText = formatRange(historyInfo.range);
  const historyDaysLabel = historyInfo?.daysUsed ?? days;
  const detailsYmd =
    (historyInfo?.latestYmd && isValidYmd(historyInfo.latestYmd) ? historyInfo.latestYmd : null) ||
    (isValidYmd(dayYmd) ? dayYmd : null);
  const detailHref = detailsYmd ? `/api/history-roi?ymd=${detailsYmd}` : null;
  const profitClass = Number.isFinite(historyRoi?.profit)
    ? historyRoi.profit >= 0
      ? "text-emerald-400"
      : "text-rose-400"
    : "text-slate-100";
  const roiClass = Number.isFinite(historyRoi?.roi)
    ? historyRoi.roi >= 0
      ? "text-emerald-400"
      : "text-rose-400"
    : "text-slate-100";
  const roiSourceLabel = historyRoi?.source
    ? ROI_SOURCE_LABEL[historyRoi.source] || historyRoi.source
    : null;

  const HistorySummary = (
    <section className="mt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-300">Top-3 H2H ROI</p>
          <p className="text-[11px] text-slate-400">
            Performance snapshot for the pinned Top-3 H2H bets
          </p>
        </div>
        {detailHref ? (
          <a
            href={detailHref}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-sky-400 hover:text-sky-200 transition"
            title="Open detailed per-day ROI JSON"
          >
            history-roi details ↗
          </a>
        ) : null}
      </div>
      <div className="mt-3 rounded-xl border border-[#1f253f] bg-[#151a2d] p-3">
        {historyRoi ? (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-5">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Played</dt>
                <dd className="text-lg font-semibold text-white">{formatInteger(historyRoi.played)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Wins</dt>
                <dd className="text-lg font-semibold text-white">{formatInteger(historyRoi.wins)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Profit</dt>
                <dd className={`text-lg font-semibold ${profitClass}`}>{formatProfit(historyRoi.profit)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">ROI</dt>
                <dd className={`text-lg font-semibold ${roiClass}`}>{formatRoi(historyRoi.roi)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Avg odds</dt>
                <dd className="text-lg font-semibold text-white">{formatOdds(historyRoi.avg_odds)}</dd>
              </div>
            </dl>
            <div className="mt-3 space-y-1 text-[11px] text-slate-400">
              <div>
                {roiSourceLabel ? `${roiSourceLabel}` : "Derived from history records"}
                {historyDaysLabel ? ` · window: ${historyDaysLabel} day${historyDaysLabel === 1 ? "" : "s"}` : ""}
                {historyRangeText ? ` · ${historyRangeText}` : ""}
              </div>
              <div>ROI metrics refer strictly to the Top-3 H2H selections.</div>
            </div>
          </>
        ) : (
          <div className="text-sm text-slate-400">
            ROI metrics are not available for this Top-3 H2H window.
          </div>
        )}
      </div>
    </section>
  );

  const FootballList = (
    <div>
      <h3 className="font-semibold">History — last {historyDaysLabel} day(s)</h3>
      {HistorySummary}

      {loading && <div className="py-2 text-sm opacity-70">Loading…</div>}
      {err && <div className="py-2 text-sm text-red-400">Error: {err}</div>}

      {!loading && !err && (!items || items.length === 0) && (
        <div className="py-2 text-sm opacity-70">No history for the selected period.</div>
      )}

      <div className="divide-y">
        {items &&
          items.map((it, idx) => {
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
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="min-w-0">{FootballList}</div>
      <div className="min-w-0">
        <section>
          <h3 className="font-semibold">Crypto — {dayYmd}</h3>

          {/* 14d ROI summary */}
          {cryptoStats?.ok ? (
            <div className="mb-3 text-sm opacity-80">
              14d decided: {cryptoStats.decided ?? 0}
              {" · "}win-rate: {cryptoStats.win_rate_pct ?? "—"}%
              {" · "}avg RR: {typeof cryptoStats.avg_rr === "number" ? cryptoStats.avg_rr.toFixed(3) : "—"}
              {" · "}median RR: {cryptoStats.median_rr ?? "—"}
            </div>
          ) : (
            <div className="mb-3 text-sm opacity-60">—</div>
          )}

          {/* Per-day items */}
          {cryptoData?.ok && Array.isArray(cryptoData.items) && cryptoData.items.length > 0 ? (
            <>
              <div className="mb-2 text-sm opacity-80">
                decided: {cryptoData.totals?.decided ?? 0}
                {" · "}win-rate: {cryptoData.totals?.win_rate_pct ?? "—"}%
                {" · "}avg RR: {typeof cryptoData.totals?.avg_rr === "number" ? cryptoData.totals.avg_rr.toFixed(3) : "—"}
                {" · "}median RR: {cryptoData.totals?.median_rr ?? "—"}
              </div>
              <ul className="divide-y">
                {cryptoData.items.map((it) => (
                  <li key={it.id} className="py-2">
                    <b>{it.symbol}</b>{" "}
                    <span className="text-xs opacity-70">({it.exchange || "—"})</span>
                    {" · "}
                    {it.side || "—"}
                    {" · "}RR={it.rr ?? "—"}
                    {" → "}
                    <b>{it.outcome || "pending"}</b>
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

// --- Small helpers to format football items robustly (works with several shapes) ---
function getFixtureId(it) {
  return (
    it?.fixture_id ||
    it?.fixture?.id ||
    it?.id ||
    `${it?.league?.id || "?"}-${it?.kickoff || it?.kickoff_utc || it?.ts || Math.random()}`
  );
}
function getTeamsLabel(it) {
  const a =
    it?.teams?.home?.name ||
    it?.home?.name ||
    it?.home_name ||
    it?.home ||
    it?.homeTeam ||
    null;
  const b =
    it?.teams?.away?.name ||
    it?.away?.name ||
    it?.away_name ||
    it?.away ||
    it?.awayTeam ||
    null;
  if (a || b) return `${a || "—"} vs ${b || "—"}`;
  return it?.title || it?.name || "Match";
}
function getKickoff(it) {
  const iso =
    it?.kickoff_utc ||
    it?.kickoff ||
    it?.fixture?.date ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.time?.starting_at?.date_time;
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
  return it?.result || (typeof it?.won !== "undefined" ? (it.won ? "win" : "loss") : it?.outcome || null);
}
