import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";
import TicketPanel from "./TicketPanel"; // ⬅️ novo

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
  // prikaz u Europe/Belgrade (bez biblioteka)
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

/* ---------------- hooks ---------------- */

function useFootballFeed() {
  const [items, setItems] = useState([]);
  const [tickets, setTickets] = useState(null);  // ⬅️ novo
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      // 1) Zaključani VB (iz ovoga čitamo i 1X2 i tikete)
      const vb = await safeJson(`/api/value-bets-locked?slim=1`);
      if (!alive) return;

      if (vb?.ok) {
        // API može vratiti { items: [], tickets: { btts:[], ou25:[], htft:[] }, ymd, slot, ... }
        const it = Array.isArray(vb.items) ? vb.items : [];
        const tk = vb?.tickets && typeof vb.tickets === "object" ? vb.tickets : {};
        setItems(it);
        setTickets(tk);
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

/* ---------------- presentational ---------------- */

function ItemCard({ it }) {
  const k = toISO(it);
  return (
    <div className="rounded-2xl p-4 shadow-md bg-black/40 border border-white/10">
      <div className="text-sm opacity-70">{it.league_name} · {it.league_country}</div>
      <div className="mt-1 text-lg font-semibold">
        {it.home} — {it.away}
      </div>
      <div className="mt-1 text-sm opacity-80">Kick-off: {fmtKickoff(k)}</div>
      <div className="mt-2 text-sm">
        <span className="opacity-70">Market:</span> <b>{it.market}</b> · <span className="opacity-70">Pick:</span> <b>{it.pick}</b>
      </div>
      <div className="mt-1 text-sm">
        <span className="opacity-70">Conf:</span> <b>{(it.confidence_pct ?? Math.round((it.model_prob ?? 0)*100))}%</b>
        {it?.odds?.price ? <> · <span className="opacity-70">Odds:</span> <b>{it.odds.price}</b></> : null}
      </div>
    </div>
  );
}

function TicketsAside({ tickets }) {
  if (!hasAnyTickets(tickets)) {
    return (
      <aside aria-label="Tickets" className="space-y-3">
        <div className="rounded-2xl p-4 bg-black/30 border border-white/10">
          <div className="text-sm opacity-70">Tickets</div>
          <div className="mt-1 text-sm opacity-70">Nema dostupnih BTTS / OU2.5 / HT-FT tiketa.</div>
        </div>
      </aside>
    );
  }

  const group = [
    { key: "btts",  title: "BTTS (Oba daju gol)" },
    { key: "ou25",  title: "Over/Under 2.5" },
    { key: "htft",  title: "HT–FT" },
  ];

  return (
    <aside aria-label="Tickets" className="space-y-4">
      {group.map(g => {
        const arr = Array.isArray(tickets[g.key]) ? tickets[g.key] : [];
        if (!arr.length) return null;
        return (
          <div key={g.key} className="rounded-2xl p-4 bg-black/30 border border-white/10">
            <div className="text-sm font-semibold">{g.title}</div>
            <div className="mt-3 space-y-3">
              {arr.map((it, idx) => (
                <div key={idx} className="text-sm">
                  <div className="opacity-70">{it?.league_name} · {it?.league_country}</div>
                  <div className="font-medium">{it?.home} — {it?.away}</div>
                  <div className="opacity-80">Kick-off: {fmtKickoff(toISO(it))}</div>
                  <div className="mt-0.5">
                    <span className="opacity-70">Pick:</span> <b>{it?.selection_label || it?.pick || it?.market}</b>
                    {it?.odds?.price ? <> · <span className="opacity-70">Odds:</span> <b>{it.odds.price}</b></> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

function FootballBody() {
  const { items, tickets, loading, err } = useFootballFeed();

  // Sortiranja za dva pod-taba
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Levo: 1X2 lista (2 kolone na većim ekranima) */}
      <div className="lg:col-span-2 space-y-6">
        <div>
          <div className="mb-2 text-sm opacity-70">Kick-Off</div>
          {loading ? (
            <div className="text-sm opacity-70">Učitavanje…</div>
          ) : (byKickoff.length ? (
            <div className="grid md:grid-cols-2 gap-4">
              {byKickoff.map((it, i) => <ItemCard key={i} it={it} />)}
            </div>
          ) : leftEmptyMsg)}
        </div>

        <div>
          <div className="mb-2 text-sm opacity-70">Confidence</div>
          {loading ? (
            <div className="text-sm opacity-70">Učitavanje…</div>
          ) : (byConfidence.length ? (
            <div className="grid md:grid-cols-2 gap-4">
              {byConfidence.map((it, i) => <ItemCard key={i} it={it} />)}
            </div>
          ) : leftEmptyMsg)}
        </div>

        {/* History ostaje kako je (placeholder ili tvoj stvarni panel) */}
        <div>
          <div className="mb-2 text-sm opacity-70">History (14d)</div>
          <HistoryPanel />
        </div>
      </div>

      {/* Desno: Tickets stub (vidljiv bez obzira na items[]) */}
      <div className="lg:col-span-1">
        <TicketsAside tickets={tickets} />
      </div>
    </div>
  );
}

export default function CombinedBets() {
  // Pretpostavljam da već imaš tabove Combined / Football / Crypto u ovoj komponenti.
  // Da ne menjamo postojeći raspored i logiku, ovde samo renderujemo FootballBody
  // u "Football" sekciji. Ako već imaš tvoje tabove, zameni njihov Football sadržaj
  // ovim <FootballBody />. Ako nemaš tabove — ostavi ovako.

  return (
    <div className="space-y-8">
      {/* Combined i Crypto sekcije ostaju kakve jesu u tvom originalnom fajlu.
         Ako tvoj original već ima više tabova, zadrži ih i samo ubaci <FootballBody /> u Football tab. */}

      {/* FOOTBALL TAB */}
      <section aria-label="Football">
        <FootballBody />
      </section>
    </div>
  );
}
