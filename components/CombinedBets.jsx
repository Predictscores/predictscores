import React, { useEffect, useState } from "react";

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
  // podržava i stari i novi format
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.value_bets)) return payload.value_bets;
  return [];
}

export default function CombinedBets() {
  const [football, setFootball] = useState([]);
  const [crypto, setCrypto] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [fb, cr] = await Promise.all([safeJson("/api/value-bets-locked"), safeJson("/api/crypto")]);

      if (fb?.ok === false && fb?.error) {
        setErr(`Football feed error: ${fb.error}`);
      }

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

  if (loading) return <div className="text-slate-400 text-sm">Loading…</div>;

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <h2 className="text-xl font-bold mb-2">Football predictions</h2>
        {err && (
          <div className="mb-2 text-amber-300 text-sm">
            {err}
          </div>
        )}
        {football.length > 0 ? (
          football.slice(0, 8).map((p) => (
            <div key={p.fixture_id ?? `${p?.league?.id}-${p?.teams?.home?.name}-${p?.teams?.away?.name}`}
                 className="p-3 rounded-xl bg-[#202542] mb-2 shadow">
              <div className="font-semibold">
                {p?.teams?.home?.name} vs {p?.teams?.away?.name}
              </div>
              <div className="text-sm opacity-80">
                {(p?.league?.name || "League")} • {(p?.datetime_local?.starting_at?.date_time || "").replace("T", " ")}
              </div>
              <div className="text-sm mt-1">
                {p?.market_label || p?.market} → <b>{p?.selection}</b>
                {Number.isFinite(p?.market_odds) ? <> @ {p.market_odds}</> : null}
              </div>
            </div>
          ))
        ) : (
          <div className="text-slate-400 text-sm">Nema dostupnih predloga.</div>
        )}
      </div>

      <div>
        <h2 className="text-xl font-bold mb-2">Crypto signals</h2>
        {crypto.length > 0 ? (
          crypto.slice(0, 8).map((c, i) => (
            <div key={`${c?.symbol}-${i}`} className="p-3 rounded-xl bg-[#202542] mb-2 shadow">
              <div className="font-semibold">{c?.symbol}</div>
              <div className="text-sm">
                {c?.signal} @ {c?.price}{" "}
                {Number.isFinite(c?.confidence) ? (
                  <> (Conf: {c.confidence.toFixed(1)}%)</>
                ) : null}
              </div>
            </div>
          ))
        ) : (
          <div className="text-slate-400 text-sm">Nema dostupnih kripto signala.</div>
        )}
      </div>
    </div>
  );
            }
