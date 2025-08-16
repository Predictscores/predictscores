// FILE: pages/api/value-bets.js
/**
 * Value-bets generator (cron/internal only).
 * 1) Pokuša predictions+odds (ako tvoj plan ima /predictions).
 * 2) Fallback: odds-only (avg implied across bookmakers vs best price).
 *
 * KLJUČNA ISPRAVKA: pravilno parsiranje /odds:
 * response[].bookmakers[].bets[].values[]
 */

export const config = { api: { bodyParser: false } };

// ---- Guard: samo cron/internal ----
function isAllowed(req) {
  const h = req.headers || {};
  return String(h["x-vercel-cron"] || "") === "1" || String(h["x-internal"] || "") === "1";
}

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

const CFG = {
  DAILY_BUDGET:  num(process.env.AF_BUDGET_DAILY, 5000),
  RUN_HARDCAP:   num(process.env.AF_RUN_MAX_CALLS, 220),
  PASS1_CAP:     num(process.env.AF_PASS1_CAP, 60),
  VB_MIN_BOOKIES:num(process.env.VB_MIN_BOOKIES, 3),
  MIN_ODDS: 1.30
};

const EXCLUDE_RE = new RegExp(
  process.env.VB_EXCLUDE_REGEX ||
  "(friendlies|friendly|club\\s*friendlies|\\bu\\s?23\\b|\\bu\\s?21\\b|\\bu\\s?20\\b|\\bu\\s?19\\b|reserves?|\\bii\\b|b\\s*team|youth|academy|trial|test|indoor|futsal|beach)",
  "i"
);

// grubi budžet u procesu
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
function chargeDaily(q=1){ resetIfNewDay(); if (RUNTIME.used+q>CFG.DAILY_BUDGET) return false; RUNTIME.used+=q; return true; }
function chargeRun(q=1){ if (RUNTIME.run+q>CFG.RUN_HARDCAP) return false; RUNTIME.run+=q; return true; }

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
 * ISPRAVLJENO: parsiranje odds:
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
        if (Number.isFinite(dec) && dec >= CFG.MIN_ODDS) {
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
  // fixtures danas (u tvom TZ)
  const ymd = todayYMD();
  const now = Date.now();
  const fixtures = (await afFetch(`/fixtures?date=${ymd}`))
    .filter(f=>{
      const lname = `${f?.league?.name||""} ${f?.league?.country||""}`.trim();
      if (EXCLUDE_RE.test(lname)) return false;
      const t = f?.fixture?.date ? new Date(f.fixture.date).getTime() : NaN;
      return Number.isFinite(t) && t>now;
    })
    .slice(0, 400);

  const out = [];
  for (const fx of fixtures) {
    if (out.length >= CFG.PASS1_CAP) break;

    const fid = Number(fx?.fixture?.id);
    if (!fid) continue;

    // odds (obavezno)
    let oddsResp = [];
    try { oddsResp = await afFetch(`/odds?fixture=${fid}`); } catch { continue; }

    const { bestHome, bestDraw, bestAway, bookies } = extract1x2FromOdds(oddsResp);
    if (bookies < CFG.VB_MIN_BOOKIES) continue;

    // predictions (probaj)
    let usePred = null;
    try {
      const pr = await afFetch(`/predictions?fixture=${fid}`);
      usePred = normPred1x2(pr);
    } catch {}

    // izbor selekcije
    let selection = null, modelProb = null, marketOdds = null;
    if (usePred) {
      selection = usePred.pick;
      modelProb = usePred.pct/100;
      marketOdds =
        selection==="HOME" ? bestHome :
        selection==="DRAW" ? bestDraw :
        selection==="AWAY" ? bestAway : null;
    } else {
      // odds-only fallback: uporedi best price vs avg implied tržišta
      const { avgH, avgD, avgA } = averageImpliedFromOdds(oddsResp);
      const candidates = [];
      if (bestHome && avgH!=null) candidates.push({ k:"HOME", odds:bestHome, p:avgH });
      if (bestDraw && avgD!=null) candidates.push({ k:"DRAW", odds:bestDraw, p:avgD });
      if (bestAway && avgA!=null) candidates.push({ k:"AWAY", odds:bestAway, p:avgA });
      candidates.forEach(c => c.ev = c.p * (c.odds-1) - (1-c.p));
      candidates.sort((a,b)=> b.ev - a.ev);
      const top = candidates[0];
      if (!top || top.ev <= 0) continue;
      selection = top.k; modelProb = top.p; marketOdds = top.odds;
    }

    if (!selection || !marketOdds || marketOdds<CFG.MIN_ODDS) continue;

    const implied = impliedFromDecimal(marketOdds);
    if (implied == null) continue;

    const edgePP = Math.round((modelProb - implied) * 1000) / 10;
    if (edgePP < 0) continue;

    const kickoff = fx?.fixture?.date ? new Date(fx.fixture.date) : null;
    if (!kickoff) continue;

    out.push({
      type: "MODEL+ODDS",
      _score: edgePP,
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
      selection,
      confidence_pct: Math.min(99, Math.max(1, Math.round(modelProb*100))),
      model_prob: modelProb,
      market_odds: marketOdds,
      implied_prob: implied,
      edge_pp: edgePP,
      bookmakers_count: bookies,
      movement_pct: 0,
      explain: {
        summary: `Model ${Math.round(modelProb*100)}% vs ${Math.round(implied*100)}% · Bookies ${bookies}`
      },
    });
  }

  out.sort((a,b)=>{
    if ((b._score||0)!==(a._score||0)) return (b._score||0)-(a._score||0);
    const ta=new Date(a?.datetime_local?.starting_at?.date_time?.replace(" ","T")||0).getTime();
    const tb=new Date(b?.datetime_local?.starting_at?.date_time?.replace(" ","T")||0).getTime();
    return ta-tb;
  });

  return out;
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
