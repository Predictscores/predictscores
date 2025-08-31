// components/FootballBets.jsx
"use client";

import { useEffect, useMemo, useState } from "react";

const TZ = "Europe/Belgrade";
function currentSlot(tz = TZ){
  const h = Number(new Intl.DateTimeFormat("en-GB",{hour:"2-digit",hour12:false,timeZone:tz}).format(new Date()));
  // ispravljeno: late=00–09, am=10–14, pm=15–23
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}

/* ===================== data ===================== */
function useLockedValueBets() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const slot = currentSlot(TZ);
      const r = await fetch(`/api/value-bets-locked?slot=${slot}`, { cache: "no-store" });
      const ct = r.headers.get("content-type") || "";
      const body = ct.includes("application/json")
        ? await r.json()
        : await r.text().then((t) => {
            try { return JSON.parse(t); } catch { return { ok: false, error: "non-JSON" }; }
          });

      let arr = Array.isArray(body?.items) ? body.items
        : Array.isArray(body?.value_bets) ? body.value_bets
        : [];

      if (!arr.length){
        const r2 = await fetch(`/api/football?slot=${slot}&norebuild=1`, { cache: "no-store" });
        const ct2 = r2.headers.get("content-type") || "";
        const j2 = ct2.includes("application/json") ? await r2.json() : {};
        arr = Array.isArray(j2?.football) ? j2.football : Array.isArray(j2) ? j2 : [];
      }
      setItems(arr);
    } catch (e) {
      setError(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);
  return { items, loading, error, reload: load };
}

/* ===================== helpers ===================== */
function getKOISO(p) {
  return (
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.time?.starting_at?.date_time ||
    p?.kickoff ||
    null
  );
}
function parseKOms(p) {
  const iso = getKOISO(p);
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}
function koCET(p, tz = TZ) {
  const t = parseKOms(p);
  if (!t) return "";
  const d = new Date(t);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
function pct(x) {
  if (!Number.isFinite(x)) return null;
  const v = x > 1 ? x : x * 100;
  return Math.round(v * 10) / 10;
}
function teamName(side) {
  if (!side) return "—";
  if (typeof side === "string") return side || "—";
  if (typeof side === "object") return side.name || "—";
  return "—";
}
function whyText2lines(p) {
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const whyList = bullets.filter((b) => !/^forma:|^h2h/i.test((b || "").trim()));
  const zasto = whyList.slice(0, 2).join(" · ");
  const formaLine = bullets.find((b) => /^forma:/i.test((b || "").trim())) || null;
  const h2hLine = bullets.find((b) => /^h2h/i.test((b || "").trim())) || null;

  const parts = [];
  if (zasto) parts.push(zasto);
  const extras = [];
  if (formaLine) extras.push(formaLine.replace(/^forma:\s*/i, "").trim());
  if (h2hLine)  extras.push(h2hLine.replace(/^h2h\s*/i, "H2H ").replace(/^h2h \(l5\):\s*/i, "H2H (L5): ").trim());
  if (extras.length) parts.push(`Forma: ${extras.join("  ")}`);
  return parts.join("\n");
}

/* ===================== UI ===================== */
function Row({ p }) {
  const iso = getKOISO(p);
  const home = teamName(p?.teams?.home || p?.home);
  const away = teamName(p?.teams?.away || p?.away);
  const market = p?.market_label || p?.market || "1X2";
  const sel = p?.selection || "";
  const odds = Number.isFinite(p?.market_odds) ? p.market_odds : p?.odds;
  const conf = Number(p?.confidence_pct || 0);

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400">{koCET(p)}</div>
      <div className="font-semibold mt-0.5">
        {home} <span className="text-slate-400">vs</span> {away}
      </div>
      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{market}</span>{market ? " → " : ""}{sel}
        {Number.isFinite(odds) ? <span className="text-slate-300"> ({Number(odds).toFixed(2)})</span> : <span className="text-slate-500"> (—)</span>}
      </div>
      <div className="mt-2">
        <div className="h-2 w-full rounded bg-[#2a2f4a] overflow-hidden">
          <div className="h-2 rounded bg-[#4f6cf7]" style={{ width: `${Math.max(0,Math.min(100,conf))}%` }} />
        </div>
      </div>
      <div className="mt-2 text-xs text-slate-300 whitespace-pre-line">
        {whyText2lines(p)}
      </div>
    </div>
  );
}

function Section({ title, rows = [] }) {
  return (
    <div className="rounded-2xl bg-[#15182a] p-4">
      <div className="text-base font-semibold text-white mb-3">{title}</div>
      {!rows.length ? (
        <div className="text-slate-400 text-sm">Trenutno nema predloga.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {rows.map((p, i) => <Row key={`${p?.fixture_id ?? p?.id ?? i}-${i}`} p={p} />)}
        </div>
      )}
    </div>
  );
}

/* ===================== page ===================== */
export default function FootballBets() {
  const { items, loading, error } = useLockedValueBets();
  const [tab, setTab] = useState("ko"); // ko | conf | hist

  const koRows = useMemo(() => {
    return [...items].sort((a,b) => (parseKOms(a) ?? 9e15) - (parseKOms(b) ?? 9e15));
  }, [items]);
  const confRows = useMemo(() => {
    return [...items].sort((a,b) =>
      (Number(b?.confidence_pct || b?.model_prob || 0)) - (Number(a?.confidence_pct || a?.model_prob || 0))
    );
  }, [items]);

  return (
    <div className="space-y-4">
      {/* TAB dugmad */}
      <div className="flex items-center gap-2">
        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab==="ko"?"bg-[#202542] text-white":"bg-[#171a2b] text-slate-300"}`} onClick={()=>setTab("ko")} type="button">Kick-Off</button>
        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab==="conf"?"bg-[#202542] text-white":"bg-[#171a2b] text-slate-300"}`} onClick={()=>setTab("conf")} type="button">Confidence</button>
        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab==="hist"?"bg-[#202542] text-white":"bg-[#171a2b] text-slate-300"}`} onClick={()=>setTab("hist")} type="button">History</button>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm">Učitavam…</div>
      ) : error ? (
        <div className="text-red-400 text-sm">Greška: {String(error)}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            {tab === "ko" && <Section title="Kick-Off" rows={koRows} />}
            {tab === "conf" && <Section title="Confidence" rows={confRows} />}
            {tab === "hist" && (
              <div className="rounded-2xl p-4 border border-neutral-800 bg-neutral-900/60 text-sm opacity-80">
                History (14d) prikaz ostaje isti — puni se iz nightly procesa.
              </div>
            )}
          </div>
          <div className="lg:col-span-1">
            {/* desni panel može ostati tvoj, ako ga koristiš */}
          </div>
        </div>
      )}
    </div>
  );
}
