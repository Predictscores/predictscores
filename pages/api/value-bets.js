// FILE: pages/api/value-bets.js
/**
 * Value-bets generator (cron/internal only).
 * Radi i kad nema /predictions: koristi odds-only metod (avg implied vs best price).
 * Uvek vrati bar nešto: dopušta blago negativan edge do -0.5pp (safe-mode),
 * ali prvenstvo daje pozitivnim EV parovima.
 *
 * Tvrdi limiti da ne troši pozive:
 *  - RUN_HARDCAP (ukupno AF poziva u rundi)
 *  - MAX_FIX_SCAN (max broj fixture-a koje skenira)
 *  - PASS1_CAP    (max koliko parova vraća)
 */

export const config = { api: { bodyParser: false } };

// ---- Guard: samo cron/internal ----
function isAllowed(req) {
  const h = req.headers || {};
  return String(h["x-vercel-cron"] || "") === "1" || String(h["x-internal"] || "") === "1";
}

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// Čvrsti runtime limiti (konzervativno)
const LIMITS = {
  DAILY_BUDGET:  num(process.env.AF_BUDGET_DAILY, 1000), // spusti da ne troši
  RUN_HARDCAP:   num(process.env.AF_RUN_MAX_CALLS, 120),
  PASS1_CAP:     num(process.env.AF_PASS1_CAP, 25),
  MAX_FIX_SCAN:  num(process.env.VB_MAX_FIX_SCAN, 150),  // max ocenjenih fixture-a
  MIN_ODDS: 1.30
};

// Safe-mode prag (ako nema pozitivnog EV)
const SAFE_EDGE_MIN_PP = -0.5; // dozvoli do -0.5pp da UI ne bude prazan

// Ne diramo tvoju regex listu, ali isključujemo samo očigledne “friendly/youth”.
const EXCLUDE_RE = new RegExp(
  process.env.VB_EXCLUDE_REGEX ||
  "(friendlies|friendly|club\\s*friendlies|\\bu\\s?23\\b|\\bu\\s?21\\b|\\bu\\s?20\\b|\\bu\\s?19\\b|reserves?|\\bii\\b|b\\s*team|youth|academy|trial|test|indoor|futsal|beach)",
  "i"
);

// Grubi budžet u procesu
const RUNTIME = (global.__VBGEN__ = global.__VBGEN__ || { day:null, used:0, run:0 });

function todayYMD() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
  }).format(new Date()).replaceAll(".", "-");
}
function resetIfNewDay() {
  const d = todayYMD();
  if (RUNTIME.day !== d) { RUNTIME.day = d; RUNTIME.used = 0; }
}
function chargeDaily(q=1){ resetIfNewDay(); if (RUNTIME.used+q>LIMITS.DAILY_BUDGET) return false; RUNTIME.used+=q; return true; }
function chargeRun(q=1){ if (RUNTIME.run+q>LIMITS.RUN_HARDCAP) return false; RUNTIME.run+=q; return true; }

function impliedFromDecimal(o){ const x=Number(o); return Number.isFinite(x)&&x>1.01?1/x:null; }
function toLocalISO(d){
  const dFmt=new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
  const tFmt=new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
  return `${dFmt.format(d)} ${tFmt.format(d)}`;
}

// --- AF fetch ---
async function afFetch(path) {
  const KEY =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2 || "";
  if (!KEY) throw new Error("API_FOOTBALL_KEY missing");
  if (!chargeDaily(1)) throw new Error("AF daily budget limit");
  if (!chargeRun(1))   throw new Error("AF run hardcap");
  const url = `https://v3.football.api-sports.io${path}`;
  const r = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`AF ${path} -> ${r.status} ${t}`);
  }
  const j = await r.json().catch(()=> ({}));
  return Array.isArray(j?.response) ? j.response : [];
}

// --- predictions helper (možda nemaš endpoint na planu) ---
function normPred1x2(predResp) {
  const p = (s)=>{ const n=Number(String(s||"").replace("%","").trim()); return Number.isFinite(n)?n:null; };
  const pr = Array.isArray(predResp) ? predResp[0] : null;
  const home = p(pr?.predictions?.home ?? pr?.percent?.home);
  const draw = p(pr?.predictions?.draw ?? pr?.percent?.draw);
  const away = p(pr?.predictions?.away ?? pr?.percent?.away);
  const arr = [
    { key:"HOME", pct: home ?? -1 },
    { key:"DRAW", pct: draw ?? -1 },
    { key:"AWAY", pct: away ?? -1 },
  ].sort((a,b)=> b.pct - a.pct);
  return arr[0]?.pct>=0 ? arr[0] : null;
}

/**
 * PRAVILNO PARSIRANJE /odds:
 * responseItem.bookmakers[].bets[].values[] -> (Home/X/Away)
 */
function extract1x2FromOdds(oddsResp){
  let best = { HOME:null, DRAW:null, AWAY:null };
  let booksWithMarket = 0;

  for (const item of oddsResp) {
    const bookmakers = Array.isArray(item?.bookmakers) ? item.bookmakers : [];
    for (const bk of bookmakers) {
      const bets = Array.isArray(bk?.bets) ? bk.bets : [];
      const m = bets.find(b => {
        const label = String(b?.name||"").toLowerCase();
        return label.includes("1x2") || label.includes("match winner") || label==="winner" || label==="match-winner";
      });
      if (!m) continue;

      const vals = Array.isArray(m?.values) ? m.values : [];
      let got = false;

      const setIfBetter = (tag, v) => {
        const dec = Number(v?.odd || v?.value || v?.price || v?.decimal);
        if (Number.isFinite(dec) && dec >= LIMITS.MIN_ODDS) {
          best[tag] = Math.max(best[tag] || 0, dec);
          got = true;
        }
      };

      for (const v of vals) {
        const name = String(v?.value||v?.selection||v?.name||"").toLowerCase();
        if (["1","home","home team"].includes(name)) setIfBetter("HOME", v);
        else if (["x","draw"].includes(name))        setIfBetter("DRAW", v);
        else if (["2","away","away team"].includes(name)) setIfBetter("AWAY", v);
      }

      if (got) booksWithMarket++;
    }
  }

  return {
    bestHome: best.HOME || null,
    bestDraw: best.DRAW || null,
    bestAway: best.AWAY || null,
    bookies: booksWithMarket
  };
}

function averageImpliedFromOdds(oddsResp){
  const arrH=[], arrD=[], arrA=[];
  for (const item of oddsResp) {
    const bookmakers = Array.isArray(item?.bookmakers) ? item.bookmakers : [];
    for (const bk of bookmakers) {
      const bets = Array.isArray(bk?.bets) ? bk.bets : [];
      const m = bets.find(b => {
        const label = String(b?.name||"").toLowerCase();
        return label.includes("1x2") || label.includes("match winner") || label==="winner" || label==="match-winner";
      });
      if (!m) continue;
      const vals = Array.isArray(m?.values) ? m.values : [];

      const pushImp = (tag, v) => {
        const dec = Number(v?.odd || v?.value || v?.price || v?.decimal);
        const imp = impliedFromDecimal(dec);
        if (imp != null) {
          if (tag==="HOME") arrH.push(imp);
          else if (tag==="DRAW") arrD.push(imp);
          else if (tag==="AWAY") arrA.push(imp);
        }
      };

      for (const v of vals) {
        const name = String(v?.value||v?.selection||v?.name||"").toLowerCase();
        if (["1","home","home team"].includes(name)) pushImp("HOME", v);
        else if (["x","draw"].includes(name))        pushImp("DRAW", v);
        else if (["2","away","away team"].includes(name)) pushImp("AWAY", v);
      }
    }
  }
  const avg=(a)=> a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;
  return { avgH: avg(arrH), avgD: avg(arrD), avgA: avg(arrA) };
}

// --- generator ---
async function generatePicks(){
  const ymd = todayYMD();
  const now = Date.now();
  const fixtures = (await afFetch(`/fixtures?date=${ymd}`))
    .filter(f=>{
      const lname = `${f?.league?.name||""} ${f?.league?.country||""}`.trim();
      if (EXCLUDE_RE.test(lname)) return false;
      const t = f?.fixture?.date ? new Date(f.fixture.date).getTime() : NaN;
      return Number.isFinite(t) && t>now;
    });

  const out = [];
  let scanned = 0;

  for (const fx of fixtures) {
    if (out.length >= LIMITS.PASS1_CAP) break;
    if (scanned >= LIMITS.MAX_FIX_SCAN) break;
    scanned++;

    const fid = Number(fx?.fixture?.id);
    if (!fid) continue;

    // odds (1 call)
    let oddsResp = [];
    try { oddsResp = await afFetch(`/odds?fixture=${fid}`); } catch { continue; }

    const { bestHome, bestDraw, bestAway, bookies } = extract1x2FromOdds(oddsResp);
    // Minimalno 1 bukmacher (da ne blokira)
    if (bookies < 1) continue;

    // predictions (pokušaj; ne obavezno)
    let usePred = null;
    try {
      const pr = await afFetch(`/predictions?fixture=${fid}`);
      usePred = normPred1x2(pr);
    } catch {}

    // Kandidati: uvek razmotri sva 3 ishoda (pa biraj najbolji)
    const { avgH, avgD, avgA } = averageImpliedFromOdds(oddsResp);
    const cands = [];
    const push = (k, odds, p) => {
      if (!odds || odds < LIMITS.MIN_ODDS) return;
      const implied = impliedFromDecimal(odds);
      if (implied == null) return;
      const prob = Number.isFinite(p) ? p : null;
      if (prob == null) return;
      const ev = prob*(odds-1) - (1-prob);
      const edgePP = Math.round((prob - implied) * 1000) / 10;
      cands.push({ k, odds, prob, implied, ev, edgePP });
    };

    // Ako ima predictions, to koristi kao prob za odgovarajući ishod
    if (usePred) {
      if (usePred.pick === "HOME" && bestHome) push("HOME", bestHome, usePred.pct/100);
      if (usePred.pick === "DRAW" && bestDraw) push("DRAW", bestDraw, usePred.pct/100);
      if (usePred.pick === "AWAY" && bestAway) push("AWAY", bestAway, usePred.pct/100);
    }

    // Uvek dodaj i odds-only average kao fallback kandidata
    if (bestHome && avgH!=null) push("HOME", bestHome, avgH);
    if (bestDraw && avgD!=null) push("DRAW", bestDraw, avgD);
    if (bestAway && avgA!=null) push("AWAY", bestAway, avgA);

    if (!cands.length) continue;

    // Preferiraj pozitivne, pa dozvoli do -0.5pp
    cands.sort((a,b)=> (b.edgePP - a.edgePP) || (b.ev - a.ev));
    const best = cands.find(c => c.edgePP >= 0) || cands[0];
    if (!best) continue;
    if (best.edgePP < SAFE_EDGE_MIN_PP) continue;

    const kickoff = fx?.fixture?.date ? new Date(fx.fixture.date) : null;
    if (!kickoff) continue;

    out.push({
      type: "MODEL+ODDS",
      _score: best.edgePP,
      fixture_id: fid,
      league: {
        id: fx?.league?.id,
        name: fx?.league?.name,
        country: fx?.league?.country,
      },
      teams: {
        home: fx?.teams?.home?.name,
        away: fx?.teams?.away?.name,
      },
      home_id: fx?.teams?.home?.id,
      away_id: fx?.teams?.away?.id,
      datetime_local: { starting_at: { date_time: toLocalISO(kickoff) } },
      market: "1X2",
      market_label: "1X2",
      selection: best.k,
      confidence_pct: Math.min(99, Math.max(1, Math.round(best.prob*100))),
      model_prob: best.prob,
      market_odds: best.odds,
      implied_prob: best.implied,
      edge_pp: best.edgePP,
      bookmakers_count: bookies,
      movement_pct: 0,
      explain: {
        summary: `Model ${Math.round(best.prob*100)}% vs ${Math.round(best.implied*100)}% · Bookies ${bookies}`
      },
    });
  }

  // Stabilno sortiranje
  out.sort((a,b)=>{
    if ((b._score||0)!==(a._score||0)) return (b._score||0)-(a._score||0);
    const ta=new Date(a?.datetime_local?.starting_at?.date_time?.replace(" ","T")||0).getTime();
    const tb=new Date(b?.datetime_local?.starting_at?.date_time?.replace(" ","T")||0).getTime();
    return ta-tb;
  });

  return out.slice(0, LIMITS.PASS1_CAP);
}

// ---- HTTP handler ----
export default async function handler(req, res){
  if (!isAllowed(req)) {
    res.setHeader("Cache-Control","no-store");
    return res.status(403).json({ error:"forbidden", note:"value-bets is cron/internal only" });
  }
  try{
    RUNTIME.run = 0; // reset po rundi
    const picks = await generatePicks();
    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({ value_bets: picks });
  }catch(e){
    res.setHeader("Cache-Control","no-store");
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}
