import React, { useEffect, useMemo, useState } from "react";

async function safeJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await res.json();
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: "non-JSON", raw: text };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
function pickFootballList(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.value_bets)) return payload.value_bets;
  return [];
}
function parseKOISO(p) {
  const iso =
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.time?.starting_at?.date_time ||
    null;
  if (!iso) return null;
  return iso.replace(" ", "T");
}

export default function CombinedBets({ currentTab = "Combined", subTab = "Kick-Off" }) {
  const [football, setFootball] = useState([]);
  const [crypto, setCrypto] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [fb, cr] = await Promise.all([safeJson("/api/value-bets-locked"), safeJson("/api/crypto")]);

      if (fb?.ok === false && fb?.error) setErr(`Football feed error: ${fb.error}`);

      const list = pickFootballList(fb);
      setFootball(Array.isArray(list) ? list : []);

      const c = Array.isArray(cr?.crypto) ? cr.crypto : [];
      setCrypto(c);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const sortedFootball = useMemo(() => {
    const arr = [...football];
    if (subTab === "Confidence") {
      return arr.sort((a, b) => (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0));
    }
    if (subTab === "Kick-Off") {
      return arr.sort((a, b) => {
        const ta = new Date(parseKOISO(a) || 0).getTime();
        const tb = new Date(parseKOISO(b) || 0).getTime();
        return ta - tb;
      });
    }
    // History tab — UI placeholder (ne dira backend)
    return arr;
  }, [football, subTab]);

  if (loading) return <div className="text-slate-400 text-sm">Loading…</div>;

  const Card = ({ p }) => (
    <div
      key={p.fixture_id ?? `${p?.league?.id}-${p?.teams?.home?.name}-${p?.teams?.away?.name}`}
      className="p-4 rounded-xl bg-[#202542] mb-3 shadow"
    >
      <div className="text-xs opacity-80">
        {p?.league?.name || "League"} • {(parseKOISO(p) || "").replace("T", " ")}
      </div>
      <div className="font-semibold text-lg">
        {p?.teams?.home?.name} vs {p?.teams?.away?.name}
      </div>
      <div className="text-sm mt-1">
        {p?.market_label || p?.market} → <b>{p?.selection}</b>
        {Number.isFinite(p?.market_odds) ? <> ({p.market_odds})</> : null}
      </div>
      <div className="mt-2 text-sm">
        <span className="opacity-80">Confidence:&nbsp;</span>
        {Number.isFinite(p?.confidence_pct) ? `${p.confidence_pct}%` : "—"}
      </div>
      <div className="mt-2 h-2 bg-[#1a2138] rounded overflow-hidden">
        <div
          className="h-full bg-[#33c3aa]"
          style={{ width: `${Math.max(0, Math.min(100, p?.confidence_pct ?? 0))}%` }}
        />
      </div>
    </div>
  );

  // RENDER PO TABOVIMA
  if (currentTab === "Crypto") {
    return (
      <div>
        <h2 className="text-xl font-bold mb-2">Crypto</h2>
        {crypto.length > 0 ? (
          crypto.slice(0, 12).map((c, i) => (
            <div key={`${c?.symbol}-${i}`} className="p-3 rounded-xl bg-[#202542] mb-2 shadow">
              <div className="font-semibold">{c?.symbol}</div>
              <div className="text-sm">
                {c?.signal} @ {c?.price}{" "}
                {Number.isFinite(c?.confidence) ? <> (Conf: {c.confidence.toFixed(1)}%)</> : null}
              </div>
            </div>
          ))
        ) : (
          <div className="text-slate-400 text-sm">Nema dostupnih kripto signala.</div>
        )}
      </div>
    );
  }

  if (currentTab === "Football") {
    return (
      <div>
        <h2 className="text-xl font-bold mb-2">Football — {subTab}</h2>
        {err && <div className="mb-2 text-amber-300 text-sm">{err}</div>}
        {sortedFootball.length > 0 ? (
          sortedFootball.slice(0, 20).map((p) => <Card key={p.fixture_id ?? `${p?.league?.id}-${p?.teams?.home?.name}-${p?.teams?.away?.name}`} p={p} />)
        ) : (
          <div className="text-slate-400 text-sm">Nema dostupnih predloga.</div>
        )}
      </div>
    );
  }

  // Combined
  return (
    <div
