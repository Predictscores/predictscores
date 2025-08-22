// components/FootballBets.jsx
"use client";

import { useEffect, useMemo, useState } from "react";

/* ---------------- data hook ---------------- */
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
      if (!ct.includes("application/json")) throw new Error("API returned non-JSON");
      const js = await r.json();

      // podrži oba formata: items (novo) i value_bets (staro)
      const arr = Array.isArray(js?.items)
        ? js.items
        : Array.isArray(js?.value_bets)
        ? js.value_bets
        : [];

      setItems(arr);
    } catch (e) {
      setError(String(e?.message || e));
      setItems([]); // nikad ne ruši render
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  return { items, loading, error, reload: load };
}

/* ---------------- helpers ---------------- */
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
function evPct(p) {
  const ev = Number(p?.ev);
  if (Number.isFinite(ev)) return pct(ev);
  return null;
}
function whyFallback(p) {
  // ako nema explain.* složi kratak “Zašto” iz model/odds/EV + broj kladionica
  const mp = pct(p?.model_prob);
  const ip = pct(p?.implied_prob ?? (p?.market_odds ? 100 / p.market_odds : null));
  const ev = evPct(p);
  const bookAll = Number.isFinite(p?.bookmakers_count) ? p.bookmakers_count : null;
  const bookTr  = Number.isFinite(p?.bookmakers_count_trusted) ? p.bookmakers_count_trusted : null;
  const parts = [];
  if (mp != null && ip != null) parts.push(`Model ${mp}% vs ${ip}%`);
  if (ev != null) parts.push(`EV ${ev}%`);
  if (bookAll != null) parts.push(`Bookies ${bookAll}${bookTr!=null?` (trusted ${bookTr})`:""}`);
  return parts.length ? `Zašto: ${parts.join(" · ")}` : "";
}
function formatWhyAndForm(p) {
  if (typeof p?.explain?.text === "string" && p.explain.text.trim()) {
    return p.explain.text.trim();
  }
  const summary = typeof p?.explain?.summary === "string" ? p.explain.summary : "";
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];

  const formaLine =
    bullets.find((b) => /^h2h|^h2h \(l5\)|^forma:/i.test((b?.trim?.() || ""))) || null;
  const whyList = bullets.filter(
    (b) => !/^h2h|^h2h \(l5\)|^forma:/i.test((b?.trim?.() || ""))
  );

  const zasto = whyList.length
    ? `Zašto: ${whyList.join(". ")}.`
    : summary
    ? `Zašto: ${summary.replace(/\.$/, "")}.`
    : whyFallback(p);

  const forma = formaLine
    ? `Forma: ${formaLine
        .replace(/^forma:\s*/i, "")
        .replace(/^h2h\s*/i, "H2H ")
        .replace(/^h2h \(l5\):\s*/i, "H2H (L5): ")}`
    : "";

  return [zasto, forma].filter(Boolean).join("\n");
}

/* ---------------- Tickets (3×) ---------------- */
function buildTickets(items) {
  const top = [...(Array.isArray(items) ? items : [])]
    .sort((a, b) => (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0) || (b?.ev ?? 0) - (a?.ev ?? 0))
    .slice(0, 3);
  return [
    { label: "Ticket A", picks: top.slice(0, 1) },
    { label: "Ticket B", picks: top.slice(0, 2) },
    { label: "Ticket C", picks: top.slice(0, 3) },
  ];
}
function TicketsBlock({ items }) {
  const tickets = useMemo(() => buildTickets(items), [items]);
  if (!tickets.length) return null;
  return (
    <div className="grid md:grid-cols-3 gap-3 mb-4">
      {tickets.map((t) => (
        <div
          key={t.label}
          className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800"
        >
          <div className="text-sm opacity-80 mb-2">{t.label}</div>
          <ul className="space-y-2">
            {t.picks.map((p, idx) => {
              if (!p) return null;
              const league = p?.league?.name || p?.league_name || "";
              const home =
                p?.teams?.home?.name || p?.teams?.home || p?.home || "";
              const away =
                p?.teams?.away?.name || p?.teams?.away || p?.away || "";
              const mk = p?.market_label || p?.market || "";
              const sel = p?.selection || "";
              return (
                <li key={idx} className="text-sm">
                  <span className="opacity-70">{league}</span>{" • "}
                  <strong>
                    {home} vs {away}
                  </strong>{" "}
                  — <span>{mk}: <b>{sel}</b></span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Card ---------------- */
function Card({ p }) {
  const league = p?.league?.name || p?.league_name || "";
  const ko = p?.datetime_local?.starting_at?.date_time || p?.ko || "";
  const home = p?.teams?.home?.name || p?.teams?.home || p?.home || "";
  const away = p?.teams?.away?.name || p?.teams?.away || p?.away || "";
  const market = p?.market_label || p?.market || "";
  const sel = p?.selection || "";
  const price = p?.market_odds ?? p?.odds ?? p?.price;
  const conf = p?.confidence_pct ?? p?.confidence ?? 0;

  const whyText = formatWhyAndForm(p);

  return (
    <div className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
      <div className="text-xs opacity-70 mb-1">
        {league} • {ko}
      </div>
      <div className="text-lg font-semibold mb-1">
        {home} vs {away}
      </div>
      <div className="text-sm mb-2">
        {market}: <b>{sel}</b> {price ? <span>({price})</span> : null}
      </div>

      {!!whyText && (
        <div className="text-sm opacity-90 mb-3 whitespace-pre-line">{whyText}</div>
      )}

      <div className="text-xs opacity-70 mb-1">Confidence</div>
      <div className="h-2 bg-neutral-800 rounded">
        <div
          className="h-2 rounded bg-yellow-500"
          style={{ width: `${Math.max(0, Math.min(100, conf))}%` }}
        />
      </div>
    </div>
  );
}

/* ---------------- Tabs (lokalni) ---------------- */
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
      {Btn("hist", "History (14d)")}
    </div>
  );
}

/* ---------------- Main ---------------- */
export default function FootballBets({ limit, layout = "full" }) {
  const { items, loading, error } = useLockedValueBets();
  const [tab, setTab] = useState("kick");

  // sortiranja
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

  // u Combined layoutu: bez tiketa i bez tabova, uzmi top N po confidence
  const combinedTop = useMemo(() => {
    const base = byConfidence;
    return typeof limit === "number" ? base.slice(0, limit) : base.slice(0, 3);
  }, [byConfidence, limit]);

  if (loading) return <div className="opacity-70">Učitavanje…</div>;
  if (error)
    return <div className="text-red-400">Greška: {String(error)}</div>;

  // COMBINED layout
  if (layout === "combined") {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4">
          {combinedTop.map((p, i) => (
            <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
          ))}
        </div>
      </div>
    );
  }

  // FULL layout (Football tab): tiketi + tabovi
  const listKick =
    typeof limit === "number" ? byKickoff.slice(0, limit) : byKickoff;
  const listConf =
    typeof limit === "number" ? byConfidence.slice(0, limit) : byConfidence;

  return (
    <div className="space-y-4">
      {Array.isArray(items) && items.length > 0 && (
        <TicketsBlock items={items} />
      )}

      <TabsInline active={tab} onChange={setTab} />

      {!items?.length && (
        <div className="opacity-70">Nema dostupnih predloga.</div>
      )}

      {tab === "kick" && (
        <div className="grid lg:grid-cols-2 gap-4">
          {listKick.map((p, i) => (
            <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
          ))}
        </div>
      )}

      {tab === "conf" && (
        <div className="grid lg:grid-cols-2 gap-4">
          {listConf.map((p, i) => (
            <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
          ))}
        </div>
      )}

      {tab === "hist" && (
        <div className="rounded-2xl p-4 border border-neutral-800 bg-neutral-900/60 text-sm opacity-80">
          History (14d) će se puniti iz nightly procesa.
        </div>
      )}
    </div>
  );
}
