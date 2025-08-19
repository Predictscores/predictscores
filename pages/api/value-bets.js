// Generator kandidata za dnevni snapshot.
// Marketi: 1X2 + BTTS(Yes) + Over 2.5 + HT-FT
// - koristi kvote kad postoje (MODEL+ODDS), za BTTS/OU Poisson fallback (MODEL) kad nema kvota
// - SAFE favorit: kvota >=1.50, model_prob >=0.65, EV >= -0.005
// - Confidence nudge po broju bukija (+1pp za 6+, +2pp za 10+)

export const config = { api: { bodyParser: false } };

const BASE = "https://v3.football.api-sports.io";
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// -------- helpers: fetch ----------
async function afGet(path) {
  const key =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key, "x-rapidapi-key": key },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

// -------- time helpers ------------
function ymdTZ(d=new Date()) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
    }).format(d); // YYYY-MM-DD
  } catch {
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), da=String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  }
}

// -------- filters (ligas/teams) ----
function isExcludedLeagueOrTeam(fx) {
  const ln = String(fx?.league?.name || "").toLowerCase();
  const hn = String(fx?.teams?.home?.name || "").toLowerCase();
  const an = String(fx?.teams?.away?.name || "").toLowerCase();
  const bad = /(women|femenin|femmin|ladies|u19|u21|u23|youth|reserve|res\.?)/i;
  return bad.test(ln) || bad.test(hn) || bad.test(an);
}

// -------- Poisson math ------------
function poissonPMF(lambda, k) {
  if (lambda <= 0) return (k === 0) ? 1 : 0;
  let logP = -lambda, term = 0;
  for (let i = 1; i <= k; i++) term += Math.log(lambda) - Math.log(i);
  logP += term;
  return Math.exp(logP);
}
function probMatrix(lambdaH, lambdaA, K=10) {
  const pH = Array.from({length:K+1}, (_,i)=>poissonPMF(lambdaH,i));
  const pA = Array.from({length:K+1}, (_,i)=>poissonPMF(lambdaA,i));
  // add tail mass to K
  const tailH = 1 - pH.reduce((a,x)=>a+x,0); if (tailH>0) pH[K]+=tailH;
  const tailA = 1 - pA.reduce((a,x)=>a+x,0); if (tailA>0) pA[K]+=tailA;
  return { pH, pA };
}
function prob1X2(lambdaH, lambdaA) {
  const { pH, pA } = probMatrix(lambdaH, lambdaA, 10);
  let pHome=0, pDraw=0, pAway=0;
  for (let i=0;i<pH.length;i++) {
    for (let j=0;j<pA.length;j++) {
      const p = pH[i]*pA[j];
      if (i>j) pHome += p; else if (i===j) pDraw += p; else pAway += p;
    }
  }
  return { pHome, pDraw, pAway };
}
function probOver25(lambdaH, lambdaA) {
  const { pH, pA } = probMatrix(lambdaH, lambdaA, 10);
  let pUnderEq2 = 0;
  for (let i=0;i<pH.length;i++) {
    for (let j=0;j<pA.length;j++) {
      if (i+j <= 2) pUnderEq2 += pH[i]*pA[j];
    }
  }
  return 1 - pUnderEq2;
}
function probBTTS(lambdaH, lambdaA) {
  // 1 - P(H=0) - P(A=0) + P(H=0,A=0)
  const pH0 = poissonPMF(lambdaH,0);
  const pA0 = poissonPMF(lambdaA,0);
  return 1 - pH0 - pA0 + (pH0*pA0);
}

// -------- model rates from L5 ------
function avgGoalsFor(list, teamId) {
  if (!Array.isArray(list) || !list.length) return 1.2; // neutral fallback
  let gf = 0, n=0;
  for (const fx of list.slice(0,5)) {
    const sc = fx.score?.fulltime || fx.score || {};
    const h = Number(sc.home ?? fx.goals?.home ?? 0);
    const a = Number(sc.away ?? fx.goals?.away ?? 0);
    const hid = fx.teams?.home?.id, aid = fx.teams?.away?.id;
    if (hid==null || aid==null) continue;
    const my = (hid === teamId) ? h : a;
    gf += my; n++;
  }
  return n ? gf/n : 1.2;
}
function avgGoalsAgainst(list, teamId) {
  if (!Array.isArray(list) || !list.length) return 1.2;
  let ga = 0, n=0;
  for (const fx of list.slice(0,5)) {
    const sc = fx.score?.fulltime || fx.score || {};
    const h = Number(sc.home ?? fx.goals?.home ?? 0);
    const a = Number(sc.away ?? fx.goals?.away ?? 0);
    const hid = fx.teams?.home?.id, aid = fx.teams?.away?.id;
    if (hid==null || aid==null) continue;
    const opp = (hid === teamId) ? a : h;
    ga += opp; n++;
  }
  return n ? ga/n : 1.2;
}
function deriveLambdas(hLast, aLast, homeId, awayId) {
  const hGF = avgGoalsFor(hLast, homeId);
  const hGA = avgGoalsAgainst(hLast, homeId);
  const aGF = avgGoalsFor(aLast, awayId);
  const aGA = avgGoalsAgainst(aLast, awayId);
  // jednostavan blend napada domaćina sa odbranom gosta, i obrnuto
  const lambdaH = Math.max(0.05, (hGF + aGA) / 2);
  const lambdaA = Math.max(0.05, (aGF + hGA) / 2);
  return { lambdaH, lambdaA };
}

// -------- odds parsing --------------
function normalizeMarketName(name="") {
  const s = name.toLowerCase();
  if (s.includes("match winner") || s.includes("1x2")) return "1X2";
  if (s.includes("both teams to score")) return "BTTS";
  if (s.includes("over/under") || s.includes("goals over/under")) return "OU";
  if (s.includes("half time/full time") || s.includes("ht/ft")) return "HTFT";
  return name;
}
function readBestOddsAndCount(oddsResponse) {
  // oddsResponse: API-Football /odds?fixture=...
  const out = {
    "1X2": { H:{odds:null,count:0}, D:{odds:null,count:0}, A:{odds:null,count:0} },
    "BTTS": { YES:{odds:null,count:0}, NO:{odds:null,count:0} },
    "OU": { OVER25:{odds:null,count:0}, UNDER25:{odds:null,count:0} },
    "HTFT": {
      "H/H":{odds:null,count:0},"H/D":{odds:null,count:0},"H/A":{odds:null,count:0},
      "D/H":{odds:null,count:0},"D/D":{odds:null,count:0},"D/A":{odds:null,count:0},
      "A/H":{odds:null,count:0},"A/D":{odds:null,count:0},"A/A":{odds:null,count:0},
    }
  };

  function mapHTFTValue(vRaw) {
    const s = String(vRaw||"").toUpperCase().replace(/\s+/g,"");
    const repl = s
      .replace(/^HOME/,"H").replace(/\/HOME/,"/H")
      .replace(/^AWAY/,"A").replace(/\/AWAY/,"/A")
      .replace(/^DRAW/,"D").replace(/\/DRAW/,"/D")
      .replace(/^1/,"H").replace(/\/1/,"/H")
      .replace(/^2/,"A").replace(/\/2/,"/A")
      .replace(/^X/,"D").replace(/\/X/,"/D");
    const ok = ["H/H","H/D","H/A","D/H","D/D","D/A","A/H","A/D","A/A"];
    return ok.includes(repl) ? repl : null;
  }

  for (const book of oddsResponse) {
    const bmList = book?.bookmakers || [];
    for (const bm of bmList) {
      const bets = bm?.bets || [];
      for (const bet of bets) {
        const m = normalizeMarketName(bet?.name || "");
        const values = bet?.values || [];
        if (m === "1X2") {
          for (const v of values) {
            const val = (v?.value || "").toUpperCase();
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd<=1.0) continue;
            if (val.includes("HOME") || val==="1") {
              out["1X2"].H.odds = Math.max(out["1X2"].H.odds || 0, odd);
              out["1X2"].H.count += 1;
            } else if (val.includes("DRAW") || val==="X") {
              out["1X2"].D.odds = Math.max(out["1X2"].D.odds || 0, odd);
              out["1X2"].D.count += 1;
            } else if (val.includes("AWAY") || val==="2") {
              out["1X2"].A.odds = Math.max(out["1X2"].A.odds || 0, odd);
              out["1X2"].A.count += 1;
            }
          }
        } else if (m === "BTTS") {
          for (const v of values) {
            const val = (v?.value || "").toUpperCase();
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd<=1.0) continue;
            if (val.includes("YES")) {
              out["BTTS"].YES.odds = Math.max(out["BTTS"].YES.odds || 0, odd);
              out["BTTS"].YES.count += 1;
            } else if (val.includes("NO")) {
              out["BTTS"].NO.odds = Math.max(out["BTTS"].NO.odds || 0, odd);
              out["BTTS"].NO.count += 1;
            }
          }
        } else if (m === "OU") {
          for (const v of values) {
            const val = String(v?.value || v?.label || "").toLowerCase();
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd<=1.0) continue;
            if (val.includes("over 2.5") || (val === "2.5" && (v?.handicap==2.5 || v?.line==2.5))) {
              out["OU"].OVER25.odds = Math.max(out["OU"].OVER25.odds || 0, odd);
              out["OU"].OVER25.count += 1;
            } else if (val.includes("under 2.5")) {
              out["OU"].UNDER25.odds = Math.max(out["OU"].UNDER25.odds || 0, odd);
              out["OU"].UNDER25.count += 1;
            }
          }
        } else if (m === "HTFT") {
          for (const v of values) {
            const key = mapHTFTValue(v?.value);
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!key || !Number.isFinite(odd) || odd<=1.0) continue;
            out["HTFT"][key].odds = Math.max(out["HTFT"][key].odds || 0, odd);
            out["HTFT"][key].count += 1;
          }
        }
      }
    }
  }
  return out;
}

// -------- EV / edges ---------------
function impliedFromOdds(odds) { return (Number(odds) > 0) ? (1/Number(odds)) : null; }
function edgeRatio(modelProb, impliedProb) {
  if (!Number.isFinite(modelProb) || !Number.isFinite(impliedProb) || impliedProb<=0) return null;
  return (modelProb / impliedProb) - 1;
}
function edgePP(modelProb, impliedProb) {
  if (!Number.isFinite(modelProb) || !Number.isFinite(impliedProb)) return null;
  return (modelProb - impliedProb) * 100;
}

// -------- confidence nudge ---------
function withConfidence(basePct, bookmakersCount) {
  let c = Math.round(basePct);
  if (bookmakersCount >= 10) c += 2;
  else if (bookmakersCount >= 6) c += 1;
  if (c < 35) c = 35;
  if (c > 85) c = 85;
  return c;
}

// -------- builder for one pick -----
function buildPick({fixture, market, selection, modelProb, odds, bookmakersCount, type="MODEL+ODDS"}) {
  const implied = impliedFromOdds(odds);
  const evRatio = (Number.isFinite(modelProb) && Number.isFinite(implied)) ? (modelProb/implied - 1) : null;
  const evPP = (Number.isFinite(modelProb) && Number.isFinite(implied)) ? ((modelProb - implied) * 100) : null;

  const explain = {};
  if (Number.isFinite(modelProb) && Number.isFinite(implied)) {
    const mp = Math.round(modelProb * 1000) / 10;
    const ip = Math.round(implied * 1000) / 10;
    const evp = Math.round((evRatio ?? 0) * 1000) / 10;
    explain.summary = `Model ${mp}% vs ${ip}% · EV ${evp}% · Bookies ${bookmakersCount||0}`;
  } else {
    const mp = Math.round(modelProb * 1000) / 10;
    explain.summary = `Model ${mp}% (fallback)`;
  }

  const conf = withConfidence((modelProb||0)*100, Number(bookmakersCount||0));

  return {
    fixture_id: fixture?.fixture?.id,
    teams: {
      home: { id: fixture?.teams?.home?.id, name: fixture?.teams?.home?.name },
      away: { id: fixture?.teams?.away?.id, name: fixture?.teams?.away?.name },
    },
    league: {
      id: fixture?.league?.id, name: fixture?.league?.name,
      country: fixture?.league?.country, season: fixture?.league?.season
    },
    datetime_local: {
      starting_at: { date_time: String(fixture?.fixture?.date || "").replace(" ", "T") }
    },
    market,
    market_label: market,
    selection,
    type,
    model_prob: Number(modelProb),
    market_odds: Number.isFinite(odds) ? Number(odds) : null,
    implied_prob: Number.isFinite(implied) ? implied : null,
    edge: Number.isFinite(evRatio) ? evRatio : null,
    edge_pp: Number.isFinite(evPP) ? evPP : null,
    ev: Number.isFinite(evRatio) ? evRatio : null,
    movement_pct: 0,
    confidence_pct: conf,
    bookmakers_count: Number(bookmakersCount || 0),
    explain: { summary: explain.summary, bullets: [] }
  };
}

// -------- main handler ------------
export default async function handler(req, res) {
  try {
    const date = ymdTZ(); // današnji dan po TZ
    // 1) Uzmi sve današnje mečeve koji nisu počeli
    const fixtures = await afGet(`/fixtures?date=${date}`);
    const candidates = fixtures.filter(fx => {
      const st = String(fx?.fixture?.status?.short || "").toUpperCase();
      if (["NS","TBD","PST","SUSP","CANC"].includes(st)) return !isExcludedLeagueOrTeam(fx);
      return false;
    });

    // 2) Za svaki meč uzmi L5 timova i izračunaj lambda & model verovatnoće
    const out = [];
    let calls_used = 1; // fixtures call

    // Safety caps: da ne preteramo
    const MAX_FIX = Math.min(candidates.length, 60);

    for (let idx=0; idx<MAX_FIX; idx++) {
      const fx = candidates[idx];
      const homeId = fx?.teams?.home?.id;
      const awayId = fx?.teams?.away?.id;
      if (!homeId || !awayId) continue;

      // L5
      let hLast=[], aLast=[];
      try { hLast = await afGet(`/fixtures?team=${homeId}&last=5`); calls_used++; } catch {}
      try { aLast = await afGet(`/fixtures?team=${awayId}&last=5`); calls_used++; } catch {}

      const { lambdaH, lambdaA } = deriveLambdas(hLast, aLast, homeId, awayId);
      const { pHome, pDraw, pAway } = prob1X2(lambdaH, lambdaA);
      const pOver25 = probOver25(lambdaH, lambdaA);
      const pBTTS = probBTTS(lambdaH, lambdaA);

      // HT-FT model (gruba aproksimacija): HT lambde ≈ 0.5 * FT lambde
      const { pHome: pHT_H, pDraw: pHT_D, pAway: pHT_A } = prob1X2(lambdaH*0.5, lambdaA*0.5);

      // 3) Probaj da uzmeš kvote za ovaj fixture (za 1X2/BTTS/OU/HTFT)
      let oddsRaw = [];
      try { oddsRaw = await afGet(`/odds?fixture=${fx?.fixture?.id}`); calls_used++; } catch {}
      const o = readBestOddsAndCount(oddsRaw);

      // --- 1X2 kandidat ---
      const oneX2 = [
        { sel: "1", prob: pHome, odds: o["1X2"].H.odds, count: o["1X2"].H.count, tag: "H" },
        { sel: "X", prob: pDraw, odds: o["1X2"].D.odds, count: o["1X2"].D.count, tag: "D" },
        { sel: "2", prob: pAway, odds: o["1X2"].A.odds, count: o["1X2"].A.count, tag: "A" },
      ].map(x=>{
        const imp = impliedFromOdds(x.odds);
        const er = edgeRatio(x.prob, imp);
        const epp = edgePP(x.prob, imp);
        return { ...x, implied: imp, er, epp };
      });

      const bestEdge = oneX2.filter(x => Number.isFinite(x.er)).sort((a,b)=> (b.er - a.er))[0];
      if (bestEdge && bestEdge.er > 0.02) {
        out.push(buildPick({
          fixture: fx,
          market: "1X2",
          selection: bestEdge.sel,
          modelProb: bestEdge.prob,
          odds: bestEdge.odds,
          bookmakersCount: bestEdge.count,
          type: "MODEL+ODDS"
        }));
      } else {
        // SAFE favorit
        const fav = [oneX2[0], oneX2[2]].sort((a,b)=>b.prob-a.prob)[0]; // home vs away
        if (fav && Number.isFinite(fav.odds) && fav.odds >= 1.5 && f
