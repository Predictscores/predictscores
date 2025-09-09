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

/* ---------------- football feed ---------------- */

function useFootballFeed() {
  const [items, setItems] = useState([]);
  const [tickets, setTickets] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      const vb = await safeJson(`/api/value-bets-locked?slim=1`);
      if (!alive) return;
      if (vb?.ok) {
        setItems(Array.isArray(vb.items) ? vb.items : []);
        setTickets(vb?.tickets && typeof vb.tickets === "object" ? vb.tickets : {});
      } else {
        setErr(vb?.error || "N/A");
        setItems([]);
        setTickets({});
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  return { items, tickets, loading, err };
}

/* ---------------- crypto feed ---------------- */

function useCryptoFeed() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      const r = await safeJson(`/api/crypto`);
      if (!alive) return;
      if (r?.ok) {
        const arr = Array.isArray(r.signals) ? r.signals
                  : Array.isArray(r.items)   ? r.items
                  : Array.isArray(r.data)    ? r.data
                  : [];
        setSignals(arr);
      } else {
        setErr(r?.error || "N/A");
        setSignals([]);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  return { signals, loading, err };
}

/* ---------------- sparkline (SVG) ---------------- */

function toSparkSeries(s) {
  // dozvoljeni ulazi: s.sparkline=[...prices] ili s.history=[{price|close|last}]
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

function SparklineSVG({ series, height = 80, color = "blue" }) {
  const w = 260;
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

  const fillPath = `M0,${h} L${pts} L${w},${h} Z`;

  const palette = {
    green: {
      stroke: "rgba(74,222,128,0.95)",   // green-400
      fill:   "rgba(74,222,128,0.15)",
    },
    red: {
      stroke: "rgba(248,113,113,0.95)",  // red-400
      fill:   "rgba(248,113,113,0.15)",
    },
    blue: {
      stroke: "rgba(147,197,253,0.9)",   // blue-300
      fill:   "rgba(59,130,246,0.15)",   // blue-500-ish
    }
  };
  const c = palette[color] || palette.blue;

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
    </svg>
  );
}

/* ---------------- presentational (plava tema) ---------------- */

function Card({ children }) {
  return (
    <div className="rounded-2xl p-4 shadow-md bg-blue-900/30 border border-blue-300/20">
      {children}
    </div>
  );
}
function SectionTitle({ children }) {
  return <div className="mb-2 text-sm opacity-80 text-blue-50">{children}</div>;
}

function ItemCard({ it }) {
  const k = toISO(it);
  const conf = it?.confidence_pct ?? (it?.model_prob != null ? Math.round(it.model_prob*100) : undefined);
  return (
    <Card>
      <div className="text-sm opacity-80 text-blue-100">{it.league_name} · {it.league_country}</div>
      <div className="mt-1 text-lg font-semibold text-blue-50">
        {it.home} — {it.away}
      </div>
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

/* ---------------- crypto cards ---------------- */

function normalizeSignal(s) {
  const symbol = s?.symbol || s?.pair || s?.ticker || "—";
  const sideRaw = (s?.signal || s?.side || s?.direction || "").toString().toUpperCase();
  const side = sideRaw.includes("LONG") || sideRaw.includes("BUY") ? "LONG"
             : sideRaw.includes("SHORT") || sideRaw.includes("SELL") ? "SHORT"
             : sideRaw || "—";

  const priceNow = num(s?.price ?? s?.last ?? s?.close);

  // entry candidates
  const entry = num(
    s?.entry ?? s?.entry_price ?? s?.entryPrice ?? s?.open ?? s?.buy_price ?? s?.buyPrice
  );

  // exit/target candidates (prefer TP/target; za short/long očekivanje računamo vs entry)
  const exit = num(
    s?.exit ?? s?.exit_price ?? s?.exitPrice ?? s?.target ?? s?.take_profit ?? s?.tp ?? s?.sell_price ?? s?.sellPrice
  );

  // Ako API šalje direktan očekivani procenat, uzmi; inače deriviraj iz entry/exit
  const expDirect = num(
    s?.expected_pct ?? s?.expectedChange ?? s?.exp_pct ?? s?.expChange ?? s?.expected
  );

  let expectedPct = expDirect;
  if (expectedPct == null && entry != null && exit != null && entry > 0) {
    if (side === "SHORT") expectedPct = ((entry - exit) / entry) * 100;
    else expectedPct = ((exit - entry) / entry) * 100; // LONG ili nepoznato
  }

  // 24h promene i sl.
  const ch24 = num(s?.change_24h ?? s?.changePct ?? s?.change ?? s?.pct_24h);
  const confidence = num(s?.confidence ?? s?.score ?? s?.strength);

  const series = toSparkSeries(s);

  return {
    symbol, side, priceNow, entry, exit, expectedPct, ch24, confidence, series,
  };
}

function Arrow({ dir }) {
  // dir: "up" | "down" | null
  if (dir === "up") return <span className="ml-1 text-green-300">▲</span>;
  if (dir === "down") return <span className="ml-1 text-rose-300">▼</span>;
  return null;
}

function CryptoCard({ s }) {
  const N = normalizeSignal(s);
  const pos = N.side === "LONG";
  const neg = N.side === "SHORT";

  const tagClass = pos
    ? "bg-green-500/10 border-green-400/30 text-green-200"
    : neg
    ? "bg-rose-500/10 border-rose-400/30 text-rose-200"
    : "bg-blue-500/10 border-blue-400/30 text-blue-100";

  const sparkColor = pos ? "green" : neg ? "red" : "blue";

  return (
    <Card>
      <div className="text-sm opacity-80 text-blue-100">Crypto</div>

      {/* Header */}
      <div className="mt-1 flex items-center justify-between">
        <div className="text-lg font-semibold text-blue-50">{N.symbol}</div>
        <span className={`px-2 py-0.5 rounded-md text-xs border flex items-center gap-1 ${tagClass}`}>
          {N.side}
          <Arrow dir={pos ? "up" : neg ? "down" : null} />
        </span>
      </div>

      {/* Metrics row */}
      <div className="mt-1 text-sm text-blue-100/90 flex flex-wrap gap-x-4 gap-y-1">
        <div>Price: <b>{N.priceNow != null ? N.priceNow : "—"}</b></div>
        <div>Entry: <b>{N.entry != null ? N.entry : "—"}</b></div>
        <div>Exit: <b>{N.exit != null ? N.exit : "—"}</b></div>
        <div>
          Exp:{" "}
          {N.expectedPct != null ? (
            <b className={N.expectedPct >= 0 ? "text-green-200" : "text-rose-200"}>
              {pct(N.expectedPct)}%
            </b>
          ) : (
            <b>—</b>
          )}
        </div>
      </div>

      {/* Extra row */}
      <div className="mt-1 text-sm text-blue-100/80 flex flex-wrap gap-x-4 gap-y-1">
        {N.ch24 != null ? (
          <div>24h: <b className={N.ch24 >= 0 ? "text-green-200" : "text-rose-200"}>{pct(N.ch24)}%</b></div>
        ) : null}
        {N.confidence != null ? <div>Confidence: <b>{Math.round(N.confidence)}%</b></div> : null}
      </div>

      {/* Chart */}
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

  const topFootball = useMemo(() => [...items].slice(0, 3), [items]);  // Top 3 singla
  const topCrypto   = useMemo(() => [...signals].slice(0, 3), [signals]); // Top 3 kripto

  return (
    <div className="space-y-8">
      {/* Football gore */}
      <div>
        <SectionTitle>Football · Top 3 (singl)</SectionTitle>
        {fLoading ? (
          <div className="text-sm opacity-80 text-blue-100">Učitavanje…</div>
        ) : topFootball.length ? (
          <div className="grid md:grid-cols-3 gap-4">
            {topFootball.map((it, i) => <ItemCard key={i} it={it} />)}
          </div>
        ) : (
          <div className="text-sm opacity-80 text-blue-100 rounded-2xl p-4 bg-blue-900/20 border border-blue-300/20">
            Nema 1X2 singlova za prikaz.
          </div>
        )}
      </div>

      {/* Crypto dole */}
      <div>
        <SectionTitle>Crypto · Top 3</SectionTitle>
        {cLoading ? (
          <div className="text-sm opacity-80 text-blue-100">Učitavanje…</div>
        ) : topCrypto.length ? (
          <div className="grid md:grid-cols-3 gap-4">
            {topCrypto.map((s, i) => <CryptoCard key={i} s={s} />)}
          </div>
        ) : (
          <div className="text-sm opacity-80 text-blue-100 rounded-2xl p-4 bg-blue-900/20 border border-blue-300/20">
            Nema crypto signala za prikaz.
          </div>
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
      const ca = a?.confidence_pct ?? Math.round((a?.model_prob ?? 0)*100);
      const cb = b?.confidence_pct ?? Math.round((b?.model_prob ?? 0)*100);
      return cb - ca;
    });
  }, [items]);

  const leftEmptyMsg = (
    <div className="rounded-2xl p-4 bg-blue-900/20 border border-blue-300/20 text-sm opacity-90 text-blue-100">
      Nema 1X2 singlova za prikaz (items[] je prazan).
    </div>
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
          <div className="text-sm opacity-80 text-blue-100">Učitavanje…</div>
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
        <div className="text-sm opacity-80 text-blue-100">Učitavanje…</div>
      ) : signals.length ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {signals.map((s, i) => <CryptoCard key={i} s={s} />)}
        </div>
      ) : (
        <div className="text-sm opacity-80 text-blue-100 rounded-2xl p-4 bg-blue-900/20 border border-blue-300/20">
          Nema crypto signala za prikaz.
        </div>
      )}
    </div>
  );
}

/* ---------------- top-level tabs ---------------- */

export default function CombinedBets() {
  const [mainTab, setMainTab] = useState("combined"); // "combined" | "football" | "crypto"
  const [footballTab, setFootballTab] = useState("kickoff"); // "kickoff" | "confidence" | "history"

  return (
    <div className="space-y-8">
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
            className={`px-4 py-2 rounded-xl border transition ${
              mainTab === t.key
              ? "bg-blue-900/30 border-blue-300/30 text-blue-50"
              : "bg-blue-900/10 border-blue-300/20 text-blue-100 hover:bg-blue-900/20"
            }`}
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
                className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                  footballTab === t.key
                  ? "bg-blue-900/30 border-blue-300/30 text-blue-50"
                  : "bg-blue-900/10 border-blue-300/20 text-blue-100 hover:bg-blue-900/20"
                }`}
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
