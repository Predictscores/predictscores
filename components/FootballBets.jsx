// components/FootballBets.jsx
import { useEffect, useState } from "react";

function useLockedValueBets() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const r = await fetch("/api/value-bets-locked", { cache: "no-store" });
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error("Invalid content-type");
      const js = await r.json();
      if (!js || !js.items) throw new Error("Empty payload");
      setItems(js.items);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // poll na 60s
    return () => clearInterval(id);
  }, []);

  return { items, loading, error };
}

// --- Tickets (3×) ---
function buildTickets(items) {
  // jednostavno: uzmi Top 3 po confidence iz locked feeda
  const top = [...items].sort((a, b) => (b.confidence_pct ?? 0) - (a.confidence_pct ?? 0)).slice(0, 3);
  return [
    { label: "Ticket A", picks: top.slice(0, 1) },
    { label: "Ticket B", picks: top.slice(0, 2) },
    { label: "Ticket C", picks: top.slice(0, 3) }
  ];
}

function TicketsBlock({ items }) {
  const tickets = buildTickets(items);
  return (
    <div className="grid md:grid-cols-3 gap-3 mb-4">
      {tickets.map(t => (
        <div key={t.label} className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
          <div className="text-sm opacity-80 mb-2">{t.label}</div>
          <ul className="space-y-2">
            {t.picks.map((p, idx) => (
              <li key={idx} className="text-sm">
                <span className="opacity-70">{p.league?.name || p.league_name}</span>{" • "}
                <strong>{p.teams?.home || p.home} vs {p.teams?.away || p.away}</strong>{" — "}
                <span>{p.market_label || p.market}: <b>{p.selection}</b></span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Card({ p }) {
  const league = p.league?.name || p.league_name || "";
  const ko     = p.datetime_local?.starting_at?.date_time || p.ko || "";
  const home   = p.teams?.home || p.home || "";
  const away   = p.teams?.away || p.away || "";
  const market = p.market_label || p.market || "";
  const sel    = p.selection;
  const price  = p.odds || p.price;
  const conf   = p.confidence_pct ?? p.confidence ?? 0;
  const whyTxt = p.explain?.text || p.explain?.summary || "";

  return (
    <div className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
      <div className="text-xs opacity-70 mb-1">{league} • {ko}</div>
      <div className="text-lg font-semibold mb-1">{home} vs {away}</div>
      <div className="text-sm mb-2">{market}: <b>{sel}</b> {price ? <span>({price})</span> : null}</div>

      {/* Novi blok: Zašto + Forma(H2H) */}
      {whyTxt ? (
        <div className="text-sm opacity-90 mb-3 whitespace-pre-line">
          {whyTxt}
        </div>
      ) : null}

      {/* Confidence bar */}
      <div className="text-xs opacity-70 mb-1">Confidence</div>
      <div className="h-2 bg-neutral-800 rounded">
        <div className="h-2 rounded bg-yellow-500" style={{ width: `${Math.max(0, Math.min(100, conf))}%` }} />
      </div>
    </div>
  );
}

export default function FootballBets() {
  const { items, loading, error } = useLockedValueBets();

  if (loading) return <div className="opacity-70">Učitavanje…</div>;
  if (error)   return <div className="text-red-400">Greška: {error}</div>;
  if (!items.length) return <div className="opacity-70">Nema dostupnih predloga.</div>;

  return (
    <div className="space-y-4">
      {/* 3× tiketa NA VRHU Football taba */}
      <TicketsBlock items={items} />

      {/* Singl kartice ispod */}
      <div className="grid lg:grid-cols-2 gap-4">
        {items.map((p, i) => <Card key={`${p.fixture_id || i}`} p={p} />)}
      </div>
    </div>
  );
}
