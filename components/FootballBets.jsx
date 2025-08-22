// FILE: components/FootballBets.js
import React, { useEffect, useMemo, useState } from "react";
import Tabs from "./Tabs";

/* ================= helpers ================= */
function safeJson(url) {
  return fetch(url, { cache: "no-store" }).then((r) => r.json());
}
function koISO(p) {
  const cands = [
    p?.kickoff,
    p?.ko,
    p?.datetime_local?.starting_at?.date_time,
    p?.datetime_local?.date_time,
    p?.datetime?.starting_at?.date_time,
    p?.datetime?.date_time,
  ].filter(Boolean);
  for (const s of cands) {
    const iso = String(s).includes("T") ? String(s) : String(s).replace(" ", "T");
    const d = new Date(iso);
    if (!Number.isNaN(+d)) return iso;
  }
  return null;
}
function koDate(p) { const s = koISO(p); return s ? new Date(s) : null; }
function conf(p) { const x = Number(p?.confidence_pct || 0); return Number.isFinite(x) ? x : 0; }
function ev(p) { const x = Number(p?.ev || 0); return Number.isFinite(x) ? x : -999; }
function oddsOf(p) { const x = Number(p?.market_odds || p?.odds || 0); return Number.isFinite(x) ? x : null; }
function marketOf(p) { return String(p?.market_label || p?.market || "").toUpperCase(); }
function isBTTS1H(p) { return /BTTS\s*1H/i.test(String(p?.market_label || p?.market || "")); }
function isBTTS(p) { return /BTTS/i.test(String(p?.market_label || p?.market || "")); }
function isOU(p) { return /^OU$|OVER\/UNDER|OVER\s*2\.?5/i.test(String(p?.market_label || p?.market || "")); }

function tierHeuristic(league) {
  const n = String(league?.name || "").toLowerCase();
  const c = String(league?.country || "").toLowerCase();
  const tier1Names = ["uefa champions league", "uefa europa league", "premier league", "la liga", "serie a", "bundesliga", "ligue 1"];
  if (tier1Names.some(t => n.includes(t))) return 1;
  const bigCountries = ["england", "spain", "italy", "germany", "france", "netherlands", "portugal"];
  if (bigCountries.includes(c)) return 2;
  return 3;
}

/** vremenski filter: za full prikaz dozvoli i malo prošlosti da lista ne bude prazna */
function filterByTime(items, mode) {
  const now = Date.now();
  const minPastMin = mode === "combined" ? -10 : -240;
  const maxFutureMin = 48 * 60;
  return items.filter((p) => {
    const d = koDate(p);
    if (!d) return false;
    const diff = Math.round((+d - now) / 60000);
    return diff >= minPastMin && diff <= maxFutureMin;
  });
}

function fmtTime(p) {
  const iso = koISO(p);
  return iso
    ? new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })
    : "";
}

/* ================= “Zašto” (bullets ili summary) ================= */
function Why({ p }) {
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const summary = p?.explain?.summary || "";
  if (bullets.length) {
    return (
      <ul className="mt-1 list-disc list-inside space-y-1">
        {bullets.map((b, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: b }} />
        ))}
      </ul>
    );
  }
  return summary ? <div className="mt-1 text-slate-300">{summary}</div> : null;
}

/* ================= singl kartica ================= */
function Card({ p }) {
  const league = p?.league?.name || "";
  const country = p?.league?.country || "";
  const time = fmtTime(p);
  const odds = oddsOf(p);
  const confPct = Math.max(0, Math.min(100, conf(p)));

  return (
    <div className="rounded-2xl bg-[#14182a] p-4 md:p-5 text-slate-200 shadow">
      <div className="text-xs uppercase tracking-wide text-slate-400 flex items-center gap-2">
        <span>🏆 {league}</span>
        {country ? <span>• {country}</span> : null}
        {time ? (<><span>•</span><span>{time}</span></>) : null}
      </div>

      <h3 className="mt-1 text-xl font-semibold">
        {p?.teams?.home?.name || p?.teams?.home} <span className="text-slate-400">vs</span> {p?.teams?.away?.name || p?.teams?.away}
      </h3>

      <div className="mt-2 text-slate-300 font-semibold">
        {p?.market_label || p?.market}: {p?.selection}{" "}
        {odds != null && <span className="text-slate-400">({odds.toFixed(2)})</span>}
      </div>

      {/* Confidence traka ISPOD (kao ranije) */}
      <div className="mt-2">
        <div className="text-xs text-slate-400">Confidence</div>
        <div className="h-2 bg-[#0f1424] rounded-full overflow-hidden">
          <div style={{ width: `${confPct}%` }} className="h-2 bg-sky-400" />
        </div>
      </div>

      {/* Zašto: tekstualno */}
      <div className="mt-3 text-sm">
        <div className="text-slate-400">Zašto:</div>
        <Why p={p} />
      </div>
    </div>
  );
}

/* ================= Tickets (3x) — bez novih fajlova =================
   - koristi već učitane LOCKED predloge
   - kreira 3 različita tiketa: TIER, EV, MIX
   - bez dodatnih API poziva
====================================================================== */
function productOdds(arr) {
  return arr.reduce((acc, p) => {
    const o = oddsOf(p);
    return acc * (o || 1);
  }, 1);
}
function uniqByFixture(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const id = p?.fixture_id || p?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(p);
  }
  return out;
}

function buildTickets(all) {
  // bazen: samo normalni predlozi (EV >= 0, imaju kvotu i kickoff)
  const base = all.filter((p) => {
    const o = oddsOf(p);
    const k = koDate(p);
    return Number.isFinite(ev(p)) && ev(p) >= 0 && o && k;
  });

  // Ticket A: TIER prioritet (1 > 2 > 3) + confidence
  const tA = uniqByFixture(
    [...base].sort((a, b) => {
      const ta = tierHeuristic(a.league), tb = tierHeuristic(b.league);
      if (ta !== tb) return ta - tb;
      const ca = conf(a), cb = conf(b);
      if (cb !== ca) return cb - ca;
      return (oddsOf(b) || 0) - (oddsOf(a) || 0);
    })
  ).slice(0, 3);

  // Ticket B: EV prioritet, umerene kvote 1.50–2.80
  const tB = uniqByFixture(
    base
      .filter((p) => {
        const o = oddsOf(p);
        return o >= 1.5 && o <= 2.8;
      })
      .sort((a, b) => {
        const eb = ev(b) - ev(a);
        if (eb !== 0) return eb;
        return conf(b) - conf(a);
      })
  ).slice(0, 3);

  // Ticket C: MIX po marketima (1X2, BTTS (uklj. 1H), OU)
  const byMkt = {
    "1X2": null,
    "BTTS*": null, // BTTS ili BTTS 1H
    "OU": null,
  };
  for (const p of base.sort((a, b) => conf(b) - conf(a) || ev(b) - ev(a))) {
    const m = marketOf(p);
    if (!byMkt["1X2"] && /^1X2$/.test(m)) byMkt["1X2"] = p;
    if (!byMkt["BTTS*"] && (isBTTS1H(p) || isBTTS(p))) byMkt["BTTS*"] = p;
    if (!byMkt["OU"] && isOU(p)) byMkt["OU"] = p;
    if (byMkt["1X2"] && byMkt["BTTS*"] && byMkt["OU"]) break;
  }
  const tCraw = Object.values(byMkt).filter(Boolean);
  // fallback: dopuni najboljima da bude 3 selekcije
  const tC = uniqByFixture(
    tCraw.length >= 3 ? tCraw : [...tCraw, ...base].slice(0, 3)
  );

  return [
    { key: "tier", title: "Ticket A — Tier prioritet", picks: tA },
    { key: "ev", title: "Ticket B — EV prioritet", picks: tB },
    { key: "mix", title: "Ticket C — Mix marketa", picks: tC },
  ].filter(t => t.picks.length >= 2); // prikaži samo ako ima smisla
}

function TicketCard({ ticket }) {
  const sumOdds = productOdds(ticket.picks);
  return (
    <div className="rounded-2xl bg-[#101427] p-4 text-slate-200 shadow flex flex-col">
      <div className="text-sm font-semibold mb-2">{ticket.title}</div>
      <div className="space-y-2 flex-1">
        {ticket.picks.map((p) => (
          <div key={p.fixture_id || p.id} className="text-sm">
            <div className="text-slate-300">
              {p?.teams?.home?.name || p?.teams?.home}{" "}
              <span className="text-slate-500">vs</span>{" "}
              {p?.teams?.away?.name || p?.teams?.away}
            </div>
            <div className="text-slate-400">
              {fmtTime(p)} • {p?.market_label || p?.market}: <b>{p?.selection}</b>{" "}
              {oddsOf(p) != null && <span>({oddsOf(p).toFixed(2)})</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 text-sm text-slate-300">
        Komb. kvota: <b>{sumOdds.toFixed(2)}</b>
      </div>
    </div>
  );
}

function TicketsBlock({ items }) {
  const tickets = useMemo(() => buildTickets(items), [items]);
  if (!tickets.length) return null;
  return (
    <div className="mb-4">
      <div className="mb-2 text-slate-300 text-sm">Predlozi tiketa (3×):</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {tickets.map((t) => (
          <TicketCard key={t.key} ticket={t} />
        ))}
      </div>
    </div>
  );
}

/* ================= History (osvežava ređe) ================= */
function HistoryList() {
  const [items, setItems] = useState([]);
  const [agg, setAgg] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/history?days=14&_=${Date.now()}`, { cache: "no-store" });
        const js = await r.json();
        if (!alive) return;
        setItems(Array.isArray(js?.items) ? js.items : []);
        setAgg(js?.aggregates || null);
      } catch {}
    };
    load();
    const t = setInterval(load, 60 * 60 * 1000); // 60min
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div className="space-y-3">
      {agg ? (
        <div className="rounded-xl bg-[#101427] p-3 text-sm text-slate-300 flex gap-6">
          <span>History — učinak</span>
          <span>7d: {agg["7d"].win_rate}% · ROI {agg["7d"].roi.toFixed(2)} (N={agg["7d"].n})</span>
          <span>14d: {agg["14d"].win_rate}% · ROI {agg["14d"].roi.toFixed(2)} (N={agg["14d"].n})</span>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="text-slate-400 text-sm">Još nema zaključanih parova u istoriji.</div>
      ) : (
        items.map((h) => {
          const ko = h?.kickoff ? new Date(h.kickoff) : null;
          const when = ko
            ? `${ko.toLocaleDateString("sv-SE")} • ${ko.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
            : "";
          const badge =
            h.won === true ? (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-emerald-600/20 text-emerald-300">✓ tačno</span>
            ) : h.won === false ? (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-rose-600/20 text-rose-300">✗ promašaj</span>
            ) : (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-slate-600/20 text-slate-300">u toku / čeka</span>
            );

          return (
            <div key={h.fixture_id} className="rounded-xl bg-[#14182a] p-3">
              <div className="text-xs text-slate-400">{when}</div>
              <div className="font-semibold">
                {h?.teams?.home} <span className="text-slate-400">vs</span> {h?.teams?.away} {badge}
              </div>
              <div className="text-sm text-slate-300">
                {h?.market}: {h?.selection} {Number.isFinite(h?.odds) ? `(${h.odds.toFixed(2)})` : ""}
              </div>
              {h?.final_score ? (
                <div className="text-xs text-slate-400">FT: {h.final_score}{h?.ht_score ? ` • HT: ${h.ht_score}` : ""}</div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

/* ================= glavni komponent ================= */
export default function FootballBets({ limit = 25, layout = "full" }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // učitaj LOCKED
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const js = await safeJson("/api/value-bets-locked?_=" + Date.now());
        const arr = Array.isArray(js?.value_bets) ? js.value_bets : [];
        if (!alive) return;
        setItems(arr);
      } catch {}
      setLoading(false);
    };
    load();
    // blagi auto-refresh da pokupi novi slot
    const t = setInterval(load, 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const listCombined = useMemo(() => {
    const filtered = filterByTime(items, layout === "combined" ? "combined" : "full");
    const sorted = [...filtered].sort((a, b) => conf(b) - conf(a) || ev(b) - ev(a));
    return sorted.slice(0, limit);
  }, [items, limit, layout]);

  if (layout === "combined") {
    // Combined tab: samo Top N po confidence (bez tiketa, bez tabova)
    return (
      <div className="grid grid-cols-1 gap-3">
        {loading && listCombined.length === 0 ? (
          <div className="text-slate-400 text-sm">Loading football…</div>
        ) : listCombined.length === 0 ? (
          <div className="text-slate-400 text-sm">Nema predloga.</div>
        ) : (
          listCombined.map((p) => <Card key={p.fixture_id || p.id} p={p} />)
        )}
      </div>
    );
  }

  // Football tab: tri taba + Tickets (3x) iznad liste u prvom i drugom tabu
  const listKick = useMemo(() => {
    const filtered = filterByTime(items, "full");
    return [...filtered].sort((a, b) => {
      const da = koDate(a), db = koDate(b);
      return (da ? +da : 0) - (db ? +db : 0);
    }).slice(0, limit);
  }, [items, limit]);

  const listConf = useMemo(() => {
    const filtered = filterByTime(items, "full");
    return [...filtered].sort((a, b) => conf(b) - conf(a) || ev(b) - ev(a)).slice(0, limit);
  }, [items, limit]);

  return (
    <Tabs defaultLabel="Kick-Off">
      <div label="Kick-Off">
        <TicketsBlock items={items} />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {loading && listKick.length === 0 ? (
            <div className="text-slate-400 text-sm">Loading…</div>
          ) : listKick.length === 0 ? (
            <div className="text-slate-400 text-sm">Nema predloga.</div>
          ) : (
            listKick.map((p) => <Card key={p.fixture_id || p.id} p={p} />)
          )}
        </div>
      </div>

      <div label="Confidence">
        <TicketsBlock items={items} />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {loading && listConf.length === 0 ? (
            <div className="text-slate-400 text-sm">Loading…</div>
          ) : listConf.length === 0 ? (
            <div className="text-slate-400 text-sm">Nema predloga.</div>
          ) : (
            listConf.map((p) => <Card key={p.fixture_id || p.id} p={p} />)
          )}
        </div>
      </div>

      <div label="History">
        <HistoryList />
      </div>
    </Tabs>
  );
}
