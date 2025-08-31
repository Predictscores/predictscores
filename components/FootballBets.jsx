// components/FootballBets.jsx
"use client";

import React, { useEffect, useState } from "react";

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

function toISO(x) {
  return (
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff ||
    null
  );
}

function fmtLocal(iso, tz = TZ) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + "Z");
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
  return f.format(d);
}

function sideName(side) {
  if (typeof side === "string") return side;
  if (typeof side === "object") return side.name || "—";
  return "—";
}

function ConfidenceBar({ pct }) {
  const v = Math.max(0, Math.min(100, Number(pct || 0)));
  return (
    <div className="h-2 w-full rounded bg-[#2a2f4a] overflow-hidden">
      <div className="h-2 rounded bg-[#4f6cf7]" style={{ width: `${v}%` }} />
    </div>
  );
}

function Card({ it }) {
  const iso = toISO(it);
  const home = sideName(it?.home || it?.teams?.home);
  const away = sideName(it?.away || it?.teams?.away);
  const league = it?.league_name || it?.league?.name || "";
  const sel = it?.selection || "";
  const market = it?.market_label || it?.market || "1X2";
  const odds = Number.isFinite(it?.market_odds) ? it.market_odds : it?.odds;
  const conf = Number(it?.confidence_pct || 0);

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400">
        {league} · {fmtLocal(iso)}
      </div>
      <div className="font-semibold mt-0.5">
        {home} <span className="text-slate-400">vs</span> {away}
      </div>
      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{market}</span>
        {market ? " → " : ""}
        {sel}
        {Number.isFinite(odds) ? (
          <span className="text-slate-300"> ({Number(odds).toFixed(2)})</span>
        ) : (
          <span className="text-slate-500"> (—)</span>
        )}
      </div>
      <div className="mt-2">
        <ConfidenceBar pct={conf} />
      </div>
    </div>
  );
}

export default function FootballBets() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [items, setItems] = useState([]);

  async function load() {
    try {
      setLoading(true);
      setErr(null);
      const slot = currentSlot();

      // puni punu listu iz KV (bez spoljnog API-ja)
      const fb = await safeJson(`/api/football?slot=${slot}&norebuild=1`);
      const full = Array.isArray(fb?.football) ? fb.football : Array.isArray(fb) ? fb : [];

      // fallback na locked shortlist iz KV, ako nema full
      if (full.length > 0) {
        setItems(full);
      } else {
        const j = await safeJson(`/api/value-bets-locked?slot=${slot}`);
        const locked = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
        setItems(locked);
      }
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) return <div className="text-sm text-slate-400">Učitavam…</div>;
  if (err) return <div className="text-sm text-red-400">Greška: {err}</div>;
  if (!items.length) return <div className="text-sm text-slate-400">Nema predloga.</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {items.map((it, idx) => (
        <Card key={it.fixture_id || idx} it={it} />
      ))}
    </div>
  );
}
