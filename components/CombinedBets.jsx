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
    it?.fixture?.date ||
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
function toDec(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/* ---------- market & selection normalizers ---------- */
function normMarket(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("btts") || s.includes("both teams to score")) return "BTTS";
  if (s.includes("ht/ft") || s.includes("ht-ft") || s.includes("half time/full time")) return "HT-FT";
  if (s.includes("over 2.5") || s.includes("under 2.5") || s.includes("ou2.5") || s.includes("o/u 2.5") || s.includes("totals")) return "O/U 2.5";
  if (s === "1x2" || s.includes("match result") || s.includes("full time result")) return "1X2";
  return (s || "").trim() ? s.toUpperCase() : "1X2";
}
function mapHTFT(code) {
  // "1/1","1/X","1/2","X/1","X/X","X/2","2/1","2/X","2/2"
  const m = String(code || "").trim().toUpperCase();
  const to = (c) => (c === "1" ? "Home" : c === "2" ? "Away" : c === "X" ? "Draw" : c);
  const [a, b] = m.split("/");
  if (!a || !b) return null;
  return `${to(a)}–${to(b)}`;
}
function normalizeSelection(it, marketHint) {
  const market = (marketHint && String(marketHint)) || normMarket(it?.market_label || it?.market || "");
  const rawSel =
    it?.selection_label ??
    it?.selection?.label ??
    it?.pick_label ??
    it?.selection ??
    it?.pick ??
    null;

  if (rawSel) {
    const s = String(rawSel).trim();
    if (market === "BTTS") {
      if (/^y(es)?$/i.test(s)) return "Yes";
      if (/^n(o)?$/i.test(s)) return "No";
      if (/both.*yes/i.test(s)) return "Yes";
      if (/both.*no/i.test(s)) return "No";
    }
    if (market === "O/U 2.5") {
      if (/^over/i.test(s)) return "Over 2.5";
      if (/^under/i.test(s)) return "Under 2.5";
    }
    if (market === "HT-FT") {
      // some providers label like "Home/Home" or "1/1"
      if (/^[12X]\/[12X]$/.test(s.toUpperCase())) return mapHTFT(s);
      if (/home|away|draw/i.test(s)) return s.replace("/", "–");
    }
    // fallback: return the label as-is
    return s;
  }

  // derive from codes if label missing
  const pc = String(it?.pick_code || "").trim();
  if (market === "BTTS") {
    if (/yes/i.test(pc)) return "Yes";
    if (/no/i.test(pc)) return "No";
  }
  if (market === "O/U 2.5") {
    if (/over/i.test(pc)) return "Over 2.5";
    if (/under/i.test(pc)) return "Under 2.5";
  }
  if (market === "HT-FT" && /^[12X]\/[12X]$/.test(pc.toUpperCase())) {
    return mapHTFT(pc);
  }

  // 1X2 only: translate pick_code 1/X/2 to Home/Draw/Away
  if (market === "1X2") {
    if (pc === "1") return "Home";
    if (pc === "X") return "Draw";
    if (pc === "2") return "Away";
  }

  return "—";
}

/* ---------- bet normalizer ---------- */
function normalizeBet(it, marketOverride) {
  const league =
    it?.league_name || it?.league?.name || it?.league || it?.competition || "";
  const date = parseKickoff(it);

  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);

  const rawMarket = marketOverride || it?.market_label || it?.market || "1X2";
  const market = normMarket(rawMarket);

  const sel = normalizeSelection(it, market);

  let odds =
    typeof it?.odds === "object" && it?.odds
      ? toDec(it.odds.price)
      : toDec(it?.market_odds ?? it?.odds);
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
      `${home}-${away}-${Date.parse(date || new Date())}-${market}-${sel}`,
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

/* ---------- Football card ---------- */
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
        {bet.market ? " → " : ""}{bet.sel || "—"}
        {bet.odds ? (
          <span className="text-slate-300"> ({Number(bet.odds).toFixed(2)})</span>
        ) : (
          <span className="text-slate-500"> (—)</span>
        )}
      </div>

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

/* ---------- Ticket group card (BTTS / O/U 2.5 / HT-FT) ---------- */
function computeTotalOdds(list) {
  const nums = list.map((x) => Number(x.odds)).filter((v) => Number.isFinite(v) && v > 1);
  if (!nums.length) return null;
  const prod = nums.reduce((a, b) => a * b, 1);
  return prod;
}
function TicketGroupCard({ title, items, sortBy = "ko" }) {
  const sorted = useMemo(() => {
    const arr = [...(items || [])];
    if (sortBy === "conf") arr.sort((a, b) => (b.conf || 0) - (a.conf || 0));
    else arr.sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15));
    return arr;
  }, [items, sortBy]);

  const total = computeTotalOdds(sorted);

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="flex items-center justify-between">
        <div className="text-slate-200 font-semibold">{title}</div>
        {typeof total === "number" ? (
          <div className="text-slate-200 font-semibold">
            Total: {total.toFixed(2)}
          </div>
        ) : null}
      </div>

      <div className="mt-3 space-y-3">
        {sorted.map((b) => (
          <div key={b.id} className="rounded-lg border border-slate-700/40 p-3">
            <div className="text-xs text-slate-400 flex items-center justify-between">
              <span>{b.league}</span>
              <span>{fmtLocal(b.date)}</span>
            </div>
            <div className="font-semibold mt-0.5">
              {b.home} <span className="text-slate-400">vs</span> {b.away}
            </div>
            <div className="text-sm text-slate-200 mt-0.5">
              <MarketBadge market={b.market} />{" "}
              <span className="font-semibold">{b.sel}</span>
              {b.odds ? <span className="text-slate-300"> ({Number(b.odds).toFixed(2)})</span> : <span className="text-slate-500"> (—)</span>}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">Conf: {Math.round(b.conf || 0)}%</div>
          </div>
        ))}
      </div>

      {/* separator line same tone as team names area */}
      <div className="h-px bg-slate-600 my-3" />

      {typeof total === "number" ? (
        <div className="text-right text-slate-200 font-semibold">Ukupna kvota: {total.toFixed(2)}</div>
      ) : (
        <div className="text-right text-slate-500 text-sm">Ukupna kvota: —</div>
      )}
    </div>
  );
}

/* ===================== data hooks ===================== */
function useValueBetsFeed() {
  const [state, setState] = useState({
    items: [], // 1X2 normalized
    tickets: { btts: [], ou25: [], htft: [] }, // normalized
    err: null,
    loading: true,
  });

  async function load() {
    try {
      setState((s) => ({ ...s, loading: true, err: null }));
      const slot = currentSlot(TZ);
      const n = desiredCountForSlot(slot, TZ);
      const j = await safeJson(`/api/value-bets-locked?slot=${slot}&n=${n}`);
      const srcItems = Array.isArray(j?.items) ? j.items : Array.isArray(j?.football) ? j.football : Array.isArray(j) ? j : [];
      const items = srcItems.map((it) => normalizeBet(it)); // may include mixed markets, we’ll filter later

      const tb = j?.tickets || {};
      const bttsRaw = Array.isArray(tb.btts) ? tb.btts : [];
      const ou25Raw = Array.isArray(tb.ou25) ? tb.ou25 : [];
      const htftRaw = Array.isArray(tb.htft) ? tb.htft : [];

      const btts = bttsRaw.map((it) => normalizeBet(it, "BTTS"));
      const ou25 = ou25Raw.map((it) => normalizeBet(it, "O/U 2.5"));
      const htft = htftRaw.map((it) => normalizeBet(it, "HT-FT"));

      setState({
        items,
        tickets: { btts, ou25, htft },
        err: null,
        loading: false,
      });
    } catch (e) {
      setState({ items: [], tickets: { btts: [], ou25: [], htft: [] }, err: String(e?.message || e), loading: false });
    }
  }

  useEffect(() => { load(); }, []);
  return { ...state, reload: load };
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

/* ===================== Football tab ===================== */
function FootballBody({ list, tickets }) {
  const [tab, setTab] = useState("ko"); // ko | conf | hist

  // Only 1X2 on left (as requested)
  const oneX2All = useMemo(() => list.filter(x => String(x.market).toUpperCase() === "1X2"), [list]);

  // Specials come exclusively from tickets object (not from items)
  const ticketsBTTS = tickets?.btts || [];
  const ticketsOU25 = tickets?.ou25 || [];
  const ticketsHTFT = tickets?.htft || [];

  const koLeft = useMemo(
    () => [...oneX2All].sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15)),
    [oneX2All]
  );
  const confLeft = useMemo(() => [...oneX2All].sort((a, b) => b.conf - a.conf), [oneX2All]);

  // for right column we pass the sort mode to TicketGroupCard
  const rightSort = tab === "conf" ? "conf" : "ko";

  return (
    <div className="space-y-4">
      {/* Inner tabs */}
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

          {/* 55/45 layout on md+ */}
          <div className="flex flex-col md:flex-row md:gap-4 gap-4">
            {/* 1X2 (55%) */}
            <section className="md:basis-[55%] md:min-w-0">
              <div className="text-slate-200 font-semibold mb-2">Match Odds (1X2)</div>
              {! (tab === "ko" ? koLeft : confLeft).length ? (
                <div className="text-slate-400 text-sm">Nema 1X2 ponuda.</div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {(tab === "ko" ? koLeft : confLeft).map((b) => (<FootballCard key={b.id} bet={b} />))}
                </div>
              )}
            </section>

            {/* Tickets (45%) */}
            <section className="md:basis-[45%] md:min-w-0">
              <div className="text-slate-200 font-semibold mb-2">Tickets — BTTS / O/U 2.5 / HT-FT</div>
              {!ticketsBTTS.length && !ticketsOU25.length && !ticketsHTFT.length ? (
                <div className="text-slate-400 text-sm">Nema specijalnih tiketa.</div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {ticketsBTTS.length ? <TicketGroupCard title="BTTS Ticket" items={ticketsBTTS} sortBy={rightSort} /> : null}
                  {ticketsOU25.length ? <TicketGroupCard title="O/U 2.5 Ticket" items={ticketsOU25} sortBy={rightSort} /> : null}
                  {ticketsHTFT.length ? <TicketGroupCard title="HT-FT Ticket" items={ticketsHTFT} sortBy={rightSort} /> : null}
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
  const fb = useValueBetsFeed();
  const crypto = useCryptoTop3();
  const top3Football = useMemo(
    () => [...fb.items.filter(x => x.market === "1X2")].sort((a, b) => b.conf - a.conf).slice(0, 3),
    [fb.items]
  );

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
      {tab === "Football" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <FootballBody list={fb.items} tickets={fb.tickets} />)}
      {tab === "Crypto" && (crypto.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : crypto.err ? <div className="text-red-400 text-sm">Greška: {crypto.err}</div> : <CryptoBody list={crypto.items} />)}
    </div>
  );
}
