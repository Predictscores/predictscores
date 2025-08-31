// components/CombinedBets.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";

const TZ = "Europe/Belgrade";
function currentSlot(tz = TZ) {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date()));
  // ispravljeno: late=00–09, am=10–14, pm=15–23
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}

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
function fmtLocal(iso, timeZone = TZ) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
function teamName(side) {
  if (!side) return "—";
  if (typeof side === "string") return side || "—";
  if (typeof side === "object") return side.name || "—";
  return "—";
}

function keyOf(it, i) {
  return (
    it?.fixture_id ||
    it?.fixture?.id ||
    `${it?.league?.id || "L"}-${it?.teams?.home?.name || it?.home}-${it?.teams?.away?.name || it?.away}-${i}`
  );
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
  const text = bullets.filter(b => !/^forma:|^h2h/i.test((b||"").trim())).slice(0, 2).join(" · ");
  const forma = (() => {
    const f = bullets.find(b => /^forma:/i.test((b||"").trim()));
    const h = bullets.find(b => /^h2h/i.test((b||"").trim()));
    let s = "";
    if (f) s += f.replace(/^forma:\s*/i, "").trim();
    if (h) s += (s ? "  " : "") + h.replace(/^h2h\s*/i, "H2H ").replace(/^h2h \(l5\):\s*/i, "H2H (L5): ").trim();
    return s ? `Forma: ${s}` : "";
  })();
  return (
    <div className="text-xs text-slate-300 space-y-1">
      {text ? <div>{text}</div> : null}
      {forma ? <div className="opacity-80">{forma}</div> : null}
    </div>
  );
}

function Card({ it }) {
  const league = it?.league?.name || "—";
  const iso = toISO(it);
  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);
  const market = it?.market_label || it?.market || "";
  const sel = it?.selection || "";
  const odds = Number.isFinite(it?.market_odds) ? it.market_odds : it?.odds;
  const conf = Number(it?.confidence_pct || 0);

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400">{league} · {fmtLocal(iso)}</div>
      <div className="font-semibold mt-0.5">
        {home} <span className="text-slate-400">vs</span> {away}
      </div>
      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{market}</span>{market ? " → " : ""}{sel}
        {Number.isFinite(odds) ? <span className="text-slate-300"> ({Number(odds).toFixed(2)})</span> : <span className="text-slate-500"> (—)</span>}
      </div>
      <div className="mt-2"><ConfidenceBar pct={conf} /></div>
      {it?.explain ? <div className="mt-2"><WhyLine explain={it.explain} /></div> : null}
    </div>
  );
}

/* ---------------- data hooks ---------------- */

function useLockedFeed() {
  const [state, setState] = useState({ items: [], built_at: null, day: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      const slot = currentSlot(TZ);
      let j = await safeJson(`/api/value-bets-locked?slot=${slot}`);
      if (!alive) return;
      if (j?.ok === false) {
        setState((s) => ({ ...s, error: j.error || "Greška", items: [] }));
        return;
      }
      let items = Array.isArray(j?.items) ? j.items
        : Array.isArray(j?.value_bets) ? j.value_bets
        : [];
      if (!items.length) {
        const fb = await safeJson(`/api/football?slot=${slot}&norebuild=1`);
        const fitems = Array.isArray(fb?.football) ? fb.football : Array.isArray(fb) ? fb : [];
        if (fitems.length) items = fitems;
      }
      const built_at = j?.built_at || j?.builtAt || null;
      const day = j?.ymd || j?.day || null;
      setState({ items, built_at, day, error: null });
    })();
    return () => { alive = false; };
  }, []);

  return state;
}

function useCryptoTop3() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const j = await safeJson(`/api/crypto`);
        if (!alive) return;
        const arr = Array.isArray(j?.signals) ? j.signals : Array.isArray(j) ? j : [];
        setItems(arr.slice(0, 3));
      } catch (e) {
        if (alive) setError(String(e?.message || e));
      }
    })();
    return () => { alive = false; };
  }, []);
  return { items, error };
}

/* ---------------- sections ---------------- */

export default function CombinedBets() {
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto
  const locked = useLockedFeed();
  const crypto = useCryptoTop3();

  function CombinedBody() {
    const list = locked.items || [];
    // **Top 3** po poverenju/model_prob za Combined (umesto pune liste)
    const top3 = [...list].sort(
      (a,b) => Number(b?.confidence_pct || b?.model_prob || 0) - Number(a?.confidence_pct || a?.model_prob || 0)
    ).slice(0, 3);

    return (
      <div className="space-y-4">
        {/* Levo: Football Top 3, Desno: History panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            {locked.error ? (
              <div className="p-4 rounded-xl bg-[#1f2339] text-red-300 text-sm">Greška: {String(locked.error)}</div>
            ) : top3.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">Trenutno nema predloga.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {top3.map((it, i) => <Card key={keyOf(it, i)} it={it} />)}
              </div>
            )}
          </div>
          <div className="lg:col-span-1">
            <HistoryPanel />
          </div>
        </div>

        {/* Donji red: Crypto Top 3 */}
        <div className="rounded-2xl bg-[#15182a] p-4">
          <div className="text-base font-semibold text-white mb-2">Crypto — Top 3</div>
          {crypto.error ? (
            <div className="text-red-300 text-sm">Greška: {String(crypto.error)}</div>
          ) : !crypto.items.length ? (
            <div className="text-slate-300 text-sm">Trenutno nema signala.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {crypto.items.map((c, i) => (
                <div key={i} className="p-3 rounded-xl bg-[#1f2339]">
                  <div className="text-sm font-semibold">{c.symbol}</div>
                  <div className="text-xs text-slate-400">{c.name}</div>
                  <div className="mt-1 text-sm">Signal: <b>{c.signal}</b> · Conf {c.confidence_pct}%</div>
                  <div className="text-xs text-slate-400">
                    1h: {Math.round((c.h1_pct ?? 0)*10)/10}% · 24h: {Math.round((c.d24_pct ?? 0)*10)/10}%
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  function FootballBody() {
    const [fTab, setFTab] = useState("ko"); // ko | conf | hist
    const list = locked.items || [];
    const koRows = useMemo(() => {
      return [...list].sort((a,b) => {
        const ta = Date.parse(a?.kickoff || a?.datetime_local?.date_time || "") || 0;
        const tb = Date.parse(b?.kickoff || b?.datetime_local?.date_time || "") || 0;
        return ta - tb;
      });
    }, [list]);
    const confRows = useMemo(() => {
      return [...list].sort((a,b) =>
        Number(b?.confidence_pct || b?.model_prob || 0) - Number(a?.confidence_pct || a?.model_prob || 0)
      );
    }, [list]);

    return (
      <div className="space-y-4">
        {/* TAB dugmad (Kick-Off / Confidence / History) */}
        <div className="flex items-center gap-2">
          <button className={`px-3 py-1.5 rounded-lg text-sm ${fTab==="ko"?"bg-[#202542] text-white":"bg-[#171a2b] text-slate-300"}`} onClick={()=>setFTab("ko")} type="button">Kick-Off</button>
          <button className={`px-3 py-1.5 rounded-lg text-sm ${fTab==="conf"?"bg-[#202542] text-white":"bg-[#171a2b] text-slate-300"}`} onClick={()=>setFTab("conf")} type="button">Confidence</button>
          <button className={`px-3 py-1.5 rounded-lg text-sm ${fTab==="hist"?"bg-[#202542] text-white":"bg-[#171a2b] text-slate-300"}`} onClick={()=>setFTab("hist")} type="button">History</button>
        </div>

        {fTab !== "hist" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {(fTab==="ko"?koRows:confRows).map((it,i)=> <Card key={keyOf(it,i)} it={it} />)}
          </div>
        ) : (
          <div className="rounded-2xl p-4 border border-neutral-800 bg-neutral-900/60 text-sm opacity-80">
            History (14d) prikaz ostaje isti — puni se iz nightly procesa.
          </div>
        )}
      </div>
    );
  }

  function CryptoBody() {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl bg-[#15182a] p-4">
          <div className="text-base font-semibold text-white mb-2">Crypto — Top 3</div>
          {crypto.items.length ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {crypto.items.map((c, i) => (
                <div key={i} className="p-3 rounded-xl bg-[#1f2339]">
                  <div className="text-sm font-semibold">{c.symbol}</div>
                  <div className="text-xs text-slate-400">{c.name}</div>
                  <div className="mt-1 text-sm">Signal: <b>{c.signal}</b> · Conf {c.confidence_pct}%</div>
                  <div className="text-xs text-slate-400">
                    1h: {Math.round((c.h1_pct ?? 0)*10)/10}% · 24h: {Math.round((c.d24_pct ?? 0)*10)/10}%
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="text-slate-300 text-sm">Trenutno nema signala.</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-2">
        {["Combined","Football","Crypto"].map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={`px-3 py-1.5 rounded-lg text-sm ${tab===name?"bg-[#202542] text-white":"bg-[#171a2b] text-slate-300"}`}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>

      {tab === "Combined" ? <CombinedBody /> : tab === "Football" ? <FootballBody /> : <CryptoBody /> }
    </div>
  );
}
