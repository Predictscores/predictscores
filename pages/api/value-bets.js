// FILE: pages/api/value-bets.js
export const config = { api: { bodyParser: false } };

/* ---------------- access guard ---------------- */
function isAllowed(req) {
  const h = req.headers || {};
  return String(h["x-vercel-cron"] || "") === "1" || String(h["x-internal"] || "") === "1";
}

/* ---------------- env & limits ---------------- */
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

const LIMITS = {
  DAILY_BUDGET:  num(process.env.AF_BUDGET_DAILY, 1000),
  RUN_HARDCAP:   num(process.env.AF_RUN_MAX_CALLS, 120),
  PASS1_CAP:     num(process.env.AF_PASS1_CAP, 40),
  MAX_FIX_SCAN:  num(process.env.VB_MAX_FIX_SCAN, 150),
  MIN_ODDS:      1.30,
  MIN_BOOKIES:   num(process.env.VB_MIN_BOOKIES, 2), // default 2 da vidiš više tržišta
};

const SAFE_EDGE_MIN_PP = -0.5;

/* ---------------- league exclude ---------------- */
const EXCLUDE_RE = new RegExp(
  process.env.VB_EXCLUDE_REGEX ||
  "(friendlies|friendly|club\\s*friendlies|\\bu\\s?23\\b|\\bu\\s?21\\b|\\bu\\s?20\\b|\\bu\\s?19\\b|reserves?|\\bii\\b|b\\s*team|youth|academy|trial|test|indoor|futsal|beach)",
  "i"
);

/* ---------------- runtime budget ---------------- */
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

/* ---------------- utils ---------------- */
function impliedFromDecimal(o){ const x=Number(o); return Number.isFinite(x)&&x>1.01?1/x:null; }
function toLocalISO(d){
  const dFmt=new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
  const tFmt=new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
  return `${dFmt.format(d)} ${tFmt.format(d)}`;
}

/* ---------------- AF fetch ---------------- */
async function afFetch(path){
  const KEY =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2 || "";
  if (!KEY) throw new Error("API_FOOTBALL_KEY missing");
  if (!chargeDaily(1)) throw new Error("AF daily budget limit");
  if (!chargeRun(1))   throw new Error("AF run hardcap");
  const r = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": KEY }
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`AF ${path} -> ${r.status} ${t}`);
  }
  const j = await r.json().catch(()=> ({}));
  return Array.isArray(j?.response) ? j.response : [];
}

/* ---------------- fallback (The Odds API bridge) → samo 1X2 ---------------- */
async function oddsFallbackInternal(req, { home, away, tsISO }){
  try{
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;
    const r = await fetch(
      `${origin}/api/odds-sports?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&ts=${encodeURIComponent(tsISO)}`,
      { headers: { "x-internal": "1" } }
    );
    if (!r.ok) return null;
    const j = await r.json().catch(()=> ({}));
    if (Array.isArray(j?.bookmakers) && j.bookmakers.length) {
      return [{ bookmakers: j.bookmakers }];
    }
    return null;
  }catch(_){ return null; }
}

/* ---------------- predictions (1X2) ---------------- */
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

/* ---------------- normalize odds (1X2, BTTS, OU, HT-FT) ---------------- */
function normalizeOdds(oddsResp){
  const acc = {
    "1X2":   { HOME:null, DRAW:null, AWAY:null, bookies:0, imps:{H:[],D:[],A:[]} },
    "BTTS":  { YES:null, NO:null, bookies:0, imps:{YES:[],NO:[]} },
    "OU":    { lines: new Map() }, // line -> { OVER:null, UNDER:null, bookies:0, imps:{OVER:[],UNDER:[]} }
    "HT-FT": { map: new Map(), bookies:0 }, // "1/1","1/X",... -> { odd, imps:[] }
  };

  const asDec = (v)=> Number(v?.odd || v?.value || v?.price || v?.decimal);
  const pushImp = (arr, dec)=> { const imp = impliedFromDecimal(dec); if (imp!=null) arr.push(imp); };

  for (const item of oddsResp) {
    const bookmakers = Array.isArray(item?.bookmakers) ? item.bookmakers : [];
    for (const bk of bookmakers) {
      const bets = Array.isArray(bk?.bets) ? bk.bets : [];        // AF
      const markets = Array.isArray(bk?.markets) ? bk.markets : []; // The Odds API
      const use = bets.length ? bets : (markets.length ? markets : []);

      // 1X2 / Match Winner / H2H
      {
        const m = use.find((b) => {
          const label = String(b?.name || b?.key || "").toLowerCase();
          return label.includes("1x2") || label.includes("match winner") || label==="h2h" || label==="winner" || label==="match-winner";
        });
        if (m) {
          const vals = m.values || m.outcomes || [];
          let got = false;
          for (const v of vals) {
            const name = String(v?.value||v?.selection||v?.name||"").toLowerCase();
            const dec = asDec(v);
            if (!Number.isFinite(dec) || dec < LIMITS.MIN_ODDS) continue;
            if (["1","home","home team"].includes(name)) {
              acc["1X2"].HOME = Math.max(acc["1X2"].HOME || 0, dec);
              pushImp(acc["1X2"].imps.H, dec); got = true;
            } else if (["x","draw"].includes(name)) {
              acc["1X2"].DRAW = Math.max(acc["1X2"].DRAW || 0, dec);
              pushImp(acc["1X2"].imps.D, dec); got = true;
            } else if (["2","away","away team"].includes(name)) {
              acc["1X2"].AWAY = Math.max(acc["1X2"].AWAY || 0, dec);
              pushImp(acc["1X2"].imps.A, dec); got = true;
            }
          }
          if (got) acc["1X2"].bookies += 1;
        }
      }

      // BTTS
      {
        const m = use.find((b) => {
          const label = String(b?.name || b?.key || "").toLowerCase();
          return label.includes("both teams to score") || label.includes("btts");
        });
        if (m) {
          const vals = m.values || m.outcomes || [];
          let got = false;
          for (const v of vals) {
            const name = String(v?.value||v?.selection||v?.name||"").toLowerCase();
            const dec = asDec(v);
            if (!Number.isFinite(dec) || dec < LIMITS.MIN_ODDS) continue;
            if (name.includes("yes")) { acc["BTTS"].YES = Math.max(acc["BTTS"].YES || 0, dec); pushImp(acc["BTTS"].imps.YES, dec); got = true; }
            else if (name.includes("no")) { acc["BTTS"].NO = Math.max(acc["BTTS"].NO || 0, dec); pushImp(acc["BTTS"].imps.NO, dec); got = true; }
          }
          if (got) acc["BTTS"].bookies += 1;
        }
      }

      // Over/Under (grupiši po liniji; prefer 2.5)
      {
        const m = use.find((b) => {
          const label = String(b?.name || b?.key || "").toLowerCase();
          return label.includes("over/under") || label.includes("goals over/under");
        });
        if (m) {
          const vals = m.values || m.outcomes || [];
          const byLine = new Map(); // line -> rec
          for (const v of vals) {
            const lab = String(v?.value||v?.selection||v?.name||"");
            const dec = asDec(v);
            if (!Number.isFinite(dec) || dec < LIMITS.MIN_ODDS) continue;
            const isOver = /over/i.test(lab);
            const isUnder = /under/i.test(lab);
            const mLine = lab.match(/([0-9]+(?:\.[0-9]+)?)/);
            const line = mLine ? Number(mLine[1]) : 2.5;
            if (!byLine.has(line)) byLine.set(line, { OVER:null, UNDER:null, bookies:0, imps:{OVER:[],UNDER:[]} });
            const rec = byLine.get(line);
            if (isOver) { rec.OVER = Math.max(rec.OVER || 0, dec); pushImp(rec.imps.OVER, dec); rec.bookies += 1; }
            else if (isUnder) { rec.UNDER = Math.max(rec.UNDER || 0, dec); pushImp(rec.imps.UNDER, dec); rec.bookies += 1; }
          }
          for (const [line, rec] of byLine.entries()) {
            const cur = acc["OU"].lines.get(line) || { OVER:null, UNDER:null, bookies:0, imps:{OVER:[],UNDER:[]} };
            cur.OVER = Math.max(cur.OVER || 0, rec.OVER || 0);
            cur.UNDER = Math.max(cur.UNDER || 0, rec.UNDER || 0);
            cur.bookies = Math.max(cur.bookies || 0, rec.bookies || 0);
            cur.imps.OVER.push(...rec.imps.OVER);
            cur.imps.UNDER.push(...rec.imps.UNDER);
            acc["OU"].lines.set(line, cur);
          }
        }
      }

      // HT/FT
      {
        const m = use.find((b) => {
          const label = String(b?.name || b?.key || "").toLowerCase();
          return label.includes("ht/ft") || label.includes("half time / full time");
        });
        if (m) {
          const vals = m.values || m.outcomes || [];
          let got = false;
          for (const v of vals) {
            const lab = String(v?.value||v?.selection||v?.name||"").toLowerCase(); // "home/draw", "away/home"...
            const dec = asDec(v);
            if (!Number.isFinite(dec) || dec < LIMITS.MIN_ODDS) continue;
            const parts = lab.split(/[\/\-]/);
            const a = parts[0]?.includes("home") ? "1" : parts[0]?.includes("draw") ? "X" : parts[0]?.includes("away") ? "2" : null;
            const b = parts[1]?.includes("home") ? "1" : parts[1]?.includes("draw") ? "X" : parts[1]?.includes("away") ? "2" : null;
            if (!a || !b) continue;
            const code = `${a}/${b}`;
            const cur = acc["HT-FT"].map.get(code) || { odd:0, imps:[] };
            if (dec > cur.odd) cur.odd = dec;
            pushImp(cur.imps, dec);
            acc["HT-FT"].map.set(code, cur);
            got = true;
          }
          if (got) acc["HT-FT"].bookies += 1;
        }
      }
    }
  }

  return acc;
}

const avg = (a)=> a && a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;

/* ---------------- handler ---------------- */
export default async function handler(req, res){
  if (!isAllowed(req)) {
    res.setHeader("Cache-Control","no-store");
    return res.status(403).json({ error:"forbidden", note:"value-bets is cron/internal only" });
  }
  try{
    RUNTIME.run = 0;

    const ymd = todayYMD();
    const now = Date.now();

    // 1) Fixtures danas (AF)
    let fixtures = await afFetch(`/fixtures?date=${ymd}`);
    fixtures = fixtures.filter(f=>{
      const name = `${f?.league?.name||""} ${f?.league?.country||""}`.trim();
      if (EXCLUDE_RE.test(name)) return false;
      const t = f?.fixture?.date ? new Date(f.fixture.date).getTime() : NaN;
      return Number.isFinite(t) && t > now;
    });

    const candAll = [];
    let scanned = 0;

    for (const fx of fixtures) {
      if (candAll.length >= LIMITS.PASS1_CAP) break;
      if (scanned >= LIMITS.MAX_FIX_SCAN) break;
      scanned++;

      const fid = Number(fx?.fixture?.id);
      if (!fid) continue;

      const kickoff = fx?.fixture?.date ? new Date(fx.fixture.date) : null;
      if (!kickoff) continue;
      const tsISO = kickoff.toISOString();

      // 2) Kvote: AF /odds, pa fallback (samo 1X2)
      let oddsResp = [];
      try { oddsResp = await afFetch(`/odds?fixture=${fid}`); } catch { oddsResp = []; }
      if (!Array.isArray(oddsResp) || !oddsResp.length) {
        const fb = await oddsFallbackInternal(req, {
          home: fx?.teams?.home?.name || "",
          away: fx?.teams?.away?.name || "",
          tsISO
        });
        if (fb) oddsResp = fb;
      }
      if (!Array.isArray(oddsResp) || !oddsResp.length) continue;

      const norm = normalizeOdds(oddsResp);

      // 3) Predictions (1X2) – opcionalno
      let pred = null;
      try { const pr = await afFetch(`/predictions?fixture=${fid}`); pred = normPred1x2(pr); } catch {}

      // 4) Helper za push kandidata
      const pushCand = ({ market, market_label, selection, odds, p, implied, bookies, scoreBias=0, explain })=>{
        if (!odds || odds < LIMITS.MIN_ODDS) return;
        if (!(p >= 0 && p <= 1)) return;
        if (bookies < LIMITS.MIN_BOOKIES) return;
        const ev = p*(odds-1) - (1-p);
        const edgePP = Math.round((p - (implied ?? impliedFromDecimal(odds) ?? 0)) * 1000) / 10;
        candAll.push({
          type: "MODEL+ODDS",
          _score: edgePP + scoreBias,
          fixture_id: fid,
          league: { id: fx?.league?.id, name: fx?.league?.name, country: fx?.league?.country },
          teams: { home: fx?.teams?.home?.name, away: fx?.teams?.away?.name },
          home_id: fx?.teams?.home?.id,
          away_id: fx?.teams?.away?.id,
          datetime_local: { starting_at: { date_time: toLocalISO(kickoff) } },
          market, market_label, selection,
          confidence_pct: Math.min(99, Math.max(1, Math.round(p*100))),
          model_prob: p, market_odds: odds,
          implied_prob: implied ?? impliedFromDecimal(odds),
          edge_pp: edgePP,
          bookmakers_count: bookies,
          movement_pct: 0,
          explain
        });
      };

      /* ----- 1X2 ----- */
      {
        const bestH = norm["1X2"].HOME, bestD = norm["1X2"].DRAW, bestA = norm["1X2"].AWAY;
        const bks   = norm["1X2"].bookies;
        const pH = pred?.key==="HOME" ? (pred.pct/100) : (avg(norm["1X2"].imps.H) ?? null);
        const pD = pred?.key==="DRAW" ? (pred.pct/100) : (avg(norm["1X2"].imps.D) ?? null);
        const pA = pred?.key==="AWAY" ? (pred.pct/100) : (avg(norm["1X2"].imps.A) ?? null);

        if (bestH) pushCand({
          market:"1X2", market_label:"1X2", selection:"HOME", odds:bestH,
          p: pH ?? avg(norm["1X2"].imps.H) ?? 0,
          implied: avg(norm["1X2"].imps.H) ?? impliedFromDecimal(bestH),
          bookies:bks, scoreBias: pred?.key==="HOME"?0.2:0,
          explain:{ summary:`Model ${pH?Math.round(pH*100):Math.round((avg(norm["1X2"].imps.H)||0)*100)}% · Bookies ${bks}` }
        });
        if (bestD) pushCand({
          market:"1X2", market_label:"1X2", selection:"DRAW", odds:bestD,
          p: pD ?? avg(norm["1X2"].imps.D) ?? 0,
          implied: avg(norm["1X2"].imps.D) ?? impliedFromDecimal(bestD),
          bookies:bks, scoreBias: pred?.key==="DRAW"?0.2:0,
          explain:{ summary:`Model ${pD?Math.round(pD*100):Math.round((avg(norm["1X2"].imps.D)||0)*100)}% · Bookies ${bks}` }
        });
        if (bestA) pushCand({
          market:"1X2", market_label:"1X2", selection:"AWAY", odds:bestA,
          p: pA ?? avg(norm["1X2"].imps.A) ?? 0,
          implied: avg(norm["1X2"].imps.A) ?? impliedFromDecimal(bestA),
          bookies:bks, scoreBias: pred?.key==="AWAY"?0.2:0,
          explain:{ summary:`Model ${pA?Math.round(pA*100):Math.round((avg(norm["1X2"].imps.A)||0)*100)}% · Bookies ${bks}` }
        });
      }

      /* ----- BTTS ----- */
      {
        const bestYes = norm["BTTS"].YES, bestNo = norm["BTTS"].NO, bks = norm["BTTS"].bookies;
        const pYes = avg(norm["BTTS"].imps.YES);
        const pNo  = avg(norm["BTTS"].imps.NO);
        if (bestYes) pushCand({
          market:"BTTS", market_label:"BTTS", selection:"YES", odds:bestYes, p:pYes ?? 0,
          implied:pYes ?? impliedFromDecimal(bestYes), bookies:bks,
          explain:{ summary:`Bookies ${bks} · Avg implied ${pYes?Math.round(pYes*100):"-"}%` }
        });
        if (bestNo) pushCand({
          market:"BTTS", market_label:"BTTS", selection:"NO", odds:bestNo, p:pNo ?? 0,
          implied:pNo ?? impliedFromDecimal(bestNo), bookies:bks,
          explain:{ summary:`Bookies ${bks} · Avg implied ${pNo?Math.round(pNo*100):"-"}%` }
        });
      }

      /* ----- Over/Under (prefer 2.5; label mora biti "OU <line>") ----- */
      {
        let pickLine = 2.5;
        if (!norm["OU"].lines.has(2.5)) {
          let bestL = null, bestCnt = -1;
          for (const [line, rec] of norm["OU"].lines.entries()) {
            if ((rec.bookies||0) > bestCnt) { bestCnt = rec.bookies||0; bestL = line; }
          }
          if (bestL != null) pickLine = bestL;
        }
        const rec = norm["OU"].lines.get(pickLine);
        if (rec) {
          const pOver = avg(rec.imps.OVER);
          const pUnder= avg(rec.imps.UNDER);
          if (rec.OVER) pushCand({
            market:`Over ${pickLine}`, market_label:`OU ${pickLine}`, selection:"OVER",
            odds:rec.OVER, p:pOver ?? 0, implied:pOver ?? impliedFromDecimal(rec.OVER),
            bookies: rec.bookies,
            explain:{ summary:`OU ${pickLine} · Bookies ${rec.bookies} · Avg implied ${pOver?Math.round(pOver*100):"-"}%` }
          });
          if (rec.UNDER) pushCand({
            market:`Under ${pickLine}`, market_label:`OU ${pickLine}`, selection:"UNDER",
            odds:rec.UNDER, p:pUnder ?? 0, implied:pUnder ?? impliedFromDecimal(rec.UNDER),
            bookies: rec.bookies,
            explain:{ summary:`OU ${pickLine} · Bookies ${rec.bookies} · Avg implied ${pUnder?Math.round(pUnder*100):"-"}%` }
          });
        }
      }

      /* ----- HT-FT (label mora biti "HT-FT") ----- */
      {
        const bks = norm["HT-FT"].bookies || 0;
        for (const [code, rec] of norm["HT-FT"].map.entries()) {
          const pCode = avg(rec.imps);
          if (rec.odd) pushCand({
            market:"HT-FT", market_label:"HT-FT", selection:code,
            odds:rec.odd, p:pCode ?? 0, implied:pCode ?? impliedFromDecimal(rec.odd),
            bookies:bks, explain:{ summary:`HT-FT ${code} · Bookies ${bks}` }
          });
        }
      }
    }

    // sortiranje: edge pa kickoff
    candAll.sort((a,b)=> {
      if ((b._score||0)!==(a._score||0)) return (b._score||0)-(a._score||0);
      const ta=new Date(a?.datetime_local?.starting_at?.date_time?.replace(" ","T")||0).getTime();
      const tb=new Date(b?.datetime_local?.starting_at?.date_time?.replace(" ","T")||0).getTime();
      return ta-tb;
    });

    const filtered = candAll.filter(c => (c.edge_pp ?? -999) >= SAFE_EDGE_MIN_PP && (c.bookmakers_count||0) >= LIMITS.MIN_BOOKIES);
    const out = (filtered.length ? filtered : candAll).slice(0, LIMITS.PASS1_CAP);

    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({ value_bets: out });
  }catch(e){
    res.setHeader("Cache-Control","no-store");
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}
