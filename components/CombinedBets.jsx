// components/CombinedBets.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";
import SignalCard from "./SignalCard";

const TZ = "Europe/Belgrade";

/* ===================== slot ===================== */
function currentSlot(tz = TZ) {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(new Date())
  );
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}
function isWeekend(tz = TZ) {
  const wd = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: tz,
  }).format(new Date());
  return wd === "Sat" || wd === "Sun";
}
function desiredCountForSlot(slot, tz = TZ) {
  if (slot === "late") return 6;
  return isWeekend(tz) ? 20 : 15;
}

/* ===================== helpers ===================== */
async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok: false, error: "non-JSON", raw: t }; }
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
function parseKickoff(it) {
  if (it?.kickoff_utc) return new Date(it.kickoff_utc);
  const iso =
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.datetime_local?.date_time ||
    it?.time?.starting_at?.date_time ||
    null;
  if (!iso) return null;
  const s = iso.includes("T") ? iso : iso.replace(" ", "T");
  return new Date(s + (/[Z+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
}
function fmtLocal(date, tz = TZ) {
  if (!date) return "—";
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  return f.format(date);
}
function teamName(side) {
  if (!side) return "—";
  if (typeof side === "string") return side || "—";
  if (typeof side === "object") return side.name || side.team || "—";
  return "—";
}

/* ---------- market normalizer ---------- */
function normMarket(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("btts") || s.includes("both teams to score")) return "BTTS";
  if (s.includes("ht/ft") || s.includes("ht-ft") || s.includes("half time/full time")) return "HT-FT";
  if (s.includes("over 2.5") || s.includes("under 2.5") || s.includes("ou2.5") || s.includes("o/u 2.5")) return "O/U 2.5";
  if (s === "1x2" || s.includes("match result") || s.includes("full time result")) return "1X2";
  return (s || "").trim() ? s.toUpperCase() : "1X2";
}

/* ---------- bet normalizer ---------- */
function normalizeBet(it) {
  const league =
    it?.league_name || it?.league?.name || it?.league || it?.competition || "";
  const date = parseKickoff(it);

  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);

  const rawMarket = it?.market_label || it?.market || "1X2";
  const market = normMarket(rawMarket);

  const sel =
    it?.selection_label ||
    it?.pick ||
    it?.selection ||
    (it?.pick_code === "1" ? "Home" : it?.pick_code === "2" ? "Away" : it?.pick_code === "X" ? "Draw" : "");

  let odds =
    typeof it?.odds === "object" && it?.odds
      ? Number(it.odds.price)
      : Number(it?.market_odds ?? it?.odds);
  odds = Number.isFinite(odds) ? odds : null;

  let conf = Number(
    it?.confidence_pct ??
      (typeof it?.model_prob === "number"
        ? it.model_prob <= 1 ? it.model_prob * 100 : it.model_prob
        : 0)
  );
  conf = Number.isFinite(conf) ? Math.max(0, Math.min(100, conf)) : 0;

  return {
    id:
      it?.fixture_id ??
      it?.fixture?.id ??
      `${home}-${away}-${Date.parse(date || new Date())}`,
    league, date, home, away, market, sel, odds, conf, explain: it?.explain,
  };
}

/* ---------- UI helpers ---------- */
function ConfidenceBar({ pct }) {
  const v = Math.max(0, Math.min(100, Number(pct || 0)));
  return (
    <div className="h-2 w-full rounded bg-[#2a2f4a] overflow-hidden">
      <div className="h-2 rounded bg-[#4f6cf7]" style={{ width: `${v}%` }} />
    </div>
  );
}
function confIcon(pct) {
  const v = Number(pct || 0);
  if (v >= 90) return "🔥";
  if (v >= 75) return <span className="text-green-400">●</span>;   // High
  if (v >= 50) return <span className="text-sky-400">●</span>;     // Moderate
  return <span className="text-amber-400">●</span>;                // Low
}
function WhyLine({ explain }) {
  const bullets = Array.isArray(explain?.bullets) ? explain.bullets : [];
  const text = bullets.filter((b) => !/^forma:|^h2h/i.test((b || "").trim())).slice(0, 2).join(" · ");
  const forma = (() => {
    const x = bullets.find((b) => /^forma:/i.test((b || "").trim()));
    return x ? x.replace(/^forma:\s*/i, "").trim() : "";
  })();
  const h2h = (() => {
    const x = bullets.find((b) => /^h2h/i.test((b || "").trim()));
    return x ? x.replace(/^h2h:\s*/i, "").trim() : "";
  })();
  if (!text && !forma && !h2h) return null;
  return (
    <div className="text-xs text-slate-400">
      {text}
      {forma ? (text ? " · " : "") + `Forma: ${forma}` : ""}
      {h2h ? ((text || forma) ? " · " : "") + `H2H: ${h2h}` : ""}
    </div>
  );
}
function MarketBadge({ market }) {
  const m = String(market || "").toUpperCase();
  const map = {
    "1X2": "bg-cyan-500/15 text-cyan-200 border-cyan-500/30",
    "BTTS": "bg-amber-500/15 text-amber-200 border-amber-500/30",
    "HT-FT": "bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-500/30",
    "O/U 2.5": "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
  };
  const cls = map[m] || "bg-slate-500/15 text-slate-200 border-slate-500/30";
  return <span className={`px-2 py-0.5 rounded-md text-[11px] border ${cls}`}>{m}</span>;
}

/* ---------- Football card (ikonica pored % + 55/45 layout kasnije) ---------- */
function FootballCard({ bet }) {
  const confPct = Math.round(Number(bet.conf || 0));
  const icon = confIcon(confPct);

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <div>{bet.league} · {fmtLocal(bet.date)}</div>
        <div className="flex items-center gap-2"><MarketBadge market={bet.market} /></div>
      </div>

      <div className="font-semibold mt-1">
        {bet.home} <span className="text-slate-400">vs</span> {bet.away}
      </div>

      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{bet.market}</span>
        {bet.market ? " → " : ""}
        {bet.sel || "—"}
        {bet.odds ? (
          <span className="text-slate-300"> ({Number(bet.odds).toFixed(2)})</span>
        ) : (
          <span className="text-slate-500"> (—)</span>
        )}
      </div>

      {/* Confidence bar + ikonica pored % */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
          <span>Confidence</span>
          <span className="text-slate-200 font-medium flex items-center gap-1">
            {confPct}% {icon}
          </span>
        </div>
        <ConfidenceBar pct={confPct} />
      </div>

      {bet.explain ? <div className="mt-2"><WhyLine explain={bet.explain} /></div> : null}
    </div>
  );
}

/* ===================== data hooks ===================== */
function useFootballFeed() {
  const [list, setList] = useState([]); const [err, setErr] = useState(null); const [loading, setLoading] = useState(true);
  async function load() {
    try {
      setLoading(true); setErr(null);
      const slot = currentSlot(TZ); const n = desiredCountForSlot(slot, TZ);
      const j = await safeJson(`/api/value-bets-locked?slot=${slot}&n=${n}`);
      const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j?.football) ? j.football : Array.isArray(j) ? j : [];
      setList(arr.map(normalizeBet));
    } catch (e) { setErr(String(e?.message || e)); setList([]); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  return { list, err, loading, reload: load };
}
function useCryptoTop3() {
  const [items, setItems] = useState([]); const [err, setErr] = useState(null); const [loading, setLoading] = useState(true);
  async function load() {
    try {
      setLoading(true); setErr(null);
      const j = await safeJson(`/api/crypto`);
      const arr = Array.isArray(j?.items) ? j.items
        : Array.isArray(j?.predictions) ? j.predictions
        : Array.isArray(j?.data) ? j.data
        : Array.isArray(j?.list) ? j.list
        : Array.isArray(j?.results) ? j.results
        : Array.isArray(j?.signals) ? j.signals
        : Array.isArray(j?.crypto) ? j.crypto
        : Array.isArray(j) ? j : [];
      setItems(arr.slice(0, 3));
    } catch (e) { setErr(String(e?.message || e)); setItems([]); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  return { items, err, loading };
}

/* ===================== Football tab: 1X2 55% / Specials 45% ===================== */
function FootballBody({ list }) {
  const [tab, setTab] = useState("ko"); // ko | conf | hist
  const oneX2All = useMemo(() => list.filter(x => String(x.market).toUpperCase() === "1X2"), [list]);
  const specialsAll = useMemo(() => list.filter(x => {
    const m = String(x.market).toUpperCase();
    return m === "BTTS" || m === "HT-FT" || m === "O/U 2.5";
  }), [list]);

  const koLeft = useMemo(
    () => [...oneX2All].sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15)),
    [oneX2All]
  );
  const koRight = useMemo(
    () => [...specialsAll].sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15)),
    [specialsAll]
  );
  const confLeft = useMemo(() => [...oneX2All].sort((a, b) => b.conf - a.conf), [oneX2All]);
  const confRight = useMemo(() => [...specialsAll].sort((a, b) => b.conf - a.conf), [specialsAll]);

  const left = tab === "ko" ? koLeft : confLeft;
  const right = tab === "ko" ? koRight : confRight;

  return (
    <div className="space-y-4">
      {/* Unutrašnji tabovi */}
      <div className="flex items-center gap-2">
        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "ko" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} onClick={() => setTab("ko")} type="button">Kick-Off</button>
        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "conf" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} onClick={() => setTab("conf")} type="button">Confidence</button>
        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "hist" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} onClick={() => setTab("hist")} type="button">History</button>
      </div>

      {tab === "hist" ? (
        <HistoryPanel days={14} top={3} />
      ) : (
        <div className="rounded-2xl bg-[#15182a] p-4">
          <div className="text-base font-semibold text-white mb-3">{tab === "ko" ? "Kick-Off" : "Confidence"}</div>

          {/* 55/45 layout na md+: flex sa basis-[%] */}
          <div className="flex flex-col md:flex-row md:gap-4 gap-4">
            {/* 1X2 (55%) */}
            <section className="md:basis-[55%] md:min-w-0">
              <div className="text-slate-200 font-semibold mb-2">Match Odds (1X2)</div>
              {!left.length ? (
                <div className="text-slate-400 text-sm">Nema 1X2 ponuda.</div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {left.map((b) => (<FootballCard key={b.id} bet={b} />))}
                </div>
              )}
            </section>

            {/* Specials (45%) */}
            <section className="md:basis-[45%] md:min-w-0">
              <div className="text-slate-200 font-semibold mb-2">Specials — BTTS / HT-FT / O/U 2.5</div>
              {!right.length ? (
                <div className="text-slate-400 text-sm">Nema specijalnih tiketa.</div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {right.map((b) => (<FootballCard key={b.id} bet={b} />))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===================== Crypto sekcija (ostaje) ===================== */
function CombinedBody({ footballTop3, cryptoTop3 }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[#15182a] p-4">
        <div className="text-base font-semibold text-white mb-3">Football — Top 3</div>
        {!footballTop3.length ? (
          <div className="text-slate-400 text-sm">Trenutno nema predloga.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {footballTop3.map((b) => (<FootballCard key={b.id} bet={b} />))}
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-[#15182a] p-4">
        <div className="text-base font-semibold text-white mb-3">Crypto — Top 3</div>
        {!cryptoTop3.length ? (
          <div className="text-slate-400 text-sm">Trenutno nema kripto signala.</div>
        ) : (
          <div className="space-y-3">
            {cryptoTop3.map((c, i) => (<SignalCard key={c?.symbol || i} data={c} type="crypto" />))}
          </div>
        )}
      </div>
    </div>
  );
}
function CryptoBody({ list }) {
  return (
    <div className="rounded-2xl bg-[#15182a] p-4">
      <div className="text-base font-semibold text-white mb-3">Crypto — Top 3</div>
      {!list.length ? (
        <div className="text-slate-400 text-sm">Trenutno nema kripto signala.</div>
      ) : (
        <div className="space-y-3">
          {list.map((c, i) => (<SignalCard key={c?.symbol || i} data={c} type="crypto" />))}
        </div>
      )}
    </div>
  );
}

/* ===================== main ===================== */
export default function CombinedBets() {
  const [tab, setTab] = useState("Combined");
  const fb = useFootballFeed();
  const crypto = useCryptoTop3();
  const top3Football = useMemo(() => [...fb.list].sort((a, b) => b.conf - a.conf).slice(0, 3), [fb.list]);

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-2">
        {["Combined", "Football", "Crypto"].map((name) => (
          <button key={name} onClick={() => setTab(name)} className={`px-3 py-1.5 rounded-lg text-sm ${tab === name ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} type="button">
            {name}
          </button>
        ))}
      </div>

      {tab === "Combined" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <CombinedBody footballTop3={top3Football} cryptoTop3={crypto.items} />)}
      {tab === "Football" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <FootballBody list={fb.list} />)}
      {tab === "Crypto" && (crypto.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : crypto.err ? <div className="text-red-400 text-sm">Greška: {crypto.err}</div> : <CryptoBody list={crypto.items} />)}
    </div>
  );
}
