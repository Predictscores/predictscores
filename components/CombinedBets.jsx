// components/CombinedBets.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";

const TZ = "Europe/Belgrade";

// late = 00:00–09:59, am = 10:00–14:59, pm = 15:00–23:59
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

/* ---------------- helpers ---------------- */

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try {
      return JSON.parse(t);
    } catch {
      return { ok: false, error: "non-JSON", raw: t };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
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
  // većina feed-ova šalje "YYYY-MM-DD HH:mm"
  const s = iso.includes("T") ? iso : iso.replace(" ", "T");
  // tretiramo kao UTC ako nema zone
  return new Date(s + (s.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s) ? "" : "Z"));
}

function fmtLocal(date, tz = TZ) {
  if (!date) return "—";
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
  return f.format(date);
}

function teamName(side) {
  if (!side) return "—";
  if (typeof side === "string") return side || "—";
  if (typeof side === "object") return side.name || side.team || "—";
  return "—";
}

function normalizeBet(it) {
  const league =
    it?.league_name || it?.league?.name || it?.league || it?.competition || "";
  const date = parseKickoff(it);

  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);

  const market = it?.market_label || it?.market || "1X2";
  const sel =
    it?.selection_label ||
    it?.pick ||
    it?.selection ||
    (it?.pick_code === "1"
      ? "Home"
      : it?.pick_code === "2"
      ? "Away"
      : it?.pick_code === "X"
      ? "Draw"
      : "");

  let odds =
    typeof it?.odds === "object" && it?.odds
      ? Number(it.odds.price)
      : Number(it?.market_odds ?? it?.odds);
  odds = Number.isFinite(odds) ? odds : null;

  let conf = Number(
    it?.confidence_pct ??
      (typeof it?.model_prob === "number"
        ? it.model_prob <= 1
          ? it.model_prob * 100
          : it.model_prob
        : 0)
  );
  conf = Number.isFinite(conf) ? Math.max(0, Math.min(100, conf)) : 0;

  return {
    id:
      it?.fixture_id ??
      it?.fixture?.id ??
      `${home}-${away}-${Date.parse(date || new Date())}`,
    league,
    date,
    home,
    away,
    market,
    sel,
    odds,
    conf,
    explain: it?.explain,
  };
}

function ConfidenceBar({ pct }) {
  const v = Math.max(0, Math.min(100, Number(pct || 0)));
  return (
    <div className="h-2 w-full rounded bg-[#2a2f4a] overflow-hidden">
      <div className="h-2 rounded bg-[#4f6cf7]" style={{ width: `${v}%` }} />
    </div>
  );
}

function WhyLine({ explain }) {
  const bullets = Array.isArray(explain?.bullets) ? explain.bullets : [];
  const text = bullets
    .filter((b) => !/^forma:|^h2h/i.test((b || "").trim()))
    .slice(0, 2)
    .join(" · ");
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

function FootballCard({ bet }) {
  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400">
        {bet.league} · {fmtLocal(bet.date)}
      </div>
      <div className="font-semibold mt-0.5">
        {bet.home} <span className="text-slate-400">vs</span> {bet.away}
      </div>
      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{bet.market}</span>
        {bet.market ? " → " : ""}
        {bet.sel || "—"}
        {bet.odds ? (
          <span className="text-slate-300"> ({bet.odds.toFixed(2)})</span>
        ) : (
          <span className="text-slate-500"> (—)</span>
        )}
      </div>
      <div className="mt-2">
        <ConfidenceBar pct={bet.conf} />
      </div>
      {bet.explain ? (
        <div className="mt-2">
          <WhyLine explain={bet.explain} />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- crypto block (ostaje isto, Top 3) ---------------- */
function CryptoPanel({ list }) {
  if (!Array.isArray(list) || list.length === 0) {
    return <div className="text-sm text-slate-400">Trenutno nema kripto signala.</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {list.map((c, idx) => (
        <div key={c.symbol || idx} className="p-4 rounded-xl bg-[#1f2339]">
          <div className="text-sm font-semibold">{c.symbol}</div>
          <div className="text-xs text-slate-400">{c.name}</div>
          <div className="mt-1 text-sm">
            Signal: <b>{c.signal}</b> · Conf {Math.round(Number(c.confidence_pct || 0))}%
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- body ---------------- */
export default function CombinedBets() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [football, setFootball] = useState([]);
  const [crypto, setCrypto] = useState([]);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const slot = currentSlot();

      const j = await safeJson(`/api/value-bets-locked?slot=${slot}&n=50`);
      const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
      const fbets = arr.map(normalizeBet).filter((b) => b.sel || b.odds || b.conf);

      const cj = await safeJson(`/api/crypto`);
      const cl = Array.isArray(cj?.signals) ? cj.signals : Array.isArray(cj) ? cj : [];

      // Combined prikazuje Top 3 football + Top 3 crypto
      const topF = [...fbets].sort((a, b) => b.conf - a.conf).slice(0, 3);
      const topC = cl.slice(0, 3);

      setFootball(topF);
      setCrypto(topC);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) return <div className="text-sm text-slate-400">Učitavam…</div>;
  if (error) return <div className="text-sm text-red-400">Greška: {error}</div>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        <div className="text-sm font-semibold mb-2">Football — Top 3</div>
        {football.length === 0 ? (
          <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">Trenutno nema predloga.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {football.map((b) => (
              <FootballCard key={b.id} bet={b} />
            ))}
          </div>
        )}
      </div>
      <div className="lg:col-span-1">
        <HistoryPanel />
        <div className="mt-4">
          <div className="text-sm font-semibold mb-2">Crypto — Top 3</div>
          <CryptoPanel list={crypto} />
        </div>
      </div>
    </div>
  );
}
