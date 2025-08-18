import React, { useEffect, useMemo, useState } from "react";

const TZ = "Europe/Belgrade";

function parseStartISO(item) {
  try {
    const dt =
      item?.datetime_local?.starting_at?.date_time ||
      item?.datetime_local?.date_time ||
      item?.time?.starting_at?.date_time ||
      null;
    return dt ? dt.replace(" ", "T") : null;
  } catch {
    return null;
  }
}
function kickoffTimeMs(p) {
  const iso = parseStartISO(p);
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}
function confidenceOf(p) {
  if (Number.isFinite(p?.confidence_pct)) return Number(p.confidence_pct);
  if (Number.isFinite(p?.model_prob)) return Math.round(p.model_prob * 100);
  return 0;
}
function modelLine(p) {
  const m = Math.round((p?.model_prob ?? 0) * 100);
  const imp = Math.round((p?.implied_prob ?? 0) * 100);
  const ev = Number.isFinite(p?.ev) ? (p.ev * 100).toFixed(1) : "—";
  const books = Number(p?.bookmakers_count || 0);
  return `Model ${m}% vs ${imp}% · EV ${ev}% · Bookies ${books}`;
}
function whyText(p) {
  const s = p?.explain?.summary;
  if (s && /Domaćin|Gost|Forma:|H2H/.test(s)) return s; // koristi tekst iz insights-a
  return modelLine(p); // fallback
}
function levelBadge(c) {
  if (c >= 75) return { dot: "bg-emerald-400", text: "High" };
  if (c >= 50) return { dot: "bg-sky-400", text: "Moderate" };
  return { dot: "bg-amber-400", text: "Low" };
}
// dedupe po fixture_id
function dedupeByFixture(picks) {
  const best = new Map();
  for (const p of picks || []) {
    const fid = p.fixture_id ?? p.fixture?.id;
    if (!fid) continue;
    const cur = best.get(fid);
    if (!cur) { best.set(fid, p); continue; }
    const cA = confidenceOf(p), cB = confidenceOf(cur);
    if (cA > cB) best.set(fid, p);
    else if (cA === cB) {
      const evA = Number.isFinite(p?.ev) ? p.ev : -Infinity;
      const evB = Number.isFinite(cur?.ev) ? cur.ev : -Infinity;
      if (evA > evB) best.set(fid, p);
    }
  }
  return [...best.values()];
}

export default function CombinedBets() {
  const [tab, setTab] = useState("football");
  const [sort, setSort] = useState("kickoff");
  const [data, setData] = useState({ list: [], meta: {} });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // nežni “ping” za insights (forma+H2H) – bez efekta na izgled
  useEffect(() => {
    fetch("/api/insights-build", { cache: "no-store" }).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true); setErr(null);
        const res = await fetch("/api/value-bets-locked", { cache: "no-store" });
        if (!res.ok) throw new Error(`value-bets-locked -> ${res.status}`);
        const j = await res.json();
        const raw = Array.isArray(j?.value_bets) ? j.value_bets : [];
        const deduped = dedupeByFixture(raw);
        if (alive) setData({ list: deduped, meta: j?.meta || {} });
      } catch (e) {
        if (alive) setErr(String(e?.message || e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const shown = useMemo(() => {
    let arr = [...(data.list || [])];

    if (tab === "combined") {
      arr.sort((a, b) => {
        const ca = confidenceOf(a), cb = confidenceOf(b);
        if (cb !== ca) return cb - ca;
        const ea = Number.isFinite(a?.ev) ? a.ev : -Infinity;
        const eb = Number.isFinite(b?.ev) ? b.ev : -Infinity;
        if (eb !== ea) return eb - ea;
        return kickoffTimeMs(a) - kickoffTimeMs(b);
      });
      arr = arr.slice(0, 3);
    }

    if (sort === "conf") {
      arr.sort((a, b) => {
        const ca = confidenceOf(a), cb = confidenceOf(b);
        if (cb !== ca) return cb - ca;
        const ea = Number.isFinite(a?.ev) ? a.ev : -Infinity;
        const eb = Number.isFinite(b?.ev) ? b.ev : -Infinity;
        if (eb !== ea) return eb - ea;
        return kickoffTimeMs(a) - kickoffTimeMs(b);
      });
    } else {
      arr.sort((a, b) => kickoffTimeMs(a) - kickoffTimeMs(b));
    }

    return arr;
  }, [data.list, tab, sort]);

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setTab("combined")}
          className={`px-3 py-2 rounded-full ${tab==="combined"?"bg-white/10 text-white":"bg-white/5 text-slate-300"}`}>
          Combined
        </button>
        <button type="button" onClick={() => setTab("football")}
          className={`px-3 py-2 rounded-full ${tab==="football"?"bg-white/10 text-white":"bg-white/5 text-slate-300"}`}>
          Football
        </button>
        <button type="button" disabled title="Soon"
          className={`px-3 py-2 rounded-full ${tab==="crypto"?"bg-white/10 text-white":"bg-white/5 text-slate-300"}`}>
          Crypto
        </button>
      </div>

      {/* Sort bar */}
      <div className="mt-4 flex items-center gap-3 text-sm">
        <span className="text-slate-400">Sort by:</span>
        <button type="button" onClick={() => setSort("kickoff")}
          className={`px-3 py-1.5 rounded-lg ${sort==="kickoff"?"bg-emerald-600/20 text-emerald-300":"bg-white/5 text-slate-300"}`}>
          Kickoff (Soonest)
        </button>
        <button type="button" onClick={() => setSort("conf")}
          className={`px-3 py-1.5 rounded-lg ${sort==="conf"?"bg-indigo-600/20 text-indigo-300":"bg-white/5 text-slate-300"}`}>
          Confidence (High → Low)
        </button>
      </div>

      {/* Status */}
      <div className="mt-2 text-slate-400 text-sm">
        {loading ? "Loading picks…" : `Found ${shown.length} picks`}
        {data?.meta?.source ? ` • source: ${data.meta.source}` : ""}
        {err ? ` • error: ${err}` : ""}
      </div>

      {/* Grid kartica (stil ostaje isti) */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-5">
        {shown.map((p) => {
          const c = confidenceOf(p);
          const { dot, text } = levelBadge(c);
          const iso = parseStartISO(p);
          const dt = iso
            ? new Date(iso).toLocaleString("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" })
            : "—";
          const leagueTitle = `${p?.league?.name || ""}`;
          const country = `${p?.league?.country || ""}`.replace(/-/g, " ");
          const market = p?.market_label || p?.market || "";
          const sel = p?.selection || "";
          const odds = Number.isFinite(p?.market_odds) ? p.market_odds : null;

          return (
            <div key={`${p.fixture_id}-${market}-${sel}`}
              className="rounded-2xl bg-[#121627] p-5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
              <div className="flex items-center justify-between text-sm text-slate-300">
                <div className="flex items-center gap-2">
                  <span className="opacity-80">
                    {country ? `${country} ` : ""}{leagueTitle ? `• ${leagueTitle}` : ""}
                  </span>
                  <span>• {dt}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
                  <span className="text-slate-200">{text}</span>
                </div>
              </div>

              <div className="mt-2 text-xl font-semibold text-white">
                {p?.teams?.home?.name || p?.home_name || "—"} vs{" "}
                {p?.teams?.away?.name || p?.away_name || "—"}
              </div>

              <div className="mt-1 text-slate-300">
                {market}: <span className="font-semibold">{sel}</span>
                {odds ? ` (${Number(odds).toFixed(2)})` : ""}
              </div>

              {/* ZAŠTO: koristi tekst iz insights-a + novi redovi */}
              <div className="mt-3 text-slate-300 whitespace-pre-line">
                <span className="font-semibold">Zašto:</span>{" "}
                {whyText(p)}
              </div>

              <div className="mt-4 text-slate-300">Confidence</div>
              <div className="h-3 rounded-full bg-white/10 overflow-hidden relative">
                <div className="absolute top-0 left-0 h-full bg-emerald-400"
                  style={{ width: `${Math.max(0, Math.min(100, c))}%` }} />
                <div className="absolute right-2 -top-5 text-slate-300 text-xs">{c}%</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
