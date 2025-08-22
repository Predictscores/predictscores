// components/FootballBets.jsx
"use client";

import { useEffect, useMemo, useState } from "react";

/* ===================== VALUE BETS (LOCKED) ===================== */
function useLockedValueBets() {
  const [items, setItems] = useState([]);
  const [loading,   setLoading] = useState(true);
  const [error,     setError]   = useState(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);

      const r = await fetch("/api/value-bets-locked", { cache: "no-store" });
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error("value-bets-locked non-JSON");

      const js = await r.json();
      // podrži oba formata: {items: []} i {value_bets: []}
      const arr = Array.isArray(js?.items)
        ? js.items
        : Array.isArray(js?.value_bets)
        ? js.value_bets
        : [];
      setItems(arr || []);
    } catch (e) {
      setError(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // 60s
    return () => clearInterval(id);
  }, []);

  return { items, loading, error };
}

/* ===================== HISTORY (14d) ===================== */
function useHistory(days = 14) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function j(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function load() {
    setLoading(true);
    const tries = [
      `/api/history?days=${days}`,
      "/api/history",
      "/api/history-locked",
    ];
    let data = null;
    for (const u of tries) {
      data = await j(u);
      if (data) break;
    }
    const arr =
      (Array.isArray(data?.items) && data.items) ||
      (Array.isArray(data?.history) && data.history) ||
      [];
    setRows(arr);
    setLoading(false);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60 * 60 * 1000); // 60 min
    return () => clearInterval(id);
  }, [days]);

  return { rows, loading };
}

/* ===================== HELPERS ===================== */
function parseKO(p) {
  const iso =
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.time?.starting_at?.date_time ||
    null;
  if (!iso) return null;
  const s = iso.includes("T") ? iso : iso.replace(" ", "T");
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function pct(x) {
  if (!Number.isFinite(x)) return null;
  const v = x > 1 ? x : x * 100;
  return Math.round(v * 10) / 10;
}
function impliedFromOdds(odds) {
  const o = Number(odds);
  return o > 0 ? 100 / o : null;
}
function oneLineExplain(p) {
  const summary = typeof p?.explain?.summary === "string" ? p.explain.summary.trim() : "";
  if (summary) return `Zašto: ${summary}`;

  const text = typeof p?.explain?.text === "string" ? p.explain.text.trim() : "";
  if (text) return `Zašto: ${text.split("\n")[0]}`;

  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  if (bullets.length) return `Zašto: ${String(bullets[0]).trim()}`;

  const mp = pct(p?.model_prob);
  const ip = pct(p?.implied_prob ?? impliedFromOdds(p?.market_odds));
  const ev = pct(p?.ev);
  const bookAll = Number.isFinite(p?.bookmakers_count) ? p.bookmakers_count : null;
  const bookTr  = Number.isFinite(p?.bookmakers_count_trusted) ? p.bookmakers_count_trusted : null;
  const parts = [];
  if (mp != null && ip != null) parts.push(`Model ${mp}% vs ${ip}%`);
  if (ev != null) parts.push(`EV ${ev}%`);
  if (bookAll != null) parts.push(`Bookies ${bookAll}${bookTr!=null?` (trusted ${bookTr})`:""}`);
  return parts.length ? `Zašto: ${parts.join(" · ")}` : "";
}

/* ---- group for side panel ---- */
function bucketLabel(p) {
  const m = String(p?.market_label || p?.market || "").toUpperCase();
  if (m.includes("BTTS")) return "BTTS";
  if (m.includes("OU") || m.includes("OVER") || m.includes("UNDER")) return "OU 2.5";
  if (m.includes("HT-FT") || m.includes("HTFT")) return "HT-FT";
  return "1X2";
}
function groupTop(items) {
  const groups = { "BTTS": [], "OU 2.5": [], "HT-FT": [], "1X2": [] };
  for (const p of items || []) groups[bucketLabel(p)].push(p);
  const sorter = (a, b) =>
    (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0) ||
    (b?.ev ?? 0) - (a?.ev ?? 0);
  for (const k of Object.keys(groups)) {
    groups[k].sort(sorter);
    groups[k] = groups[k].slice(0, 3);
  }
  return groups;
}

/* ===================== UI: SHARED PIECES ===================== */
function ConfBadge({ conf }) {
  const lvl = conf >= 75 ? "High" : conf >= 50 ? "Moderate" : "Low";
  const dot =
    conf >= 75 ? "bg-emerald-400" : conf >= 50 ? "bg-sky-400" : "bg-amber-400";
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
      {lvl}
    </span>
  );
}

function Card({ p }) {
  const league = p?.league?.name || p?.league_name || "";
  const ko = p?.datetime_local?.starting_at?.date_time || p?.ko || "";
  const home = p?.teams?.home?.name || p?.teams?.home || p?.home || "";
  const away = p?.teams?.away?.name || p?.teams?.away || p?.away || "";
  const market = p?.market_label || p?.market || "";
  const sel = p?.selection || "";
  const price = p?.market_odds ?? p?.odds ?? p?.price;
  const conf = p?.confidence_pct ?? p?.confidence ?? 0;

  return (
    <div className="rounded-2xl p-4 shadow bg-[#131722] border border-[#252b3b]">
      <div className="flex items-center justify-between text-xs opacity-80 mb-1">
        <div>{league} • {ko}</div>
        <ConfBadge conf={conf} />
      </div>

      <div className="text-lg font-semibold mb-1">
        {home} vs {away}
      </div>

      <div className="text-sm mb-2">
        {market}: <b>{sel}</b> {price ? <span>({price})</span> : null}
      </div>

      <div className="text-sm opacity-90 mb-3">{oneLineExplain(p)}</div>

      <div className="text-xs opacity-80 mb-1">Confidence</div>
      <div className="h-2 rounded bg-slate-700">
        <div
          className="h-2 rounded bg-sky-400"
          style={{ width: `${Math.max(0, Math.min(100, conf))}%` }}
        />
      </div>
    </div>
  );
}

function TabsInline({ active, onChange }) {
  const Btn = (k, label) => (
    <button
      key={k}
      onClick={() => onChange(k)}
      className={`px-3 py-1.5 rounded-full text-sm border ${
        active === k
          ? "bg-white text-black border-white"
          : "border-neutral-700 text-neutral-300"
      }`}
      type="button"
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-2 mb-3">
      {Btn("kick", "Kick-Off")}
      {Btn("conf", "Confidence")}
      {Btn("hist", "History")}
    </div>
  );
}

function SidePanelTopLeagues({ items }) {
  const G = useMemo(() => groupTop(items), [items]);
  const Section = ({ title, want = 3, arr }) => (
    <div className="mb-5">
      <div className="font-semibold mb-2">{title} ({want})</div>
      {arr.length === 0 && (
        <div className="text-sm opacity-70">Nema dovoljno kandidata.</div>
      )}
      <div className="space-y-3">
        {arr.map((p, i) => (
          <div key={`${title}-${p?.fixture_id ?? i}`} className="rounded-xl p-3 bg-[#131722] border border-[#252b3b]">
            <div className="text-xs opacity-70 mb-1">
              {(p?.league?.name || "")} • {(p?.datetime_local?.starting_at?.date_time || "")}
            </div>
            <div className="text-sm font-medium mb-0.5">
              {(p?.teams?.home?.name || p?.teams?.home || p?.home || "")} vs {(p?.teams?.away?.name || p?.teams?.away || p?.away || "")}
            </div>
            <div className="text-sm mb-1">
              {(p?.market_label || p?.market || "")}: <b>{p?.selection || ""}</b>
            </div>
            <div className="text-xs opacity-80">
              {oneLineExplain(p).replace(/^Zašto:\s*/,'')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="rounded-2xl p-4 shadow bg-[#131722] border border-[#252b3b]">
      <div className="text-lg font-semibold mb-3">Top lige</div>
      <Section title="BTTS"  arr={G["BTTS"]} />
      <Section title="OU 2.5" arr={G["OU 2.5"]} />
      <Section title="HT-FT" arr={G["HT-FT"]} />
      <Section title="1X2"   arr={G["1X2"]} />
    </div>
  );
}

/* ===================== HISTORY RENDER ===================== */
function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function computeStats(rows, days) {
  const now = Date.now();
  const ms = days * 86400000;
  const take = (dt) => (dt ? new Date(dt).getTime() : null);
  const inRange = (r) => {
    const dt =
      r?.datetime_local?.starting_at?.date_time ||
      r?.datetime_local?.date_time ||
      r?.ko ||
      r?.date;
    const t = take(dt);
    return Number.isFinite(t) ? now - t <= ms : true; // ako nema datum, ne odbacuj
  };
  const subset = (rows || []).filter(inRange);

  let n = 0, wins = 0, profit = 0, stake = 0;
  for (const r of subset) {
    const odds = Number(r?.odds ?? r?.market_odds ?? r?.price);
    const won =
      r?.won === true ||
      String(r?.outcome || r?.status || r?.result || "").toLowerCase().startsWith("win");
    if (!Number.isFinite(odds)) continue;
    n += 1;
    stake += 1;
    profit += won ? (odds - 1) : -1;
    if (won) wins += 1;
  }
  const hit = n ? wins / n : null;
  const roi = stake ? profit / stake : null;
  return { hit, roi, n };
}

function HistoryHeader({ rows }) {
  const s7  = computeStats(rows, 7);
  const s14 = computeStats(rows, 14);
  const roiFmt = (x) =>
    x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  return (
    <div className="rounded-2xl p-4 bg-[#151a2a] border border-[#252b3b] mb-3">
      <div className="font-semibold">History — učinak</div>
      <div className="mt-2 flex flex-wrap gap-6 text-sm opacity-90">
        <span>7d: <b>{fmtPct(s7.hit)}</b> • ROI <b>{roiFmt(s7.roi)}</b> (N={s7.n})</span>
        <span>14d: <b>{fmtPct(s14.hit)}</b> • ROI <b>{roiFmt(s14.roi)}</b> (N={s14.n})</span>
      </div>
    </div>
  );
}

function OutcomeBadge({ won }) {
  if (won == null) return null;
  return won ? (
    <span className="px-3 py-1 rounded-full text-sm bg-emerald-600/80 text-white">✅ Pogodak</span>
  ) : (
    <span className="px-3 py-1 rounded-full text-sm bg-rose-600/80 text-white">❌ Promašaj</span>
  );
}

function HistoryRow({ h }) {
  const league = h?.league?.name || h?.league || "";
  const home   = h?.teams?.home?.name || h?.home || "";
  const away   = h?.teams?.away?.name || h?.away || "";
  const dt     = h?.datetime_local?.starting_at?.date_time || h?.ko || h?.date || "";
  const slot   = h?.slot || h?.time_slot || h?.window || "";
  const mk     = h?.market_label || h?.market || "";
  const sel    = h?.selection || "";
  const odds   = h?.odds ?? h?.market_odds ?? h?.price;
  const tipTxt = mk ? `${mk}: ${sel}` : sel;

  const won =
    h?.won === true ||
    String(h?.outcome || h?.status || h?.result || "").toLowerCase().startsWith("win");

  const score =
    h?.tr || h?.score || h?.result_score || h?.ft || "";

  return (
    <div className="rounded-2xl bg-[#151a2a] border border-[#252b3b] px-4 py-3 flex items-center justify-between">
      <div className="min-w-0">
        <div className="text-base font-semibold truncate">
          {home} vs {away}
        </div>
        <div className="text-xs opacity-80">{league} • {dt} • Slot: {slot || "—"}</div>
      </div>

      <div className="flex items-center gap-4 pl-4 shrink-0">
        <div className="text-sm whitespace-nowrap">
          <b>{tipTxt}</b>{odds ? ` (${Number(odds).toFixed(2)})` : ""}
          {score ? <div className="text-xs opacity-80 text-right">TR: {String(score)}</div> : null}
        </div>
        <OutcomeBadge won={won} />
      </div>
    </div>
  );
}

/* ===================== MAIN ===================== */
export default function FootballBets({ limit, layout = "full" }) {
  const { items, loading, error } = useLockedValueBets();
  const { rows: historyRows, loading: historyLoading } = useHistory(14);
  const [tab, setTab] = useState("kick");

  const byKickoff = useMemo(() => {
    const list = Array.isArray(items) ? [...items] : [];
    list.sort((a, b) => (parseKO(a) ?? 9e15) - (parseKO(b) ?? 9e15));
    return list;
  }, [items]);

  const byConfidence = useMemo(() => {
    const list = Array.isArray(items) ? [...items] : [];
    list.sort(
      (a, b) =>
        (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0) ||
        (b?.ev ?? 0) - (a?.ev ?? 0)
    );
    return list;
  }, [items]);

  /* -------- Combined: samo top N kartica (bez tabova, bez side panela) -------- */
  if (layout === "combined") {
    const combinedTop =
      typeof limit === "number" ? byConfidence.slice(0, limit) : byConfidence.slice(0, 3);
    if (loading) return <div className="opacity-70">Učitavanje…</div>;
    if (error)   return <div className="text-red-400">Greška: {String(error)}</div>;
    return (
      <div className="grid md:grid-cols-2 gap-4">
        {combinedTop.map((p, i) => (
          <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
        ))}
      </div>
    );
  }

  /* -------- Football tab (1:1 kao na screenshotu) -------- */
  if (loading) return <div className="opacity-70">Učitavanje…</div>;
  if (error)   return <div className="text-red-400">Greška: {String(error)}</div>;

  const listKick =
    typeof limit === "number" ? byKickoff.slice(0, limit) : byKickoff;
  const listConf =
    typeof limit === "number" ? byConfidence.slice(0, limit) : byConfidence;

  return (
    <div className="space-y-4">
      <TabsInline active={tab} onChange={setTab} />

      {!items?.length && tab !== "hist" && (
        <div className="opacity-70">Nema dostupnih predloga.</div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        {/* leve 2 kolone */}
        <div className="lg:col-span-2 space-y-4">
          {tab === "kick" && (
            <div className="grid md:grid-cols-2 gap-4">
              {listKick.map((p, i) => (
                <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
              ))}
            </div>
          )}

          {tab === "conf" && (
            <div className="grid md:grid-cols-2 gap-4">
              {listConf.map((p, i) => (
                <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
              ))}
            </div>
          )}

          {tab === "hist" && (
            <div>
              <HistoryHeader rows={historyRows} />
              {historyLoading && (
                <div className="opacity-70">Učitavanje…</div>
              )}
              {!historyLoading && historyRows?.length > 0 && (
                <div className="space-y-3">
                  {historyRows.map((h, i) => (
                    <HistoryRow key={i} h={h} />
                  ))}
                </div>
              )}
              {!historyLoading && (!historyRows || historyRows.length === 0) && (
                <div className="opacity-70">Nema istorije za prikaz.</div>
              )}
            </div>
          )}
        </div>

        {/* desna kolona: Top lige */}
        <div className="lg:col-span-1">
          <SidePanelTopLeagues items={items} />
        </div>
      </div>
    </div>
  );
}
