// components/CombinedBets.jsx
// Drop-in: povezuje UI na /api/football i /api/crypto (relativno, HTTPS-safe), bez promene izgleda.

import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";

const TZ = "Europe/Belgrade";

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
function parseStartISO(item) {
  const iso = toISO(item);
  return iso ? iso.replace(" ", "T") : null;
}
function fmtWhen(item) {
  const iso = parseStartISO(item);
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch { return iso; }
}
function nearestFutureKickoff(items = []) {
  const now = Date.now();
  let best = null;
  for (const it of items) {
    const iso = parseStartISO(it);
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isFinite(t) && t > now) {
      if (!best || t < best) best = t;
    }
  }
  return best ? new Date(best).toISOString() : null;
}
function scoreFootball(x) {
  // Kompozit za rangiranje: edge i EV imaju prioritet, pa confidence.
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

/* ---------------- component ---------------- */

export default function CombinedBets({
  initialFootball = [],
  initialCrypto = [],
}) {
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto
  const [subTab, setSubTab] = useState("Kick-Off"); // Kick-Off | Confidence | History
  const [football, setFootball] = useState(Array.isArray(initialFootball) ? initialFootball : []);
  const [crypto, setCrypto] = useState(Array.isArray(initialCrypto) ? initialCrypto : []);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState({ fb: football.length === 0, cr: crypto.length === 0, hist: true });
  const [err, setErr] = useState({ fb: null, cr: null });

  // Fetch FOOTBALL (relativno, HTTPS-safe)
  useEffect(() => {
    let stop = false;
    (async () => {
      if (football.length > 0) { setLoading(s => ({ ...s, fb: false })); return; }
      setLoading(s => ({ ...s, fb: true }));
      const r = await safeJson("/api/football?hours=4");
      if (stop) return;
      if (r && r.ok !== false && Array.isArray(r?.football)) {
        setFootball(r.football);
        setErr(s => ({ ...s, fb: null }));
      } else {
        setErr(s => ({ ...s, fb: r?.error || "football fetch failed" }));
      }
      setLoading(s => ({ ...s, fb: false }));
    })();
    return () => { stop = true; };
  }, []); // jednom

  // Fetch CRYPTO (relativno)
  useEffect(() => {
    let stop = false;
    (async () => {
      if (crypto.length > 0) { setLoading(s => ({ ...s, cr: false })); return; }
      setLoading(s => ({ ...s, cr: true }));
      const r = await safeJson("/api/crypto");
      if (stop) return;
      if (r && r.ok !== false && Array.isArray(r?.signals)) {
        setCrypto(r.signals);
        setErr(s => ({ ...s, cr: null }));
      } else {
        setErr(s => ({ ...s, cr: r?.error || "crypto fetch failed" }));
      }
      setLoading(s => ({ ...s, cr: false }));
    })();
    return () => { stop = true; };
  }, []);

  // Fetch HISTORY (zaključani dnevni feed)
  useEffect(() => {
    let stop = false;
    (async () => {
      const r = await safeJson("/api/value-bets-locked");
      if (stop) return;
      const list = Array.isArray(r?.items || r?.value_bets) ? (r.items || r.value_bets) : [];
      setHistory(list);
      setLoading(s => ({ ...s, hist: false }));
    })();
    return () => { stop = true; };
  }, []);

  // Derived lists
  const fbByConfidence = useMemo(() => {
    return [...football].sort((a, b) => scoreFootball(b) - scoreFootball(a));
  }, [football]);

  const fbByKickoff = useMemo(() => {
    return [...football].sort(byKickoffAsc);
  }, [football]);

  const fbTop3 = useMemo(() => fbByConfidence.slice(0, 3), [fbByConfidence]);
  const crTop3 = useMemo(() => {
    const arr = Array.isArray(crypto) ? crypto : [];
    return [...arr].sort((a, b) => (b?.confidence_pct || 0) - (a?.confidence_pct || 0)).slice(0, 3);
  }, [crypto]);

  const nextKick = useMemo(() => nearestFutureKickoff(football), [football]);

  /* ---------------- UI helpers ---------------- */

  function Tabs() {
    return (
      <div className="flex gap-3">
        {["Combined", "Football", "Crypto"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "px-4 py-2 rounded-xl " +
              (tab === t ? "bg-white text-black font-semibold" : "bg-white/10 text-white")
            }
            type="button"
          >
            {t}
          </button>
        ))}
      </div>
    );
  }

  function SubTabs() {
    if (tab !== "Football") return null;
    return (
      <div className="mt-4 flex gap-3">
        {["Kick-Off", "Confidence", "History"].map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={
              "px-4 py-2 rounded-xl " +
              (subTab === t ? "bg-white text-black font-semibold" : "bg-white/10 text-white")
            }
            type="button"
          >
            {t === "History" ? "History (14d)" : t}
          </button>
        ))}
      </div>
    );
  }

  function FootballCard({ x }) {
    const when = fmtWhen(x);
    const league = x?.league?.name || "";
    const h = x?.teams?.home || x?.teams?.home?.name || "";
    const a = x?.teams?.away || x?.teams?.away?.name || "";
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

  /* ---------------- RENDER ---------------- */

  return (
    <div>
      {/* Top tabs */}
      <Tabs />

      {/* Football sub-tabs (only in Football) */}
      <SubTabs />

      {/* Content */}
      <div className="mt-6">
        {tab === "Combined" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="mb-2 text-sm text-white/70">Football — Top 3</div>
              {loading.fb && football.length === 0 ? (
                <div className="text-slate-400 text-sm">Loading…</div>
              ) : football.length === 0 ? (
                <div className="text-slate-400 text-sm">Nema podataka.</div>
              ) : (
                <div className="grid gap-3">
                  {fbTop3.map((x, i) => <FootballCard key={x.fixture_id || i} x={x} />)}
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 text-sm text-white/70">Crypto — Top 3</div>
              {loading.cr && crypto.length === 0 ? (
                <div className="text-slate-400 text-sm">Loading…</div>
              ) : crypto.length === 0 ? (
                <div className="text-slate-400 text-sm">Nema podataka.</div>
              ) : (
                <div className="grid gap-3">
                  {crTop3.map((c, i) => <CryptoCard key={c?.symbol || i} c={c} />)}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "Football" && (
          <>
            {subTab === "Kick-Off" && (
              <div className="grid gap-3">
                {loading.fb && football.length === 0 ? (
                  <div className="text-slate-400 text-sm">Loading…</div>
                ) : football.length === 0 ? (
                  <div className="text-slate-400 text-sm">Nema podataka.</div>
                ) : (
                  fbByKickoff.map((x, i) => <FootballCard key={x.fixture_id || i} x={x} />)
                )}
              </div>
            )}

            {subTab === "Confidence" && (
              <div className="grid gap-3">
                {loading.fb && football.length === 0 ? (
                  <div className="text-slate-400 text-sm">Loading…</div>
                ) : football.length === 0 ? (
                  <div className="text-slate-400 text-sm">Nema podataka.</div>
                ) : (
                  fbByConfidence.map((x, i) => <FootballCard key={x.fixture_id || i} x={x} />)
                )}
              </div>
            )}

            {subTab === "History" && (
              <HistoryPanel history={history} />
            )}
          </>
        )}

        {tab === "Crypto" && (
          <div className="grid gap-3">
            {loading.cr && crypto.length === 0 ? (
              <div className="text-slate-400 text-sm">Loading…</div>
            ) : crypto.length === 0 ? (
              <div className="text-slate-400 text-sm">Nema podataka.</div>
            ) : (
              crypto.map((c, i) => <CryptoCard key={c?.symbol || i} c={c} />)
            )}
          </div>
        )}
      </div>

      {/* Optional: next kickoff info for debugging */}
      <div className="mt-6 text-xs text-white/50">
        {nextKick ? `Next kickoff: ${new Date(nextKick).toLocaleString("sv-SE", { timeZone: TZ })}` : "Next kickoff: —"}
      </div>
    </div>
  );
}
