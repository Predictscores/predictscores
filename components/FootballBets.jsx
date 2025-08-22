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
  const mp = pct(p?.model_prob);
  const ip = pct(p?.implied_prob ?? impliedFromOdds(p?.market_odds));
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

/* ---------------- Tickets (kros-market, UVEK NA VRHU Football taba) ---------------- */

// prepoznaj kategoriju tržišta
function marketBucket(p) {
  const m = String(p?.market_label || p?.market || "").toUpperCase();
  if (m.includes("BTTS")) return "BTTS";
  if (m.includes("OU") || m.includes("OVER") || m.includes("UNDER")) return "OU";
  if (m.includes("HT-FT") || m.includes("HTFT")) return "HTFT";
  return "1X2";
}

// uzmi TOP po confidence unutar svake bucket grupe
function pickTopByBucket(items, bucket) {
  return [...(items || [])]
    .filter((p) => marketBucket(p) === bucket)
    .sort(
      (a, b) =>
        (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0) ||
        (b?.ev ?? 0) - (a?.ev ?? 0)
    )[0];
}

// napravi 3 tiketa: A (1 singl), B (2 selekcije), C (3 selekcije)
function buildCrossMarketTickets(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const top1x2 = pickTopByBucket(items, "1X2");
  const topOU  = pickTopByBucket(items, "OU");
  const topBT  = pickTopByBucket(items, "BTTS");
  const topHF  = pickTopByBucket(items, "HTFT");

  // fallback-ovi ako nema OU/BTTS/HTFT
  const poolByEV = [...items].sort((a,b)=> (b?.ev ?? 0)-(a?.ev ?? 0));
  const nextBest = (exclude=[]) => poolByEV.find(p => !exclude.includes(p));

  const A = [ top1x2 || nextBest([]) ].filter(Boolean);
  const B = [ (top1x2 || nextBest([])), (topOU || topBT || nextBest([top1x2])) ].filter(Boolean);
  const C = [ (top1x2 || nextBest([])), (topOU || topBT || nextBest([top1x2])), (topHF || nextBest([top1x2, topOU || topBT])) ].filter(Boolean);

  return [
    { label: "Ticket A", picks: A },
    { label: "Ticket B", picks: B.slice(0,2) },
    { label: "Ticket C", picks: C.slice(0,3) },
  ];
}

function TicketsBlock({ items }) {
  const tickets = useMemo(() => buildCrossMarketTickets(items), [items]);
  if (!tickets.length) return null;
  return (
    <div className="grid md:grid-cols-3 gap-3 mb-4">
      {tickets.map((t) => (
        <div key={t.label} className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
          <div className="text-sm opacity-80 mb-2">{t.label}</div>
          <ul className="space-y-2">
            {t.picks.map((p, idx) => {
              const league = p?.league?.name || p?.league_name || "";
              const home   = p?.teams?.home?.name || p?.teams?.home || p?.home || "";
              const away   = p?.teams?.away?.name || p?.teams?.away || p?.away || "";
              const mk     = p?.market_label || p?.market || "";
              const sel    = p?.selection || "";
              const odds   = p?.market_odds ?? p?.odds ?? p?.price;
              return (
                <li key={idx} className="text-sm">
                  <span className="opacity-70">{league}</span>{" • "}
                  <strong>{home} vs {away}</strong>{" — "}
                  <span>{mk}: <b>{sel}</b>{odds ? ` (${odds})` : ""}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Karte ---------------- */
function ConfidenceBadge({ conf }) {
  const lvl =
    conf >= 75 ? "High" : conf >= 50 ? "Moderate" : "Low";
  const dot =
    conf >= 75 ? "bg-emerald-400" : conf >= 50 ? "bg-sky-400" : "bg-amber-400";
  return (
    <span className="inline-flex items-center gap-2 text-xs opacity-80">
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

  const whyText = formatWhyAndForm(p);

  return (
    <div className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
      <div className="flex items-center justify-between text-xs opacity-70 mb-1">
        <div>{league} • {ko}</div>
        <ConfidenceBadge conf={conf} />
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
      {Btn("hist", "History")}
    </div>
  );
}

/* ---------------- Top lige (desni panel) ---------------- */
function bucketLabel(p) {
  const m = String(p?.market_label || p?.market || "").toUpperCase();
  if (m.includes("BTTS")) return "BTTS";
  if (m.includes("OU") || m.includes("OVER") || m.includes("UNDER")) return "OU 2.5";
  if (m.includes("HT-FT") || m.includes("HTFT")) return "HT-FT";
  return "1X2";
}
function groupTopLeagues(items) {
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
function SidePanelTopLeagues({ items }) {
  const G = useMemo(() => groupTopLeagues(items), [items]);
  const Section = ({ title, arr }) => (
    <div className="mb-5">
      <div className="font-semibold mb-2">{title} ({arr.length})</div>
      {arr.length === 0 && (
        <div className="text-sm opacity-70">Nema dovoljno kandidata.</div>
      )}
      <div className="space-y-3">
        {arr.map((p, i) => (
          <div key={`${title}-${p?.fixture_id ?? i}`} className="rounded-xl p-3 bg-neutral-900/60 border border-neutral-800">
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
              {formatWhyAndForm(p).split("\n")[0]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
      <div className="text-lg font-semibold mb-3">Top lige</div>
      <Section title="BTTS"  arr={G["BTTS"]} />
      <Section title="OU 2.5" arr={G["OU 2.5"]} />
      <Section title="HT-FT" arr={G["HT-FT"]} />
      <Section title="1X2"   arr={G["1X2"]} />
    </div>
  );
}

/* ---------------- Main ---------------- */
export default function FootballBets({ limit, layout = "full" }) {
  const { items, loading, error } = useLockedValueBets();
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

  // COMBINED: bez tiketa, bez tabova, bez desnog panela; samo Top N
  if (layout === "combined") {
    const combinedTop =
      typeof limit === "number" ? byConfidence.slice(0, limit) : byConfidence.slice(0, 3);
    if (loading) return <div className="opacity-70">Učitavanje…</div>;
    if (error) return <div className="text-red-400">Greška: {String(error)}</div>;
    return (
      <div className="grid grid-cols-1 gap-4">
        {combinedTop.map((p, i) => (
          <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
        ))}
      </div>
    );
  }

  if (loading) return <div className="opacity-70">Učitavanje…</div>;
  if (error) return <div className="text-red-400">Greška: {String(error)}</div>;

  // FULL (Football tab): tiketi + tabovi + desna kolona “Top lige”
  const listKick =
    typeof limit === "number" ? byKickoff.slice(0, limit) : byKickoff;
  const listConf =
    typeof limit === "number" ? byConfidence.slice(0, limit) : byConfidence;

  return (
    <div className="space-y-4">
      {/* 3× tiketa — UVEK NA VRHU Football taba */}
      {Array.isArray(items) && items.length > 0 && (
        <TicketsBlock items={items} />
      )}

      <TabsInline active={tab} onChange={setTab} />

      {!items?.length && (
        <div className="opacity-70">Nema dostupnih predloga.</div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        {/* leve 2 kolone: liste po tabu */}
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
            <div className="rounded-2xl p-4 border border-neutral-800 bg-neutral-900/60 text-sm opacity-80">
              History (14d) će se puniti iz nightly procesa.
            </div>
          )}
        </div>

        {/* desna 1 kolona: Top lige */}
        <div className="lg:col-span-1">
          <SidePanelTopLeagues items={items} />
        </div>
      </div>
    </div>
  );
}
