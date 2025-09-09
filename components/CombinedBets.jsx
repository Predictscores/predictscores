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
      // koristi tvoj postojeći API za kripto signale
      const r = await safeJson(`/api/crypto`);
      if (!alive) return;
      if (r?.ok) {
        // podrži više formata: r.signals || r.items || r.data
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

/* ---------------- presentational blocks ---------------- */

function ItemCard({ it }) {
  const k = toISO(it);
  const conf = it?.confidence_pct ?? (it?.model_prob != null ? Math.round(it.model_prob*100) : undefined);
  return (
    <div className="rounded-2xl p-4 shadow-md bg-black/40 border border-white/10">
      <div className="text-sm opacity-70">{it.league_name} · {it.league_country}</div>
      <div className="mt-1 text-lg font-semibold">
        {it.home} — {it.away}
      </div>
      <div className="mt-1 text-sm opacity-80">Kick-off: {fmtKickoff(k)}</div>
      <div className="mt-2 text-sm">
        <span className="opacity-70">Market:</span> <b>{it.market}</b> · <span className="opacity-70">Pick:</span> <b>{it.pick || it.selection_label}</b>
      </div>
      <div className="mt-1 text-sm">
        {conf != null ? (<><span className="opacity-70">Conf:</span> <b>{conf}%</b></>) : null}
        {it?.odds?.price ? <> · <span className="opacity-70">Odds:</span> <b>{it.odds.price}</b></> : null}
      </div>
    </div>
  );
}

function CryptoCard({ s }) {
  const sym = s?.symbol || s?.pair || s?.ticker || "—";
  const sig = (s?.signal || s?.side || s?.direction || "").toUpperCase();
  const price = s?.price ?? s?.last ?? s?.close;
  const conf = s?.confidence ?? s?.score ?? s?.strength;
  return (
    <div className="rounded-2xl p-4 shadow-md bg-black/40 border border-white/10">
      <div className="text-sm opacity-70">Crypto</div>
      <div className="mt-1 text-lg font-semibold">{sym}</div>
      <div className="mt-1 text-sm"><span className="opacity-70">Signal:</span> <b>{sig || "—"}</b></div>
      {price != null ? <div className="mt-1 text-sm"><span className="opacity-70">Price:</span> <b>{price}</b></div> : null}
      {conf != null ? <div className="mt-1 text-sm"><span className="opacity-70">Confidence:</span> <b>{Math.round(conf)}%</b></div> : null}
    </div>
  );
}

/* ---------------- COMBINED tab ---------------- */

function CombinedBody() {
  const { items, loading: fLoading } = useFootballFeed();
  const { signals, loading: cLoading } = useCryptoFeed();

  const topFootball = useMemo(() => [...items].slice(0, 3), [items]);  // Top 3 singla
  const topCrypto   = useMemo(() => [...signals].slice(0, 3), [signals]); // Top 3 kripto

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div>
        <div className="mb-2 text-sm opacity-70">Football · Top 3 (singl)</div>
        {fLoading ? (
          <div className="text-sm opacity-70">Učitavanje…</div>
        ) : topFootball.length ? (
          <div className="space-y-4">
            {topFootball.map((it, i) => <ItemCard key={i} it={it} />)}
          </div>
        ) : (
          <div className="text-sm opacity-70 rounded-2xl p-4 bg-black/20 border border-white/10">Nema 1X2 singlova za prikaz.</div>
        )}
      </div>

      <div>
        <div className="mb-2 text-sm opacity-70">Crypto · Top 3</div>
        {cLoading ? (
          <div className="text-sm opacity-70">Učitavanje…</div>
        ) : topCrypto.length ? (
          <div className="space-y-4">
            {topCrypto.map((s, i) => <CryptoCard key={i} s={s} />)}
          </div>
        ) : (
          <div className="text-sm opacity-70 rounded-2xl p-4 bg-black/20 border border-white/10">Nema crypto signala za prikaz.</div>
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
    <div className="rounded-2xl p-4 bg-black/20 border border-white/10 text-sm opacity-80">
      Nema 1X2 singlova za prikaz (items[] je prazan).
    </div>
  );

  const showTickets = subTab === "kickoff" || subTab === "confidence";

  if (subTab === "history") {
    // HISTORY pod-tab: BEZ tiketa, full width
    return (
      <div className="space-y-4">
        <div className="mb-2 text-sm opacity-70">History (14d)</div>
        <HistoryPanel />
      </div>
    );
  }

  const list = subTab === "kickoff" ? byKickoff : byConfidence;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Levo: 1X2 lista */}
      <div className={showTickets ? "lg:col-span-2" : "lg:col-span-3"}>
        <div className="mb-2 text-sm opacity-70">
          {subTab === "kickoff" ? "Kick-Off" : "Confidence"}
        </div>
        {loading ? (
          <div className="text-sm opacity-70">Učitavanje…</div>
        ) : (list.length ? (
          <div className="grid md:grid-cols-2 gap-4">
            {list.map((it, i) => <ItemCard key={i} it={it} />)}
          </div>
        ) : leftEmptyMsg)}
      </div>

      {/* Desno: Tickets (samo na Kick-Off i Confidence) */}
      {showTickets ? (
        <div className="lg:col-span-1">
          <aside aria-label="Tickets">
            {hasAnyTickets(tickets) ? (
              <TicketPanel tickets={tickets} />
            ) : (
              <div className="rounded-2xl p-4 bg-black/30 border border-white/10">
                <div className="text-sm opacity-70">Tickets</div>
                <div className="mt-1 text-sm opacity-70">Nema dostupnih BTTS / OU2.5 / HT-FT tiketa.</div>
              </div>
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
    <div>
      <div className="mb-2 text-sm opacity-70">Crypto · Signals</div>
      {loading ? (
        <div className="text-sm opacity-70">Učitavanje…</div>
      ) : signals.length ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {signals.map((s, i) => <CryptoCard key={i} s={s} />)}
        </div>
      ) : (
        <div className="text-sm opacity-70 rounded-2xl p-4 bg-black/20 border border-white/10">Nema crypto signala za prikaz.</div>
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
              ? "bg-white/10 border-white/20"
              : "bg-black/20 border-white/10 hover:bg-black/30"
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
                  ? "bg-white/10 border-white/20"
                  : "bg-black/20 border-white/10 hover:bg-black/30"
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
