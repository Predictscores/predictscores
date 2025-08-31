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

function pct(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/* ---------------- football block ---------------- */
function FootballPanel({ list }) {
  if (!Array.isArray(list) || list.length === 0) {
    return <div className="text-sm text-slate-400">Nema dostupnih predloga.</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {list.map((it, idx) => (
        <FootballCard key={it.fixture_id || idx} it={it} />
      ))}
    </div>
  );
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

function FootballCard({ it }) {
  const iso = toISO(it);
  const home = sideName(it?.home || it?.teams?.home);
  const away = sideName(it?.away || it?.teams?.away);
  const league = it?.league_name || it?.league?.name || "";
  const market = it?.market_label || it?.market || "";
  const sel = it?.selection || "";
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
      {it?.explain ? (
        <div className="mt-2">
          <WhyLine explain={it.explain} />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- crypto block ---------------- */
function CryptoPanel({ list }) {
  if (!Array.isArray(list) || list.length === 0) {
    return <div className="text-sm text-slate-400">Nema kripto signala.</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {list.map((c, idx) => (
        <div key={c.symbol || idx} className="p-4 rounded-xl bg-[#1f2339]">
          <div className="text-xs text-slate-400">{c.symbol}</div>
          <div className="font-semibold">{c.name}</div>
          <div className="text-sm text-slate-200 mt-1">
            Signal: <b>{c.signal}</b> · Conf {Math.round(Number(c.confidence_pct || 0))}%
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- body ---------------- */
function CombinedBody() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [football, setFootball] = useState([]);
  const [crypto, setCrypto] = useState([]);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const slot = currentSlot();

      // locked shortlist (KV only)
      let j = await safeJson(`/api/value-bets-locked?slot=${slot}`);
      const fitems = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];

      // full feed (KV only, with light merge)
      const fb = await safeJson(`/api/football?slot=${slot}&norebuild=1`);
      const f2 = Array.isArray(fb?.football) ? fb.football : Array.isArray(fb) ? fb : [];

      const merged = [...fitems];
      for (const x of f2) {
        if (!merged.find((y) => (y.fixture_id || y.id) === (x.fixture_id || x.id))) merged.push(x);
      }
      setFootball(merged.slice(0, 15));

      const cj = await safeJson(`/api/crypto`);
      const cl = Array.isArray(cj?.signals) ? cj.signals : Array.isArray(cj) ? cj : [];
      setCrypto(cl.slice(0, 6));
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

  const top = football.slice(0, 3);
  const rest = football.slice(3);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <div className="text-sm font-semibold mb-2">Football – Top 3</div>
        <div className="space-y-3">
          {top.map((it, idx) => (
            <FootballCard key={it.fixture_id || idx} it={it} />
          ))}
        </div>
        {rest.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold mb-2">Još predloga</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {rest.map((it, idx) => (
                <FootballCard key={it.fixture_id || it.id || idx} it={it} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="text-sm font-semibold mb-2">Crypto – Top 6</div>
        <CryptoPanel list={crypto} />
      </div>
    </div>
  );
}

export default function CombinedBets() {
  return <CombinedBody />;
}
