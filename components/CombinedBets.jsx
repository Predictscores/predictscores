import React, { useEffect, useMemo, useState } from "react";

/** Helpers */
async function j(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
function kickoffMs(p) {
  const raw =
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.time?.starting_at?.date_time ||
    "";
  const t = Date.parse(String(raw).replace(" ", "T"));
  return Number.isFinite(t) ? t : Infinity;
}
function fmtKick(p, tz = "Europe/Belgrade") {
  const t = kickoffMs(p);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString("sv-SE", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
}
function confPct(p) {
  const c =
    typeof p?.confidence_pct === "number"
      ? p.confidence_pct
      : Math.round((Number(p?.model_prob || 0) || 0) * 100);
  return Math.max(0, Math.min(100, c));
}
function confLabel(c) {
  if (c >= 75) return { label: "High", dot: "bg-emerald-400" };
  if (c >= 50) return { label: "Moderate", dot: "bg-sky-400" };
  return { label: "Low", dot: "bg-amber-400" };
}
function uniqByFixture(list) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const id = x?.fixture_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(x);
  }
  return out;
}
function categoryOf(p) {
  const m = String(p?.market_label || p?.market || "");
  if (/btts/i.test(m)) return "BTTS";
  if (/over|under|ou/i.test(m)) return "OU";
  if (/ht-?ft|ht\/ft/i.test(m)) return "HT-FT";
  if (/1x2|match winner/i.test(m)) return "1X2";
  return "OTHER";
}

/** Main component */
export default function CombinedBets() {
  const [tab, setTab] = useState("combined"); // combined | football | crypto
  const [sortKey, setSortKey] = useState("kickoff"); // kickoff | confidence
  const [fb, setFb] = useState({ list: [], meta: {}, loading: true, err: null });
  const [fbTop3, setFbTop3] = useState({ list: [], loading: true });
  const [crypto, setCrypto] = useState({ list: [], loading: true });

  /** Load football (full) */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const data = await j("/api/value-bets-locked");
        if (dead) return;
        const raw = Array.isArray(data?.value_bets) ? data.value_bets : [];
        setFb({
          list: uniqByFixture(raw),
          meta: data?.meta || {},
          loading: false,
          err: null,
        });
      } catch (e) {
        if (dead) return;
        setFb((s) => ({ ...s, loading: false, err: String(e) }));
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  /** Load football (top3 for Combined tab) */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const data = await j("/api/value-bets-locked?top=3");
        if (dead) return;
        const raw = Array.isArray(data?.value_bets) ? data.value_bets : [];
        setFbTop3({ list: uniqByFixture(raw), loading: false });
      } catch {
        if (dead) return;
        setFbTop3({ list: [], loading: false });
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  /** (Optional) Crypto list – ostavljam bez promene UI-a */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const data = await j("/api/crypto");
        if (dead) return;
        const arr = Array.isArray(data?.picks) ? data.picks : [];
        setCrypto({ list: arr, loading: false });
      } catch {
        if (dead) return;
        setCrypto({ list: [], loading: false });
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  /** Which list we show */
  const baseList = useMemo(() => {
    if (tab === "combined") return fbTop3.list;
    if (tab === "football") return fb.list;
    if (tab === "crypto") return crypto.list; // prikaz će biti prazan ako nema
    return [];
  }, [tab, fb.list, fbTop3.list, crypto.list]);

  /** Sorting */
  const list = useMemo(() => {
    const arr = [...(baseList || [])];
    if (sortKey === "confidence") {
      arr.sort((a, b) => confPct(b) - confPct(a) || kickoffMs(a) - kickoffMs(b));
    } else {
      // kickoff
      arr.sort((a, b) => kickoffMs(a) - kickoffMs(b) || confPct(b) - confPct(a));
    }
    return arr;
  }, [baseList, sortKey]);

  const foundText =
    tab === "crypto"
      ? `Found ${baseList.length} picks`
      : `Found ${baseList.length} picks · source: ${fb?.meta?.source || "locked-cache"}`;

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center gap-3">
        {["combined", "football", "crypto"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-2xl font-semibold ${
              tab === t ? "bg-[#202542] text-white" : "bg-[#1a1f38] text-slate-300"
            }`}
            type="button"
          >
            {t === "combined" ? "Combined" : t === "football" ? "Football" : "Crypto"}
          </button>
        ))}
      </div>

      {/* Sort controls */}
      <div className="mt-4 flex items-center gap-4">
        <span className="text-slate-300 text-sm">Sort by:</span>
        <button
          type="button"
          onClick={() => setSortKey("kickoff")}
          className={`px-3 py-2 rounded-xl text-sm font-semibold ${
            sortKey === "kickoff" ? "bg-emerald-700 text-white" : "bg-[#202542] text-white"
          }`}
        >
          Kickoff (Soonest)
        </button>
        <button
          type="button"
          onClick={() => setSortKey("confidence")}
          className={`px-3 py-2 rounded-xl text-sm font-semibold ${
            sortKey === "confidence" ? "bg-emerald-700 text-white" : "bg-[#202542] text-white"
          }`}
        >
          Confidence (High → Low)
        </button>
      </div>

      {/* Found info */}
      <div className="mt-3 text-slate-400 text-sm">{foundText}</div>

      {/* Lists */}
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        {list.map((p) => {
          const c = confPct(p);
          const { label, dot } = confLabel(c);
          const league = `${p?.league?.name || ""}`;
          const country = p?.league?.country ? `${p.league.country} • ` : "";
          const ko = fmtKick(p);
          const title = `${p?.teams?.home?.name || ""} vs ${p?.teams?.away?.name || ""}`;
          const market = `${p?.market_label || p?.market || ""}`.toUpperCase();
          const selection = p?.selection || "";
          const odds =
            typeof p?.market_odds === "number" ? `(${p.market_odds})` : "";

          // "Zašto" – koristimo tekst koji dolazi iz insights-build (sa \n)
          const why = String(p?.explain?.summary || "").trim();

          return (
            <div key={p.fixture_id} className="rounded-2xl bg-[#0f1428] p-4">
              <div className="flex items-center justify-between text-slate-300 text-sm">
                <div>
                  <span className="text-slate-400">{country}</span>
                  <span>{league}</span> <span className="text-slate-400">• {ko}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block w-3 h-3 rounded-full ${dot}`}
                    aria-hidden
                  />
                  <span className="text-slate-300">{label}</span>
                </div>
              </div>

              <div className="mt-2 text-xl font-semibold">{title}</div>
              <div className="mt-1 text-slate-200">
                {market}: {selection} {odds}
              </div>

              <div className="mt-3 text-slate-300 text-[15px] leading-relaxed">
                <span className="font-semibold">Zašto:</span>{" "}
                <span
                  className="whitespace-pre-line"
                  // poštujemo \n koje šalje /api/insights-build
                >
                  {why || p?.explain?.summary || ""}
                </span>
              </div>

              <div className="mt-3">
                <div className="text-slate-300 text-sm mb-1">Confidence</div>
                <div className="w-full h-3 rounded-full bg-slate-700 overflow-hidden">
                  <div
                    className="h-3 bg-emerald-400"
                    style={{ width: `${Math.max(0, Math.min(100, c))}%` }}
                  />
                </div>
                <div className="mt-1 text-right text-slate-400 text-sm">{c}%</div>
              </div>
            </div>
          );
        })}

        {/* Loading / Empty states */}
        {((tab !== "crypto" && fb.loading) ||
          (tab === "combined" && fbTop3.loading) ||
          (tab === "crypto" && crypto.loading)) && (
          <div className="text-slate-400">Loading…</div>
        )}
        {!list.length &&
          !fb.loading &&
          !(tab === "combined" && fbTop3.loading) &&
          !(tab === "crypto" && crypto.loading) && (
            <div className="text-slate-400">No suggestions.</div>
          )}
      </div>
    </div>
  );
}
