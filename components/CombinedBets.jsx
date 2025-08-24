"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ================= helpers ================= */
const TZ = "Europe/Belgrade";
const GRACE_MS = 10 * 60 * 1000; // 10 min

function emojiFlagByCountryName(name = "") {
  const map = {
    "England": "🏴", "UK": "🇬🇧", "United Kingdom": "🇬🇧",
    "Scotland": "🏴", "Wales": "🏴", "Northern Ireland": "🏴",
    "Serbia": "🇷🇸", "Croatia": "🇭🇷", "Bosnia and Herzegovina": "🇧🇦",
    "Montenegro": "🇲🇪", "North Macedonia": "🇲🇰", "Slovenia": "🇸🇮",
    "Spain": "🇪🇸", "France": "🇫🇷", "Germany": "🇩🇪", "Italy": "🇮🇹",
    "Portugal": "🇵🇹", "Netherlands": "🇳🇱", "Belgium": "🇧🇪",
    "Norway": "🇳🇴", "Sweden": "🇸🇪", "Denmark": "🇩🇰", "Finland": "🇫🇮",
    "Poland": "🇵🇱", "Czech Republic": "🇨🇿", "Austria": "🇦🇹",
    "Switzerland": "🇨🇭", "Greece": "🇬🇷", "Turkey": "🇹🇷",
    "USA": "🇺🇸", "United States": "🇺🇸", "Brazil": "🇧🇷",
    "Argentina": "🇦🇷", "Mexico": "🇲🇽", "Japan": "🇯🇵",
    "South Korea": "🇰🇷", "China": "🇨🇳", "Australia": "🇦🇺",
    "Saudi Arabia": "🇸🇦", "Qatar": "🇶🇦", "UAE": "🇦🇪",
    "Russia": "🇷🇺", "Ukraine": "🇺🇦", "Romania": "🇷🇴",
    "Bulgaria": "🇧🇬", "Hungary": "🇭🇺", "Ireland": "🇮🇪",
    "Scotland": "🏴", "Wales": "🏴",
  };
  return map[name] || "🌍";
}
function fmtDate(isoish) {
  if (!isoish) return "";
  const d = new Date(isoish.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "";
  const ymd = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const hm = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return `${ymd} ${hm}`;
}
function parseKOISO(item) {
  try {
    const dt =
      item?.datetime_local?.starting_at?.date_time ||
      item?.datetime_local?.date_time ||
      item?.time?.starting_at?.date_time ||
      null;
    if (!dt) return null;
    return dt.replace(" ", "T");
  } catch {
    return null;
  }
}
async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { return { ok:false, error:"non-JSON", raw: txt }; }
  } catch (e) {
    return { ok:false, error:String(e?.message || e) };
  }
}
const getTeams = (p, side) =>
  (p?.teams?.[side]?.name ?? p?.teams?.[side] ?? "") || "";

/* ============== tiket grupe (samo u Football: Kick-Off/Confidence) ============== */
function splitTicketsByMarket(items = []) {
  const val = (x) => (x?.market_label || x?.market || "").toUpperCase();
  const isOU25 = (m) => m.startsWith("OU") && (m.includes("2.5") || m.includes("2,5"));

  const g1 = items.filter((x) => val(x) === "1X2");
  const g2 = items.filter((x) => val(x).includes("BTTS"));
  const g3 = items.filter((x) => isOU25(val(x)));
  const g4 = items.filter((x) => val(x).includes("HT-FT") || val(x).includes("HTFT"));

  // ukloni duplikate između grupa (prioritet redom g1,g2,g3,g4)
  const seen = new Set();
  const uniq = (arr) => arr.filter((x) => {
    const id = x.fixture_id ?? `${getTeams(x,"home")}-${getTeams(x,"away")}-${val(x)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return {
    "1X2": uniq(g1),
    "BTTS": uniq(g2),
    "OU 2.5": uniq(g3),
    "HT-FT": uniq(g4),
  };
}

/* ================= kartica ================= */
function Card({ p }) {
  const league = p?.league?.name || "";
  const country = p?.league?.country || "";
  const flag = emojiFlagByCountryName(country);
  const iso = parseKOISO(p);
  const dateText = iso ? fmtDate(iso) : "";

  const home = getTeams(p, "home");
  const away = getTeams(p, "away");

  const market = p?.market_label || p?.market || "";
  const selection = p?.selection || "";
  const odds = Number.isFinite(p?.market_odds) ? p.market_odds : null;
  const conf = Number.isFinite(p?.confidence_pct) ? Math.round(p.confidence_pct) : null;

  // Zašto/Forma (2 linije max)
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const whyText = p?.explain?.why || p?.explain?.summary || bullets[0] || "Model ~ Implied, EV u plusu.";
  const whyLine = (whyText || "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  // Forma u jednom redu
  // Preferira zapis koji već stiže u bullets (npr. "Forma: ... · H2H ... · GD ...")
  let formLine = "";
  const formBullet = bullets.find((b) => b.toLowerCase().includes("forma"));
  const h2hBullet = bullets.find((b) => b.toLowerCase().includes("h2h"));
  if (formBullet) formLine += formBullet.replace(/^Forma:\s*/i, "").replace(/\s+/g, " ");
  if (h2hBullet) {
    const h2h = h2hBullet.replace(/^H2H.*?:\s*/i, "").replace(/\s+/g, " ");
    formLine += (formLine ? " · " : "") + `H2H ${h2h}`;
  }
  // GD (ako postoji u H2H bulletu "GF:..:GA:..")
  const mGD = /GF:?\s*([0-9]+)[:\s]+GA:?\s*([0-9]+)/i.exec(bullets.join(" · "));
  if (mGD) {
    formLine += (formLine ? " · " : "") + `GD ${mGD[1]}:${mGD[2]}`;
  }
  formLine = (formLine || "D W–D–L · G W–D–L · H2H W–D–L · GD n:n").slice(0, 140);

  return (
    <div className="rounded-2xl bg-[#171a25] p-4 shadow-md">
      {/* red 1: liga + zastava + datum CET */}
      <div className="text-sm text-slate-300 flex items-center gap-2">
        <span>{league}</span>
        <span>{flag}</span>
        {dateText && <span className="opacity-70">• {dateText}</span>}
      </div>

      {/* red 2: Home vs Away */}
      <div className="mt-1 text-xl font-semibold">
        {home} vs {away}
      </div>

      {/* red 3: Market → Selection (odds) */}
      <div className="mt-2 text-slate-200">
        {market} → <span className="font-bold">{selection}</span>
        {odds ? <> ({odds})</> : null}
      </div>

      {/* red 4: Zašto / Forma (2 linije max) */}
      <div className="mt-3 text-sm text-slate-300 space-y-1">
        <div className="line-clamp-1"><span className="text-slate-400">Zašto:</span> {whyLine}</div>
        <div className="line-clamp-1">{formLine}</div>
      </div>

      {/* ispod: Confidence bar + NN% */}
      <div className="mt-3 text-slate-300">
        <div className="mb-1">Confidence: {conf !== null ? `${conf}%` : "—"}</div>
        <div className="w-full h-3 rounded-full bg-[#0d1020] overflow-hidden">
          <div
            className={`h-3 ${conf >= 75 ? "bg-emerald-400" : conf >= 50 ? "bg-sky-400" : "bg-amber-400"}`}
            style={{ width: `${Math.max(0, Math.min(conf || 0, 100))}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/* ================= main ================= */
export default function CombinedBets() {
  const [tab, setTab] = useState("combined");      // combined | football | crypto
  const [sub, setSub] = useState("kickoff");       // kickoff | confidence | history

  const [locked, setLocked] = useState([]);        // snapshot lista
  const [crypto, setCrypto] = useState([]);        // kripto lista
  const [history, setHistory] = useState(null);    // history sa API-ja (ako postoji)
  const pulledRef = useRef(false);

  useEffect(() => {
    if (pulledRef.current) return;
    pulledRef.current = true;
    (async () => {
      const fb = await safeJson("/api/value-bets-locked");
      const list = Array.isArray(fb?.items || fb?.value_bets)
        ? (fb.items || fb.value_bets)
        : [];
      setLocked(list);

      const cr = await safeJson("/api/crypto");
      if (Array.isArray(cr?.crypto)) setCrypto(cr.crypto);

      // History (ako endpoint postoji)
      const h = await safeJson("/api/history?days=14");
      if (h && h.ok !== false && (Array.isArray(h?.items) || Array.isArray(h?.history))) {
        setHistory(h.items || h.history);
      }
    })();
  }, []);

  // filtriranje prošlih mečeva (grace 10 min)
  const now = Date.now();
  const futureOnly = (x) => {
    const t = new Date(parseKOISO(x) || 0).getTime();
    return Number.isFinite(t) && (t + GRACE_MS) >= now;
  };

  // sortiranja
  const byKOAsc = (a, b) => {
    const ta = new Date(parseKOISO(a) || 0).getTime();
    const tb = new Date(parseKOISO(b) || 0).getTime();
    return ta - tb;
  };
  const byConfDesc = (a, b) => (b?.confidence_pct ?? -1) - (a?.confidence_pct ?? -1);

  // liste po tabovima
  const listKick = useMemo(() => [...locked].filter(futureOnly).sort(byKOAsc), [locked, now]);
  const listConf = useMemo(() => [...locked].filter(futureOnly).sort(byConfDesc), [locked, now]);

  // history lista (API ili fallback: završeni danas)
  const listHist = useMemo(() => {
    if (Array.isArray(history)) return history;
    // fallback: završeni (KO < now)
    return [...locked]
      .filter((x) => {
        const t = new Date(parseKOISO(x) || 0).getTime();
        return Number.isFinite(t) && t < now;
      })
      .sort(byConfDesc);
  }, [history, locked, now]);

  // tiket grupe za Football (Kick-Off/Confidence)
  const ticketsKick = useMemo(() => splitTicketsByMarket(listKick), [listKick]);
  const ticketsConf = useMemo(() => splitTicketsByMarket(listConf), [listConf]);

  // UI helpers
  const TabBtn = ({ active, children, onClick }) => (
    <button
      onClick={onClick}
      className={`px-5 py-2 rounded-2xl ${active ? "bg-[#1f2740] text-white" : "bg-[#0f1324] text-slate-300"}`}
      type="button"
    >
      {children}
    </button>
  );

  const TicketGroup = ({ title, items }) => (
    <div className="rounded-2xl bg-[#141824] p-4">
      <div className="text-slate-300 mb-3 font-semibold">{title}</div>
      {(!items || items.length === 0) && <div className="text-slate-400 text-sm">Nema kandidata.</div>}
      <div className="space-y-3">
        {items?.slice(0, 3).map((p, i) => <Card key={i} p={p} />)}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Glavni tabovi */}
      <div className="flex items-center gap-3">
        <TabBtn active={tab === "combined"} onClick={() => setTab("combined")}>Combined</TabBtn>
        <TabBtn active={tab === "football"} onClick={() => setTab("football")}>Football</TabBtn>
        <TabBtn active={tab === "crypto"} onClick={() => setTab("crypto")}>Crypto</TabBtn>
      </div>

      {/* Football pod-tabovi */}
      {tab === "football" && (
        <div className="flex items-center gap-3">
          <TabBtn active={sub === "kickoff"} onClick={() => setSub("kickoff")}>Kick-Off</TabBtn>
          <TabBtn active={sub === "confidence"} onClick={() => setSub("confidence")}>Confidence</TabBtn>
          <TabBtn active={sub === "history"} onClick={() => setSub("history")}>History</TabBtn>
        </div>
      )}

      {/* COMBINED (bez tiketa) */}
      {tab === "combined" && (
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h2 className="text-xl font-bold mb-2">Football</h2>
            <div className="grid gap-4">
              {listKick.slice(0, 8).map((p, i) => <Card key={i} p={p} />)}
              {listKick.length === 0 && <div className="text-slate-400">Nema dostupnih predloga.</div>}
            </div>
          </div>
          <div>
            <h2 className="text-xl font-bold mb-2">Crypto</h2>
            <div className="grid gap-4">
              {Array.isArray(crypto) && crypto.length > 0 ? (
                crypto.slice(0, 8).map((c, i) => (
                  <div key={i} className="rounded-2xl bg-[#171a25] p-4 shadow-md">
                    <div className="text-sm text-slate-300">{c.symbol}</div>
                    <div className="mt-1 text-xl font-semibold">{c.signal}</div>
                    <div className="mt-2 text-slate-200">
                      Price: {c.price} {Number.isFinite(c?.confidence) ? ` • Conf ${c.confidence.toFixed(0)}%` : ""}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-slate-400">Nema kripto signala.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* FOOTBALL: Kick-Off (sa 4 tiketa) */}
      {tab === "football" && sub === "kickoff" && (
        <>
          {/* 4 grupe tiketa */}
          <div className="grid md:grid-cols-4 gap-4">
            <TicketGroup title="1X2" items={ticketsKick["1X2"]} />
            <TicketGroup title="BTTS" items={ticketsKick["BTTS"]} />
            <TicketGroup title="OU 2.5" items={ticketsKick["OU 2.5"]} />
            <TicketGroup title="HT-FT" items={ticketsKick["HT-FT"]} />
          </div>

          {/* lista mečeva */}
          <div className="mt-6">
            <h2 className="text-xl font-bold mb-2">Kick-Off — svi predlozi</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {listKick.map((p, i) => <Card key={i} p={p} />)}
              {listKick.length === 0 && <div className="text-slate-400">Nema dostupnih predloga.</div>}
            </div>
          </div>
        </>
      )}

      {/* FOOTBALL: Confidence (sa 4 tiketa) */}
      {tab === "football" && sub === "confidence" && (
        <>
          <div className="grid md:grid-cols-4 gap-4">
            <TicketGroup title="1X2" items={ticketsConf["1X2"]} />
            <TicketGroup title="BTTS" items={ticketsConf["BTTS"]} />
            <TicketGroup title="OU 2.5" items={ticketsConf["OU 2.5"]} />
            <TicketGroup title="HT-FT" items={ticketsConf["HT-FT"]} />
          </div>

          <div className="mt-6">
            <h2 className="text-xl font-bold mb-2">Confidence — svi predlozi</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {listConf.map((p, i) => <Card key={i} p={p} />)}
              {listConf.length === 0 && <div className="text-slate-400">Nema dostupnih predloga.</div>}
            </div>
          </div>
        </>
      )}

      {/* FOOTBALL: History (bez tiketa) */}
      {tab === "football" && sub === "history" && (
        <div>
          <h2 className="text-xl font-bold mb-2">History — učinak</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {listHist.map((p, i) => <Card key={i} p={p} />)}
            {listHist.length === 0 && <div className="text-slate-400">Nema istorijskih predloga.</div>}
          </div>
        </div>
      )}

      {/* CRYPTO (bez tiketa) */}
      {tab === "crypto" && (
        <div>
          <h2 className="text-xl font-bold mb-2">Crypto</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {Array.isArray(crypto) && crypto.length > 0 ? (
              crypto.map((c, i) => (
                <div key={i} className="rounded-2xl bg-[#171a25] p-4 shadow-md">
                  <div className="text-sm text-slate-300">{c.symbol}</div>
                  <div className="mt-1 text-xl font-semibold">{c.signal}</div>
                  <div className="mt-2 text-slate-200">
                    Price: {c.price} {Number.isFinite(c?.confidence) ? ` • Conf ${c.confidence.toFixed(0)}%` : ""}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-slate-400">Nema kripto signala.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
