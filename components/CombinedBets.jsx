// components/CombinedBets.jsx
// Prvo koristi zaključani slot (/api/value-bets-locked), pa fallback na /api/football?hours=24.
// History vuče /api/history?days=14 (presuđeno). Crypto ostaje kao i ranije.

import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";

const TZ = "Europe/Belgrade";

/* ------------ helpers ------------ */
async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok:false, error:"non-JSON", raw:t }; }
  } catch (e) { return { ok:false, error:String(e?.message || e) }; }
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
function parseStartISO(item) {
  const iso = toISO(item);
  return iso ? iso.replace(" ", "T") : null;
}
function fmtWhen(item) {
  const iso = parseStartISO(item);
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}
function scoreFootball(x) {
  const edge = Number(x?.edge_pp) || 0;
  const ev   = Number(x?.ev_pct) || 0;
  const conf = Number(x?.confidence_pct) || 0;
  return edge * 60 + ev * 40 + conf;
}
function byKickoffAsc(a, b) {
  const ta = new Date(parseStartISO(a) || 0).getTime();
  const tb = new Date(parseStartISO(b) || 0).getTime();
  return ta - tb;
}

/* ------------ component ------------ */
export default function CombinedBets({
  initialFootball = [],
  initialCrypto = [],
}) {
  const [tab, setTab] = useState("Combined");     // Combined | Football | Crypto
  const [subTab, setSubTab] = useState("Kick-Off"); // Kick-Off | Confidence | History

  const [football, setFootball] = useState(Array.isArray(initialFootball) ? initialFootball : []);
  const [crypto, setCrypto] = useState(Array.isArray(initialCrypto) ? initialCrypto : []);
  const [history, setHistory] = useState([]);

  const [loading, setLoading] = useState({ fb:true, cr:true, hist:true });

  // FOOTBALL: 1) locked slot, 2) fallback na live 24h
  useEffect(() => {
    let stop = false;
    (async () => {
      // 1) locked feed
      const locked = await safeJson("/api/value-bets-locked");
      if (stop) return;
      const lockedList = Array.isArray(locked?.items || locked?.value_bets) ? (locked.items || locked.value_bets) : [];
      if (lockedList.length > 0) {
        setFootball(lockedList);
        setLoading(s => ({ ...s, fb:false }));
        return;
      }
      // 2) fallback na live širi prozor
      const live = await safeJson("/api/football?hours=24");
      if (stop) return;
      const arr = Array.isArray(live?.football) ? live.football : [];
      setFootball(arr);
      setLoading(s => ({ ...s, fb:false }));
    })();
    return () => { stop = true; };
  }, []);

  // CRYPTO
  useEffect(() => {
    let stop = false;
    (async () => {
      const r = await safeJson("/api/crypto");
      if (stop) return;
      const arr =
        Array.isArray(r?.signals) ? r.signals :
        Array.isArray(r?.data?.signals) ? r.data.signals :
        Array.isArray(r) ? r : [];
      setCrypto(arr);
      setLoading(s => ({ ...s, cr:false }));
    })();
    return () => { stop = true; };
  }, []);

  // HISTORY — presuđeni rezultati (14 dana)
  useEffect(() => {
    let stop = false;
    (async () => {
      let h = await safeJson("/api/history?days=14");
      if (stop) return;
      // dozvoli i oblike: {history:[...]}, {items:[...]}, direktno []
      const list =
        Array.isArray(h) ? h :
        Array.isArray(h?.history) ? h.history :
        Array.isArray(h?.items) ? h.items :
        Array.isArray(h?.value_bets) ? h.value_bets : [];
      setHistory(list);
      setLoading(s => ({ ...s, hist:false }));
    })();
    return () => { stop = true; };
  }, []);

  // DERIVED
  const fbByConfidence = useMemo(() => [...football].sort((a,b)=>scoreFootball(b)-scoreFootball(a)), [football]);
  const fbByKickoff = useMemo(() => [...football].sort(byKickoffAsc), [football]);
  const fbTop3 = useMemo(() => fbByConfidence.slice(0,3), [fbByConfidence]);

  // UI helpers
  function Tabs() {
    return (
      <div className="flex gap-3">
        {["Combined","Football","Crypto"].map(t => (
          <button key={t} onClick={()=>setTab(t)}
            className={"px-4 py-2 rounded-xl " + (tab===t ? "bg-white text-black font-semibold" : "bg-white/10 text-white")}
            type="button">{t}</button>
        ))}
      </div>
    );
  }
  function SubTabs() {
    if (tab!=="Football") return null;
    return (
      <div className="mt-4 flex gap-3">
        {["Kick-Off","Confidence","History"].map(t => (
          <button key={t} onClick={()=>setSubTab(t)}
            className={"px-4 py-2 rounded-xl " + (subTab===t ? "bg-white text-black font-semibold" : "bg-white/10 text-white")}
            type="button">{t==="History" ? "History (14d)" : t}</button>
        ))}
      </div>
    );
  }
  function FootballCard({ x }) {
    const when = fmtWhen(x);
    const league = x?.league?.name || "";
    const h = x?.teams?.home?.name || x?.teams?.home || "";
    const a = x?.teams?.away?.name || x?.teams?.away || "";
    const pick = x?.selection || "";
    const conf = Number.isFinite(x?.confidence_pct) ? x.confidence_pct : null;
    const edge = Number.isFinite(x?.edge_pp) ? x.edge_pp : null;
    const ev   = Number.isFinite(x?.ev_pct) ? x.ev_pct : null;

    return (
      <div className="rounded-2xl bg-white/5 border border-white/10 p-4">
        <div className="text-xs text-white/60">{league}</div>
        <div className="text-sm font-semibold truncate">{h} — {a}</div>
        {when ? <div className="text-xs text-white/60">{when}</div> : null}
        <div className="mt-2 flex items-center justify-between text-sm">
          <div className="font-semibold">{pick}</div>
          <div className="text-right text-xs text-white/80">
            {conf !== null ? <div>Conf: {conf}%</div> : null}
            {edge !== null ? <div>Edge: {edge}pp</div> : null}
            {ev !== null   ? <div>EV: {ev}%</div> : null}
          </div>
        </div>
      </div>
    );
  }
  function CryptoCard({ c }) {
    return (
      <div className="rounded-2xl bg-white/5 border border-white/10 p-4">
        <div className="text-sm font-semibold">{c?.symbol || c?.name}</div>
        <div className="text-xs text-white/60">{c?.name || ""}</div>
        <div className="mt-2 flex items-center justify-between text-sm">
          <div className="font-semibold">{c?.signal}</div>
          <div className="text-right text-xs text-white/80">
            {Number.isFinite(c?.confidence_pct) ? <div>Conf: {c.confidence_pct}%</div> : null}
            {Number.isFinite(c?.price) ? <div>${c.price}</div> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Tabs />
      <SubTabs />

      <div className="mt-6">
        {tab === "Combined" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="mb-2 text-sm text-white/70">Football — Top 3 (locked → live)</div>
              {loading.fb ? <div className="text-slate-400 text-sm">Loading…</div> :
               football.length===0 ? <div className="text-slate-400 text-sm">Nema podataka.</div> :
               <div className="grid gap-3">{fbTop3.map((x,i)=><FootballCard key={x?.fixture_id || i} x={x} />)}</div>}
            </div>

            <div>
              <div className="mb-2 text-sm text-white/70">Crypto — Top 3</div>
              {loading.cr ? <div className="text-slate-400 text-sm">Loading…</div> :
               crypto.length===0 ? <div className="text-slate-400 text-sm">Nema podataka.</div> :
               <div className="grid gap-3">{crypto.slice(0,3).map((c,i)=><CryptoCard key={c?.symbol || i} c={c} />)}</div>}
            </div>
          </div>
        )}

        {tab === "Football" && (
          <>
            {subTab === "Kick-Off" && (
              <div className="grid gap-3">
                {loading.fb ? <div className="text-slate-400 text-sm">Loading…</div> :
                 football.length===0 ? <div className="text-slate-400 text-sm">Nema podataka.</div> :
                 fbByKickoff.map((x,i)=><FootballCard key={x?.fixture_id || i} x={x} />)}
              </div>
            )}
            {subTab === "Confidence" && (
              <div className="grid gap-3">
                {loading.fb ? <div className="text-slate-400 text-sm">Loading…</div> :
                 football.length===0 ? <div className="text-slate-400 text-sm">Nema podataka.</div> :
                 fbByConfidence.map((x,i)=><FootballCard key={x?.fixture_id || i} x={x} />)}
              </div>
            )}
            {subTab === "History" && (
              <HistoryPanel history={history} />
            )}
          </>
        )}

        {tab === "Crypto" && (
          <div className="grid gap-3">
            {loading.cr ? <div className="text-slate-400 text-sm">Loading…</div> :
             crypto.length===0 ? <div className="text-slate-400 text-sm">Nema podataka.</div> :
             crypto.map((c,i)=><CryptoCard key={c?.symbol || i} c={c} />)}
          </div>
        )}
      </div>
    </div>
  );
  }
