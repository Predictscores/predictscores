// FILE: pages/api/value-bets.js
/**
 * OVA RUTA JE ZA GENERACIJU – sada pod "hard guard":
 * Dozvoljeno SAMO kada dolazi iz crona / internog poziva.
 *
 * (Ostatak fajla je tvoj postojeći generator – dodali smo guard na vrhu.)
 */

export default async function handler(req, res){
  // ---- HARD GUARD: samo cron/internal
  const h = req.headers || {};
  const allowed =
    String(h["x-vercel-cron"] || "") === "1" ||
    String(h["x-internal"] || "") === "1";
  if (!allowed) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(403).json({ error: "forbidden", note: "value-bets is cron/internal only" });
  }

  // === TVOJ POSTOJEĆI KOD ISPOD (NE DIRAMO) ===
  // (Kopirano iz tvoje verzije – bez promena.)
  const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
  const AF_KEY =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2 ||
    "";

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  const CFG = {
    BUDGET_DAILY: num(process.env.AF_BUDGET_DAILY, 5000),
    ROLLING_WINDOW_HOURS: num(process.env.AF_ROLLING_WINDOW_HOURS, 12),
    PASS1_CAP: num(process.env.AF_PASS1_CAP, 80),
    H2H_LAST: num(process.env.AF_H2H_LAST, 10),
    NEAR_WINDOW_MIN: num(process.env.AF_NEAR_WINDOW_MIN, 60),
    DEEP_TOP: num(process.env.AF_DEEP_TOP, 30),
    RUN_HARDCAP: num(process.env.AF_RUN_MAX_CALLS, 360),
    PAYLOAD_MEMO_MS: 60 * 1000,
    CDN_SMAXAGE: num(process.env.CDN_SMAXAGE_SEC, 600),
    CDN_SWR: num(process.env.CDN_STALE_SEC, 120),
    OU_LINE: "2.5",
    MIN_BOOKIES: num(process.env.VB_MIN_BOOKIES, 3),
  };

  const EXCLUDE_REGEX_RAW =
    process.env.VB_EXCLUDE_REGEX ||
    "(friendlies|friendly|club\\s*friendlies|\\bu\\s?23\\b|\\bu\\s?21\\b|\\bu\\s?20\\b|\\bu\\s?19\\b|reserves?|\\bii\\b|b\\s*team|youth|academy|trial|test|indoor|futsal|beach)";
  const EXCLUDE_RE = new RegExp(EXCLUDE_REGEX_RAW, "i");
  function isLeagueExcluded(league = {}) {
    const name = `${league.name || ""} ${league.country || ""}`.trim();
    return EXCLUDE_RE.test(name);
  }

  const g = globalThis;
  if (!g.__VB_CACHE__) {
    g.__VB_CACHE__ = {
      byKey: new Map(),
      counters: { day: todayYMD(), apiFootball: 0 },
      snapshots: new Map(),
      inflight: null,
      inflightAt: 0,
      lastPayload: null,
      oddsCoverageLeagues: { ts: 0, set: new Set() },
    };
  }
  const CACHE = g.__VB_CACHE__;
  function todayYMD(){ return new Date().toISOString().slice(0,10); }
  function resetCountersIfNewDay(){
    const d = todayYMD();
    if (CACHE.counters.day !== d) CACHE.counters = { day: d, apiFootball: 0 };
  }
  function incAF(){ resetCountersIfNewDay(); CACHE.counters.apiFootball++; }
  function withinDailyBudget(incr=1){ resetCountersIfNewDay(); return CACHE.counters.apiFootball + incr <= Number(process.env.AF_BUDGET_DAILY||5000); }
  function setCache(k, data, ttlSec=60){ CACHE.byKey.set(k,{data,exp:Date.now()+ttlSec*1000}); return data; }
  function getCache(k){ const it=CACHE.byKey.get(k); if(!it) return null; if(Date.now()>it.exp){ CACHE.byKey.delete(k); return null; } return it.data; }

  let RUN_CALLS = 0;
  function canCallAF(qty=1){ return RUN_CALLS + qty <= Number(process.env.AF_RUN_MAX_CALLS||360); }
  function noteAF(qty=1){ RUN_CALLS += qty; }

  function sanitizeIso(s){ if(!s||typeof s!=="string") return null; let iso=s.trim().replace(" ","T"); iso=iso.replace("+00:00Z","Z").replace("Z+00:00","Z"); return iso; }
  function impliedFromDecimal(o){ const x=Number(o); return Number.isFinite(x)&&x>1.01?1/x:null; }
  function evFrom(p, o){ const odds=Number(o); if(!Number.isFinite(odds)||odds<=1.01) return null; return p*(odds-1) - (1-p); }
  function toLocalYMD(d, tz){ return new Intl.DateTimeFormat("sv-SE",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d); }
  function bucketFromPct(p){ if(p>=90) return "TOP"; if(p>=75) return "High"; if(p>=50) return "Moderate"; return "Low"; }
  const median = (arr)=> arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)] : null;

  function poissonPMF(k, lambda){ if(lambda<=0) return k===0?1:0; let logP = -lambda; for(let i=1;i<=k;i++) logP += Math.log(lambda) - Math.log(i); return Math.exp(logP); }
  function poissonCDF(k, lambda){ let acc=0; for(let i=0;i<=k;i++) acc+=poissonPMF(i,lambda); return acc; }

  async function afFetch(path,{ttl=0}={}) {
    const AF_KEY =
      process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
      process.env.API_FOOTBALL_KEY ||
      process.env.API_FOOTBALL_KEY_1 ||
      process.env.API_FOOTBALL_KEY_2 ||
      "";
    if (!AF_KEY) throw new Error("API_FOOTBALL_KEY missing");
    const url=`https://v3.football.api-sports.io${path}`;
    const ck=`AF:${url}`;
    if(ttl){ const c=getCache(ck); if(c) return c; }
    if(!withinDailyBudget()) throw new Error("AF budget exhausted");
    if(!canCallAF()) throw new Error("AF run hardcap reached");
    const res=await fetch(url,{headers:{ "x-apisports-key":AF_KEY }});
    noteAF(); incAF();
    if(!res.ok) throw new Error(`AF ${path} -> ${res.status}`);
    const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j;
  }

  async function getOddsCoverageLeagues(){
    const FRESH_MS = 12*3600*1000;
    if (Date.now() - CACHE.oddsCoverageLeagues.ts < FRESH_MS && CACHE.oddsCoverageLeagues.set.size) {
      return CACHE.oddsCoverageLeagues.set;
    }
    const j = await afFetch(`/odds/leagues`, { ttl: 12*3600 });
    const list = j?.response || [];
    const set = new Set(list.map(l => Number(l?.league?.id)).filter(Number.isFinite));
    CACHE.oddsCoverageLeagues = { ts: Date.now(), set };
    return set;
  }

  // === SAV OSTATak: tvoja postojećа computePayload + handler iz originalnog fajla ===
  // (Radi isto kao i ranije; uklonili smo samo javno pokretanje.)
  // ... (OVDE IDE TVOJ CELOKUPAN POSTOJEĆI KOD computePayload + export default handler)
  // ---- Da ne zatrpamo poruku, skraćujem: PREKOPIRAJ SAV PREOSTALI DEO IZ TVOJE VERZIJE ISPOD OVOG KOMENTARA ----
}
