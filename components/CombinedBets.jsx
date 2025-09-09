import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";
import TicketPanel from "./TicketPanel";

const TZ = "Europe/Belgrade";

/* ---------------- helpers ---------------- */

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

function toISO(x) {
  return (
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff ||
    null
  );
}

function fmtKickoff(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("sr-RS", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

function hasAnyTickets(t) {
  if (!t || typeof t !== "object") return false;
  const b = Array.isArray(t.btts) ? t.btts.length : 0;
  const o = Array.isArray(t.ou25) ? t.ou25.length : 0;
  const h = Array.isArray(t.htft) ? t.htft.length : 0;
  return (b + o + h) > 0;
}

function num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
function pct(x) {
  const v = num(x);
  return v == null ? null : Math.round(v * 100) / 100;
}
function fmt2(x) {
  const v = num(x);
  return v == null ? "—" : v.toFixed(2);
}

/* ---------------- football feed ---------------- */

function useFootballFeed() {
  const [items, setItems] = useState([]);
  const [tickets, setTickets] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const vb = await safeJson(`/api/value-bets-locked?slim=1`);
      if (!alive) return;
      if (vb?.ok) {
        setItems(Array.isArray(vb.items) ? vb.items : []);
        setTickets(vb?.tickets && typeof vb.tickets === "object" ? vb.tickets : {});
      } else {
        setItems([]);
        setTickets({});
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  return { items, tickets, loading };
}

/* ---------------- crypto feed ---------------- */

function useCryptoFeed() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const r = await safeJson(`/api/crypto`);
      if (!alive) return;
      if (r?.ok) {
        const arr = Array.isArray(r.signals) ? r.signals
                  : Array.isArray(r.items)   ? r.items
                  : Array.isArray(r.data)    ? r.data
                  : [];
        setSignals(arr);
      } else {
        setSignals([]);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  return { signals, loading };
}

/* ---------------- sparkline (SVG) ---------------- */

function toSparkSeries(s) {
  // ulaz: s.sparkline = [cena...], ili s.history = [{price|close|last}...]
  if (Array.isArray(s?.sparkline) && s.sparkline.length) {
    return s.sparkline.map(Number).filter(v => Number.isFinite(v));
  }
  if (Array.isArray(s?.history) && s.history.length) {
    return s.history
      .map(pt => num(pt?.price ?? pt?.close ?? pt?.last))
      .filter(v => v != null);
  }
  return [];
}

function SparklineSVG({ series, height = 84, color = "blue" }) {
  const w = 280; // virtuelna širina (responsive preko viewBox)
  const h = height;
  const n = series?.length || 0;
  if (!n) return <div className="h-20 rounded-xl bg-blue-900/20 border border-blue-300/10" />;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;

  const pts = series.map((v, i) => {
    const x = (i / (n - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const lastY = h - ((series[n - 1] - min) / span) * h;

  const palettes = {
    green: { stroke: "rgba(74,222,128,0.95)", fill: "rgba(74,222,128,0.15)" },   // LONG
    red:   { stroke: "rgba(248,113,113,0.95)", fill: "rgba(248,113,113,0.15)" }, // SHORT
    blue:  { stroke: "rgba(147,197,253,0.9)",  fill: "rgba(59,130,246,0.15)"  }  // neutral
  };
  const c = palettes[color] || palettes.blue;

  const fillPath = `M0,${h} L${pts} L${w},${h} Z`;

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={fillPath} fill={c.fill} />
      <polyline
        points={pts}
        fill="none"
        stroke={c.stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* tačka + labela na poslednjoj vrednosti */}
      <circle cx={w} cy={lastY} r="3" fill={c.stroke} />
      <g transform={`translate(${w - 4}, ${Math.max(16, Math.min(h - 16, lastY))})`}>
        <rect x="-60" y="-12" width="60" height="24" rx="6" fill="rgba(10,24,61,0.85)" stroke="rgba(147,197,253,0.25)" />
        <text x="-30" y="0" dominantBaseline="middle" textAnchor="middle" fontSize="10" fill="rgb(191,219,254)">
          {fmt2(series[n - 1])}
        </text>
      </g>
    </svg>
  );
}

/* ---------------- UI atoms (plava glass tema) ---------------- */

const pillBase   = "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs";
const pillLong   = `${pillBase} bg-green-500/10 border-green-400/30 text-green-200`;
const pillShort  = `${pillBase} bg-rose-500/10 border-rose-400/30 text-rose-200`;
const pillInfo   = `${pillBase} bg-blue-500/10 border-blue-400/30 text-blue-100`;
const tabBase    = "px-4 py-2 rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/40";
const tabActive  = "bg-blue-900/40 border-blue-300/30 text-blue-50 shadow-[0_0_0_1px_rgba(147,197,253,.2)_inset]";
const tabIdle    = "bg-blue-900/10 border-blue-300/20 text-blue-100 hover:bg-blue-900/20";

function Card({ children, className="" }) {
  return (
    <div className={`rounded-2xl p-4 bg-blue-900/25 backdrop-blur border border-blue-300/20 ring-1 ring-white/5 shadow-md transition-all hover:translate-y-[1px] hover:shadow-lg/40 ${className}`}>
      {children}
    </div>
  );
}
function SectionTitle({ children }) {
  return <div className="mb-2 text-sm opacity-80 text-blue-50">{children}</div>;
}
function Arrow({ dir }) {
  if (dir === "up") return <span className="ml-1 text-green-300">▲</span>;
  if (dir === "down") return <span className="ml-1 text-rose-300">▼</span>;
  return null;
}
function SkeletonCard() {
  return <div className="animate-pulse rounded-2xl h-28 bg-blue-900/20 border border-blue-300/10 ring-1 ring-white/5" />;
}

/* ---------------- Football items ---------------- */

function ItemCard({ it }) {
  const k = toISO(it);
  const conf = it?.confidence_pct ?? (it?.model_prob != null ? Math.round(it.model_prob * 100) : undefined);
  return (
    <Card>
      <div className="text-sm opacity-80 text-blue-100">{it.league_name} · {it.league_country}</div>
      <div className="mt-1 text-lg font-semibold text-blue-50">{it.home} — {it.away}</div>
      <div className="mt-1 text-sm opacity-90 text-blue-100">Kick-off: {fmtKickoff(k)}</div>
      <div className="mt-2 text-sm text-blue-50/90">
        <span className="opacity-80">Market:</span> <b>{it.market}</b> · <span className="opacity-80">Pick:</span> <b>{it.pick || it.selection_label}</b>
      </div>
      <div className="mt-1 text-sm text-blue-50/90">
        {conf != null ? (<><span className="opacity-80">Conf:</span> <b>{conf}%</b></>) : null}
        {it?.odds?.price ? <> · <span className="opacity-80">Odds:</span> <b>{it.odds.price}</b></> : null}
      </div>
    </Card>
  );
}

/* ---------------- Crypto cards ---------------- */

function normalizeSignal(s) {
  const symbol = s?.symbol || s?.pair || s?.ticker || "—";
  const sideRaw = (s?.signal || s?.side || s?.direction || "").toString().toUpperCase();
  const side = sideRaw.includes("LONG") || sideRaw.includes("BUY") ? "LONG"
             : sideRaw.includes("SHORT") || sideRaw.includes("SELL") ? "SHORT"
             : sideRaw || "—";

  const priceNow = num(s?.price ?? s?.last ?? s?.close);

  // entry/exit kandidati
  const entry = num(
    s?.entry ?? s?.entry_price ?? s?.entryPrice ?? s?.open ?? s?.buy_price ?? s?.buyPrice
  );
  const exit = num(
    s?.exit ?? s?.exit_price ?? s?.exitPrice ?? s?.target ?? s?.take_profit ?? s?.tp ?? s?.sell_price ?? s?.sellPrice
  );

  // očekivani % — direktan ili izveden iz entry/exit
  const expDirect = num(
    s?.expected_pct ?? s?.expectedChange ?? s?.exp_pct ?? s?.expChange ?? s?.expected
  );
  let expectedPct = expDirect;
  if (expectedPct == null && entry != null && exit != null && entry > 0) {
    expectedPct = (side === "SHORT")
      ? ((entry - exit) / entry) * 100
      : ((exit - entry) / entry) * 100;
  }

  const ch24 = num(s?.change_24h ?? s?.changePct ?? s?.change ?? s?.pct_24h);
  const confidence = num(s?.confidence ?? s?.score ?? s?.strength);
  const series = toSparkSeries(s);

  return { symbol, side, priceNow, entry, exit, expectedPct, ch24, confidence, series };
}

function CryptoCard({ s }) {
  const N = normalizeSignal(s);
  const pos = N.side === "LONG";
  const neg = N.side === "SHORT";
  const tagClass = pos ? pillLong : neg ? pillShort : pillInfo;
  const sparkColor = pos ? "green" : neg ? "red" : "blue";

  return (
    <Card>
      <div className="text-sm opacity-80 text-blue-100">Crypto</div>

      {/* header */}
      <div className="mt-1 flex items-center justify-between">
        <div className="text-lg font-semibold text-blue-50">{N.symbol}</div>
        <span className={`${tagClass}`}>
          {N.side}
          <Arrow dir={pos ? "up" : neg ? "down" : null} />
        </span>
      </div>

      {/* metrics row */}
      <div className="mt-2 text-sm text-blue-100/90 flex flex-wrap gap-x-4 gap-y-1">
        <div>Price: <b className="tabular-nums">{N.priceNow != null ? fmt2(N.priceNow) : "—"}</b></div>
        <div>Entry: <b className="tabular-nums">{N.entry != null ? fmt2(N.entry) : "—"}</b></div>
        <div>Exit: <b className="tabular-nums">{N.exit != null ? fmt2(N.exit) : "—"}</b></div>
        <div>
          Exp:{" "}
          {N.expectedPct != null ? (
            <b className={`tabular-nums ${N.expectedPct >= 0 ? "text-green-200" : "text-rose-200"}`}>
              {pct(N.expectedPct)}%
            </b>
          ) : <b>—</b>}
        </div>
      </div>

      {/* extra row */}
      <div className="mt-1 text-sm text-blue-100/80 flex flex-wrap gap-x-4 gap-y-1">
        {N.ch24 != null ? (
          <div>24h: <b className={`tabular-nums ${N.ch24 >= 0 ? "text-green-200" : "text-rose-200"}`}>{pct(N.ch24)}%</b></div>
        ) : null}
        {N.confidence != null ? <div>Confidence: <b className="tabular-nums">{Math.round(N.confidence)}%</b></div> : null}
      </div>

      {/* chart */}
      <div className="mt-3">
        <SparklineSVG series={N.series} color={sparkColor} />
      </div>
    </Card>
  );
}

/* ---------------- COMBINED tab ---------------- */

function CombinedBody() {
  const { items, loading: fLoading } = useFootballFeed();
  const { signals, loading: cLoading } = useCryptoFeed();

  const topFootball = useMemo(() => [...items].slice(0, 3), [items]);   // Top 3 singla
  const topCrypto   = useMemo(() => [...signals].slice(0, 3), [signals]); // Top 3 kripto

  return (
    <div className="space-y-8">
      {/* Football gore (grid na desktopu, horizontal snap na mobilu) */}
      <div>
        <SectionTitle>Football · Top 3 (singl)</SectionTitle>
        {fLoading ? (
          <div className="grid md:grid-cols-3 gap-4">
            <SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
        ) : topFootball.length ? (
          <>
            <div className="md:hidden -mx-4 px-4 overflow-x-auto snap-x snap-mandatory">
              <div className="flex gap-3">
                {topFootball.map((it, i) => (
                  <div key={i} className="min-w-[85%] snap-center">
                    <ItemCard it={it} />
                  </div>
                ))}
              </div>
            </div>
            <div className="hidden md:grid md:grid-cols-3 gap-4">
              {topFootball.map((it, i) => <ItemCard key={i} it={it} />)}
            </div>
          </>
        ) : (
          <Card><div className="text-sm opacity-80 text-blue-100">Nema 1X2 singlova za prikaz.</div></Card>
        )}
      </div>

      {/* Crypto dole */}
      <div>
        <SectionTitle>Crypto · Top 3</SectionTitle>
        {cLoading ? (
          <div className="grid md:grid-cols-3 gap-4">
            <SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
        ) : topCrypto.length ? (
          <div className="grid md:grid-cols-3 gap-4">
            {topCrypto.map((s, i) => <CryptoCard key={i} s={s} />)}
          </div>
        ) : (
          <Card><div className="text-sm opacity-80 text-blue-100">Nema crypto signala za prikaz.</div></Card>
        )}
      </div>
    </div>
  );
}

/* ---------------- FOOTBALL tab (sa pod-tabovima) ---------------- */

function FootballBody({ subTab /* "kickoff" | "confidence" | "history" */ }) {
  const { items, tickets, loading } = useFootballFeed();

  const byKickoff = useMemo(() => {
    return [...items].sort((a, b) => {
      const ka = new Date(toISO(a)).getTime() || 0;
      const kb = new Date(toISO(b)).getTime() || 0;
      return ka - kb;
    });
  }, [items]);

  const byConfidence = useMemo(() => {
    return [...items].sort((a, b) => {
      const ca = a?.confidence_pct ?? Math.round((a?.model_prob ?? 0) * 100);
      const cb = b?.confidence_pct ?? Math.round((b?.model_prob ?? 0) * 100);
      return cb - ca;
    });
  }, [items]);

  const leftEmptyMsg = (
    <Card><div className="text-sm opacity-90 text-blue-100">Nema 1X2 singlova za prikaz (items[] je prazan).</div></Card>
  );

  const showTickets = subTab === "kickoff" || subTab === "confidence";

  if (subTab === "history") {
    // HISTORY pod-tab: BEZ tiketa, full width
    return (
      <div className="space-y-4">
        <SectionTitle>History (14d)</SectionTitle>
        <HistoryPanel />
      </div>
    );
  }

  const list = subTab === "kickoff" ? byKickoff : byConfidence;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Levo: 1X2 lista */}
      <div className={showTickets ? "lg:col-span-2" : "lg:col-span-3"}>
        <SectionTitle>{subTab === "kickoff" ? "Kick-Off" : "Confidence"}</SectionTitle>
        {loading ? (
          <div className="grid md:grid-cols-2 gap-4">
            <SkeletonCard /><SkeletonCard />
          </div>
        ) : (list.length ? (
          <div className="grid md:grid-cols-2 gap-4">
            {list.map((it, i) => <ItemCard key={i} it={it} />)}
          </div>
        ) : leftEmptyMsg)}
      </div>

      {/* Desno: Tickets (samo Kick-Off i Confidence) */}
      {showTickets ? (
        <div className="lg:col-span-1">
          <aside aria-label="Tickets">
            {hasAnyTickets(tickets) ? (
              <TicketPanel tickets={tickets} />
            ) : (
              <Card>
                <div className="text-sm opacity-80 text-blue-100">Tickets</div>
                <div className="mt-1 text-sm opacity-80 text-blue-100">Nema dostupnih BTTS / OU2.5 / HT-FT tiketa.</div>
              </Card>
            )}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- CRYPTO tab ---------------- */

function CryptoBody() {
  const { signals, loading } = useCryptoFeed();

  return (
    <div className="space-y-4">
      <SectionTitle>Crypto · Signals</SectionTitle>
      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          <SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      ) : signals.length ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {signals.map((s, i) => <CryptoCard key={i} s={s} />)}
        </div>
      ) : (
        <Card><div className="text-sm opacity-80 text-blue-100">Nema crypto signala za prikaz.</div></Card>
      )}
    </div>
  );
}

/* ---------------- top-level tabs ---------------- */

export default function CombinedBets() {
  const [mainTab, setMainTab] = useState("combined");   // "combined" | "football" | "crypto"
  const [footballTab, setFootballTab] = useState("kickoff"); // "kickoff" | "confidence" | "history"

  return (
    <div className="space-y-8 text-blue-50 [font-variant-numeric:tabular-nums]">
      {/* suptilni gradijent pozadine (ako parent nema) */}
      <div className="relative -mx-4 px-4">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-[#0b1533] via-[#0a1840] to-[#07102a]" />
      </div>

      {/* Main tabs header */}
      <div className="flex items-center gap-2">
        {[
          { key: "combined", label: "Combined" },
          { key: "football", label: "Football" },
          { key: "crypto",   label: "Crypto"   },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setMainTab(t.key)}
            className={`${tabBase} ${mainTab === t.key ? tabActive : tabIdle}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Main tab content */}
      {mainTab === "combined" && (
        <section aria-label="Combined">
          <CombinedBody />
        </section>
      )}

      {mainTab === "football" && (
        <section aria-label="Football" className="space-y-6">
          {/* Football sub-tabs */}
          <div className="flex items-center gap-2">
            {[
              { key: "kickoff",    label: "Kick-Off"   },
              { key: "confidence", label: "Confidence" },
              { key: "history",    label: "History"    },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setFootballTab(t.key)}
                className={`${tabBase} ${footballTab === t.key ? tabActive : tabIdle} text-sm`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Football content (sub-tab) */}
          <FootballBody subTab={footballTab} />
        </section>
      )}

      {mainTab === "crypto" && (
        <section aria-label="Crypto">
          <CryptoBody />
        </section>
      )}
    </div>
  );
}
