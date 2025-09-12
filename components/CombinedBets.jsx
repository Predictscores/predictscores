// components/CombinedBets.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";
import SignalCard from "./SignalCard";

const TZ = "Europe/Belgrade";

/* ===================== slot & date ===================== */
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
function ymdInTZ(d = new Date(), tz = TZ) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(d)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
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

/* ---------- HT-FT pretty helper ---------- */
const MAP_T = { "1":"Home", "2":"Away", "x":"Draw", "d":"Draw", "h":"Home", "a":"Away" };
function htftPrettyFrom(hay, code) {
  const s = String(hay || "").toLowerCase();

  // explicit code like 1-1, 1/x, h/a ...
  const codeStr = String(code || "").toLowerCase();
  let m = codeStr.match(/([12xdh])\s*[-/]\s*([12xdh])/);
  if (m) {
    const A = MAP_T[m[1]] || (m[1]==="x"||m[1]==="d"?"Draw":null);
    const B = MAP_T[m[2]] || (m[2]==="x"||m[2]==="d"?"Draw":null);
    if (A && B) return `${A}-${B}`;
  }

  // Home/Home, Away-Draw, H/H, A/D ...
  m = s.match(/\b(home|away|draw|1|2|x|d|h|a)\s*[-/]\s*(home|away|draw|1|2|x|d|h|a)\b/);
  if (m) {
    const A = MAP_T[m[1]] || (m[1]==="x"||m[1]==="d"?"Draw":null) || (m[1]==="home"?"Home":m[1]==="away"?"Away":"Draw");
    const B = MAP_T[m[2]] || (m[2]==="x"||m[2]==="d"?"Draw":null) || (m[2]==="home"?"Home":m[2]==="away"?"Away":"Draw");
    return `${A}-${B}`;
  }

  // compact hh/ha/ad ...
  m = s.match(/\b(hh|ha|hd|ah|aa|ad|dh|da|dd)\b/);
  if (m) {
    const pair = m[1];
    const A = MAP_T[pair[0]];
    const B = MAP_T[pair[1]] || (pair[1]==="d"?"Draw":null);
    if (A && B) return `${A}-${B}`;
  }

  // text like "home home" / "away draw"
  m = s.match(/\b(home|away|draw)\s+(home|away|draw)\b/);
  if (m) return `${m[1][0].toUpperCase()+m[1].slice(1)}-${m[2][0].toUpperCase()+m[2].slice(1)}`;

  // nothing reliable
  return null;
}

/* ---------- bet normalizer (sa pretty selekcijama za BTTS/OU25/HTFT) ---------- */
function normalizeBet(it) {
  const league =
    it?.league_name || it?.league?.name || it?.league || it?.competition || "";
  const date = parseKickoff(it);

  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);

  const rawMarket = it?.market_label || it?.market || "1X2";
  const market = normMarket(rawMarket);

  const baseSel =
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

  // --- Pretty selection for specials ---
  const hay = [
    it?.selection_label, it?.pick, it?.selection, it?.market_label, it?.market_pick, it?.label
  ].filter(Boolean).join(" ").toLowerCase();

  let selPretty = baseSel;
  if (market === "BTTS") {
    if (/\b(yes|gg)\b/.test(hay) || /both\s+teams\s+to\s+score/.test(hay)) selPretty = "Yes";
    else if (/\b(no|ng)\b/.test(hay)) selPretty = "No";
  } else if (market === "O/U 2.5") {
    if (/\bover\b/.test(hay)) selPretty = "Over 2.5";
    else if (/\bunder\b/.test(hay)) selPretty = "Under 2.5";
  } else if (market === "HT-FT") {
    selPretty =
      htftPrettyFrom(hay, it?.pick_code || it?.selection_code || it?.code) ||
      selPretty;
  }

  return {
    id:
      it?.fixture_id ?? it?.fixture?.id ?? `${home}-${away}-${Date.parse(date || new Date())}`,
    league, date, home, away, market,
    sel: baseSel,
    sel_pretty: selPretty,
    odds, conf, explain: it?.explain,
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
  if (v >= 75) return <span className="text-green-400">●</span>;
  if (v >= 50) return <span className="text-sky-400">●</span>;
  return <span className="text-amber-400">●</span>;
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
        {bet.market ? " → " : ""}
        {bet.sel_pretty || bet.sel || "—"}
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

/* ---------- Ticket card (parlay) ---------- */
function product(arr) { return arr.reduce((a, x) => (Number.isFinite(x) ? a * x : a), 1); }
function prettySelFor(b, title) {
  if (b?.sel_pretty) return b.sel_pretty;
  const m = String(title || b?.market || "").toUpperCase();
  const s = String(b?.sel || "").toLowerCase();

  if (m === "BTTS") {
    if (/\byes\b/.test(s) || /\bgg\b/.test(s)) return "Yes";
    if (/\bno\b/.test(s) || /\bng\b/.test(s)) return "No";
    return "—";
  }
  if (m === "O/U 2.5") {
    if (/over/.test(s)) return "Over 2.5";
    if (/under/.test(s)) return "Under 2.5";
    return "—";
  }
  if (m === "HT-FT") {
    const hay = [b?.sel, b?.selection_label, b?.pick, b?.label].filter(Boolean).join(" ");
    const fromHay = htftPrettyFrom(hay, b?.pick_code || b?.selection_code || b?.code);
    return fromHay || (s ? s[0].toUpperCase()+s.slice(1) : "—");
  }
  return b?.sel || "—";
}
function TicketCard({ title, legs }) {
  const legsWithOdds = Array.isArray(legs) ? legs.filter((l) => Number(l?.odds)) : [];
  const total = legsWithOdds.length ? product(legsWithOdds.map((l) => Number(l.odds))) : null;

  return (
    <div className="p-4 rounded-xl bg-[#1a1e33] border border-white/5">
      <div className="flex items-center justify-between">
        <div className="text-slate-200 font-semibold">{title}</div>
        <MarketBadge market={title} />
      </div>

      {!legs?.length ? (
        <div className="text-slate-400 text-sm mt-2">Nema parova u ovom slotu.</div>
      ) : (
        <>
          <ul className="text-sm text-slate-300 mt-2 space-y-1.5">
            {legs.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="font-medium">{l.home}</span>{" "}
                  <span className="text-slate-400">vs</span>{" "}
                  <span className="font-medium">{l.away}</span>{" "}
                  <span className="text-slate-400">({prettySelFor(l, title)})</span>
                </span>
                <span className="shrink-0 text-slate-200">
                  {Number(l?.odds) ? Number(l.odds).toFixed(2) : "—"}
                </span>
              </li>
            ))}
          </ul>

          {/* separator iste “boje kao timovi” (svetlo siva/škriljac) */}
          <div className="mt-3 border-t border-slate-300/30"></div>

          <div className="pt-3 flex items-center justify-between text-sm">
            <span className="text-slate-400">Ukupno ({legsWithOdds.length} para)</span>
            <span className="text-slate-100 font-semibold">
              {total ? total.toFixed(2) : "—"}
            </span>
          </div>
        </>
      )}
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

/** Zamrzni tikete po (ymd,slot) – čitamo iz value-bets-locked i držimo u localStorage */
function useFrozenTickets() {
  const [state, setState] = useState({ btts: [], ou25: [], htft: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const slot = currentSlot(TZ);
  const ymd = ymdInTZ(new Date(), TZ);
  const LS_KEY = `tickets:v3:${ymd}:${slot}`;

  async function load() {
    try {
      setLoading(true); setErr(null);

      const j = await safeJson(`/api/value-bets-locked?slot=${slot}&slim=1`);
      const t = j && typeof j === "object" && j.tickets && typeof j.tickets === "object" ? j.tickets : null;

      const norm = (raw) => ({
        btts: (raw?.btts || []).map(normalizeBet),
        ou25: (raw?.ou25 || []).map(normalizeBet),
        htft: (raw?.htft || []).map(normalizeBet),
      });

      if (t && (t.btts?.length || t.ou25?.length || t.htft?.length)) {
        const payload = { ...norm(t), meta: { ymd: j?.ymd || ymd, slot: j?.slot || slot } };
        try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); } catch {}
        setState(payload);
      } else {
        const s = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
        if (s) {
          try {
            const parsed = JSON.parse(s);
            setState({
              btts: (parsed?.btts || []).map(normalizeBet),
              ou25: (parsed?.ou25 || []).map(normalizeBet),
              htft: (parsed?.htft || []).map(normalizeBet),
            });
          } catch { setState({ btts: [], ou25: [], htft: [] }); }
        } else {
          setState({ btts: [], ou25: [], htft: [] });
        }
      }
    } catch (e) {
      setErr(String(e?.message || e)); setState({ btts: [], ou25: [], htft: [] });
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [slot, ymd]);
  return { tickets: state, loading, err, reload: load };
}

/* ===================== Football tab ===================== */
function FootballBody({ list, tickets }) {
  const [tab, setTab] = useState("ko"); // ko | conf | hist

  const oneX2All = useMemo(() => list.filter(x => String(x.market).toUpperCase() === "1X2"), [list]);

  const koLeft = useMemo(
    () => [...oneX2All].sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15)),
    [oneX2All]
  );
  const confLeft = useMemo(() => [...oneX2All].sort((a, b) => b.conf - a.conf), [oneX2All]);

  const left = tab === "ko" ? koLeft : confLeft;

  const btts = tickets?.btts || [];
  const ou25 = tickets?.ou25 || [];
  const htft = tickets?.htft || [];

  return (
    <div className="space-y-4">
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

            {/* Specials (45%) – iz zamrznutih tiketa */}
            <section className="md:basis-[45%] md:min-w-0">
              <div className="text-slate-200 font-semibold mb-2">Specials — BTTS / HT-FT / O/U 2.5</div>
              <div className="grid grid-cols-1 gap-3">
                <TicketCard title="BTTS"   legs={btts} />
                <TicketCard title="O/U 2.5" legs={ou25} />
                <TicketCard title="HT-FT"  legs={htft} />
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===================== Combined & Crypto ===================== */
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
  const { tickets, loading: tLoading, err: tErr } = useFrozenTickets();

  // Combined prikazuje SAMO 1X2 top3
  const top3Football = useMemo(
    () => [...fb.list]
      .filter((x) => String(x.market).toUpperCase() === "1X2")
      .sort((a, b) => b.conf - a.conf)
      .slice(0, 3),
    [fb.list]
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

      {tab === "Combined" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <CombinedBody footballTop3={top3Football} cryptoTop3={[]} />)}
      {tab === "Football" && (fb.loading || tLoading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : tErr ? <div className="text-red-400 text-sm">Greška (tickets): {tErr}</div> : <FootballBody list={fb.list} tickets={tickets} />)}
      {tab === "Crypto" && <CryptoBody list={[]} />}
    </div>
  );
}
