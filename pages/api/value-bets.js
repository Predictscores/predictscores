// pages/api/value-bets.js
// Generator kandidata (FOOTBALL) sa trusted-consensus kvotama, 1X2 guard, BTTS 1st Half,
// i "jedan predlog po meču". Ovo se poziva iz /api/cron/rebuild.
//
// UI se ne dira. Snapshot koji /rebuild upiše u KV čita /value-bets-locked.
//
// Napomena: OU market je striktno "Over 2.5 (FT)" — linija je 2.5 (kvota/cena može biti 2.25, 1.95, ...).

export const config = { api: { bodyParser: false } };

// ---------- ENV & CONST ----------
const BASE = "https://v3.football.api-sports.io";
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

const MIN_ODDS = parseFloat(process.env.MIN_ODDS || "1.5");                     // npr 1.50
const TRUSTED_SPREAD_MAX = parseFloat(process.env.TRUSTED_SPREAD_MAX || "0.12"); // 12%
const TRUSTED_UPLIFT_CAP = parseFloat(process.env.TRUSTED_UPLIFT_CAP || "0.08"); // +8% iznad trusted median
const ALL_SPREAD_MAX = parseFloat(process.env.ALL_SPREAD_MAX || "0.12");         // 12%
const ONE_TRUSTED_TOL = parseFloat(process.env.ONE_TRUSTED_TOL || "0.05");       // ±5%

// MAX kandidata po run-u: default 90 (možeš spustiti/dići kroz ENV bez obaveze)
const VB_CANDIDATE_MAX = parseInt(process.env.VB_CANDIDATE_MAX || "90", 10);

const TRUSTED_BOOKIES = (process.env.TRUSTED_BOOKIES || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ---------- helpers: fetch ----------
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

// ---------- time helpers ----------
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

// ---------- filters (leagues/teams) ----------
function isExcludedLeagueOrTeam(fx) {
  const ln = String(fx?.league?.name || "").toLowerCase();
  const hn = String(fx?.teams?.home?.name || "").toLowerCase();
  const an = String(fx?.teams?.away?.name || "").toLowerCase();
  const bad = /(women|femenin|femmin|ladies|u19|u21|u23|youth|reserve|res\.?)/i;
  return bad.test(ln) || bad.test(hn) || bad.test(an);
}

// ---------- Poisson math ----------
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
  const tailH = 1 - pH.reduce((a,x)=>a+x,0); if (tailH>0) pH[K]+=tailH;
  const tailA = 1 - pA.reduce((a,x)=>a+x,0); if (tailA>0) pA[K]+=tailA;
  return { pH, pA };
}
function prob1X2(lambdaH, lambdaA) {
  const { pH, pA } = probMatrix(lambdaH, lambdaA, 10);
  let pHome=0, pDraw=0, pAway=0;
  for (let i=0;i<pH.length;i++) for (let j=0;j<pA.length;j++) {
    const p = pH[i]*pA[j];
    if (i>j) pHome += p; else if (i===j) pDraw += p; else pAway += p;
  }
  return { pHome, pDraw, pAway };
}
function probOver25(lambdaH, lambdaA) {
  const { pH, pA } = probMatrix(lambdaH, lambdaA, 10);
  let pUnderEq2 = 0;
  for (let i=0;i<pH.length;i++) for (let j=0;j<pA.length;j++) {
    if (i+j <= 2) pUnderEq2 += pH[i]*pA[j];
  }
  return 1 - pUnderEq2;
}
function probBTTS(lambdaH, lambdaA) {
  const pH0 = poissonPMF(lambdaH,0);
  const pA0 = poissonPMF(lambdaA,0);
  return 1 - pH0 - pA0 + (pH0*pA0);
}
function probBTTS1H(lambdaH, lambdaA) {
  // Aproks: 1H ≈ 0.5 * FT intenzitet po timu
  return probBTTS(lambdaH*0.5, lambdaA*0.5);
}

// ---------- model rates from L5 ----------
function avgGoalsFor(list, teamId) {
  if (!Array.isArray(list) || !list.length) return 1.2;
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
  const lambdaH = Math.max(0.05, (hGF + aGA) / 2);
  const lambdaA = Math.max(0.05, (aGF + hGA) / 2);
  return { lambdaH, lambdaA };
}

// ---------- odds & consensus ----------
function median(values) {
  if (!values.length) return null;
  const arr = values.slice().sort((a,b)=>a-b);
  const mid = Math.floor(arr.length/2);
  return arr.length % 2 ? arr[mid] : (arr[mid-1] + arr[mid]) / 2;
}
function spreadRatio(values) {
  if (!values.length) return null;
  const mx = Math.max(...values), mn = Math.min(...values);
  if (mn <= 0) return null;
  return (mx / mn) - 1; // e.g. 0.12 = 12%
}
const norm = s => String(s||"").trim().toLowerCase();

function collectOddsFromAF(oddsResponse) {
  const out = {
    oneX2: { H:[], D:[], A:[] },
    bttsYes: [],
    btts1hYes: [],
    over25: [],
    htft: { "H/H":[], "H/D":[], "H/A":[], "D/H":[], "D/D":[], "D/A":[], "A/H":[], "A/D":[], "A/A":[] }
  };
  for (const item of oddsResponse) {
    const bms = item?.bookmakers || [];
    for (const bm of bms) {
      const book = norm(bm?.name);
      const bets = bm?.bets || [];
      for (const bet of bets) {
        const name = norm(bet?.name);
        const values = bet?.values || [];

        // 1X2
        if (name.includes("match winner") || name.includes("1x2")) {
          for (const v of values) {
            const val = String(v?.value || "").toUpperCase();
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd <= 1) continue;
            if (val.includes("HOME") || val==="1") out.oneX2.H.push({book, odds: odd});
            else if (val.includes("DRAW") || val==="X") out.oneX2.D.push({book, odds: odd});
            else if (val.includes("AWAY") || val==="2") out.oneX2.A.push({book, odds: odd});
          }
        }

        // BTTS (FT) YES
        if (name.includes("both") && name.includes("score") && !name.includes("first half") && !name.includes("1st")) {
          for (const v of values) {
            const val = String(v?.value || "").toUpperCase();
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd <= 1) continue;
            if (val.includes("YES")) out.bttsYes.push({book, odds: odd});
          }
        }

        // BTTS 1st Half YES
        if (name.includes("both") && name.includes("score") && (name.includes("first half") || name.includes("1st"))) {
          for (const v of values) {
            const val = String(v?.value || "").toUpperCase();
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd <= 1) continue;
            if (val.includes("YES")) out.btts1hYes.push({book, odds: odd});
          }
        }

        // OU Over 2.5 (FT) — striktno linija 2.5
        if (name.includes("over/under") || name.includes("goals over/under")) {
          for (const v of values) {
            const label = norm(v?.value || v?.label);
            const line = Number(v?.handicap ?? v?.line ?? (label.includes("2.5") ? 2.5 : NaN));
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd <= 1) continue;
            if (Math.abs(line - 2.5) < 1e-6 && (label.includes("over") || label.includes("over 2.5") || label==="2.5")) {
              out.over25.push({book, odds: odd});
            }
          }
        }

        // HTFT
        if (name.includes("half time/full time") || name.includes("ht/ft")) {
          for (const v of values) {
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd <= 1) continue;
            let key = String(v?.value || "").toUpperCase().replace(/\s+/g,"");
            key = key
              .replace(/^HOME/,"H").replace(/\/HOME/,"/H")
              .replace(/^AWAY/,"A").replace(/\/AWAY/,"/A")
              .replace(/^DRAW/,"D").replace(/\/DRAW/,"/D")
              .replace(/^1/,"H").replace(/\/1/,"/H")
              .replace(/^2/,"A").replace(/\/2/,"/A")
              .replace(/^X/,"D").replace(/\/X/,"/D");
            if (out.htft[key]) out.htft[key].push({book, odds: odd});
          }
        }
      }
    }
  }
  return out;
}

function pickConsensusOdds(list) {
  const all = list.map(x=>x.odds);
  if (!all.length) return null;

  const trusted = list.filter(x => TRUSTED_BOOKIES.includes(x.book)).map(x => x.odds);
  const trustedCount = trusted.length;
  const allSpread = spreadRatio(all);

  // A) trusted >= 2
  if (trustedCount >= 2) {
    const tSpread = spreadRatio(trusted);
    if (tSpread != null && tSpread <= TRUSTED_SPREAD_MAX) {
      const tMed = median(trusted);
      const tMax = Math.max(...trusted);
      const capped = Math.min(tMax, tMed * (1 + TRUSTED_UPLIFT_CAP));
      return { odds: capped, src: "trusted≥2", bookmakers_count: all.length, bookmakers_count_trusted: trustedCount };
    }
    return null; // trusted ali preširok spread → nepouzdano
  }

  // B) trusted == 1
  if (trustedCount === 1) {
    const tOnly = trusted[0];
    const aMed = median(all);
    if (aMed && Math.abs(aMed - tOnly) / tOnly <= ONE_TRUSTED_TOL) {
      return { odds: aMed, src: "trusted=1+all", bookmakers_count: all.length, bookmakers_count_trusted: 1 };
    }
    return null; // predaleko od jedinog trusted-a
  }

  // C) trusted == 0
  if (all.length >= 6 && allSpread != null && allSpread <= ALL_SPREAD_MAX) {
    return { odds: median(all), src: "all-median", bookmakers_count: all.length, bookmakers_count_trusted: 0 };
  }
  return null;
}

// ---------- EV / confidence ----------
function impliedFromOdds(odds) { return (Number(odds) > 0) ? (1/Number(odds)) : null; }
function edgeRatio(modelProb, impliedProb) {
  if (!Number.isFinite(modelProb) || !Number.isFinite(impliedProb) || impliedProb<=0) return null;
  return (modelProb / impliedProb) - 1;
}
function withConfidence(basePct, bookmakersCount, trustedCount, overlayPP=0) {
  let c = Math.round(basePct);
  if (bookmakersCount >= 6) c += 1;
  if (bookmakersCount >= 10) c += 1;
  if (trustedCount >= 2) c += 1;
  if (trustedCount >= 4) c += 1;
  c += Math.max(-3, Math.min(3, Math.round(overlayPP))); // learning overlay ±3pp
  if (c < 35) c = 35;
  if (c > 85) c = 85;
  return c;
}

// ---------- learning overlay (opciono, ako postoji u KV) ----------
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
async function kvGET(key){
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
async function loadOverlay(){
  try{
    const raw = await kvGET(`learn:overlay:current`);
    if (!raw) return {};
    const v = (typeof raw==="string") ? JSON.parse(raw) : raw;
    return (v && typeof v==="object") ? v : {};
  }catch{ return {}; }
}
function overlayFor(overlay, leagueId, market){
  try{
    const o = overlay?.[String(leagueId)]?.[market];
    if (typeof o === "number") return o; // pp delta
  }catch{}
  return 0;
}

// ---------- build pick ----------
function buildPick({fixture, market, selection, modelProb, consensus, overlayPP}) {
  if (!consensus || !Number.isFinite(consensus.odds)) return null;
  const odds = Number(consensus.odds);
  if (odds < MIN_ODDS) return null;

  const implied = impliedFromOdds(odds);
  const evRatio = edgeRatio(modelProb, implied);

  const mp = Math.round(modelProb * 1000) / 10;
  const ip = Math.round((implied || 0) * 1000) / 10;
  const evp = Math.round((evRatio || 0) * 1000) / 10;

  const conf = withConfidence((modelProb||0)*100, Number(consensus.bookmakers_count||0), Number(consensus.bookmakers_count_trusted||0), overlayPP);

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
    type: "MODEL+ODDS",
    model_prob: Number(modelProb),
    market_odds: odds,
    implied_prob: implied,
    edge: evRatio,
    edge_pp: Number.isFinite(evRatio) ? ((modelProb - implied) * 100) : null,
    ev: evRatio,
    movement_pct: 0,
    confidence_pct: conf,
    bookmakers_count: Number(consensus.bookmakers_count || 0),
    bookmakers_count_trusted: Number(consensus.bookmakers_count_trusted || 0),
    explain: { summary: `Model ${mp}% vs ${ip}% · EV ${evp}% · Bookies ${consensus.bookmakers_count} (trusted ${consensus.bookmakers_count_trusted})`, bullets: [] }
  };
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const overlay = await loadOverlay(); // može biti prazan {}

    const date = ymdTZ(); // današnji dan po TZ
    const fixtures = await afGet(`/fixtures?date=${date}`);
    const candidates = fixtures.filter(fx => {
      const st = String(fx?.fixture?.status?.short || "").toUpperCase();
      if (["NS","TBD","PST","SUSP","CANC"].includes(st)) return !isExcludedLeagueOrTeam(fx);
      return false;
    });

    const outCandidatesByFixture = new Map();
    let calls_used = 1;

    const MAX_FIX = Math.min(candidates.length, VB_CANDIDATE_MAX);

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
      const pBTTS_H1 = probBTTS1H(lambdaH, lambdaA);

      // HT approximations (za HT-FT)
      const { pHome: pHT_H, pDraw: pHT_D, pAway: pHT_A } = prob1X2(lambdaH*0.5, lambdaA*0.5);

      // Odds
      let oddsRaw = [];
      try { oddsRaw = await afGet(`/odds?fixture=${fx?.fixture?.id}`); calls_used++; } catch {}
      const perBook = collectOddsFromAF(oddsRaw);

      // Kandidati po marketu (sa konsenzusom)
      const cands = [];

      // 1X2 (uz guard EV≥0 ili SAFE prag)
      const oneX2Parts = [
        { sel: "1", prob: pHome, list: perBook.oneX2.H },
        { sel: "X", prob: pDraw, list: perBook.oneX2.D },
        { sel: "2", prob: pAway, list: perBook.oneX2.A },
      ].map(x => ({ sel: x.sel, prob: x.prob, consensus: pickConsensusOdds(x.list) }))
       .filter(x => x.consensus && Number.isFinite(x.consensus.odds))
       .map(x => ({ ...x, ev: edgeRatio(x.prob, impliedFromOdds(x.consensus.odds)) }))
       .filter(x => x.ev != null);

      if (oneX2Parts.length) {
        // biramo najbolji po EV (ali kasnije će "jedan po meču" odlučiti globalno)
        oneX2Parts.sort((a,b)=> b.ev - a.ev);
        const best = oneX2Parts[0];

        // 1X2 guard
        const SAFE = (best.prob >= 0.65 && best.consensus.odds >= MIN_ODDS && best.ev >= -0.005);
        if (best.ev >= 0 || SAFE) {
          const overlayPP = overlayFor(overlay, fx?.league?.id, "1X2");
          const pick = buildPick({ fixture: fx, market: "1X2", selection: best.sel, modelProb: best.prob, consensus: best.consensus, overlayPP });
          if (pick) cands.push({ pick, SAFE });
        }
      }

      // BTTS YES (FT)
      const bttsCns = pickConsensusOdds(perBook.bttsYes);
      if (bttsCns) {
        const overlayPP = overlayFor(overlay, fx?.league?.id, "BTTS");
        const pick = buildPick({ fixture: fx, market: "BTTS", selection: "YES", modelProb: pBTTS, consensus: bttsCns, overlayPP });
        if (pick) cands.push({ pick, SAFE: (pBTTS >= 0.60 && bttsCns.odds >= MIN_ODDS && pick.bookmakers_count >= 6) });
      }

      // BTTS 1st Half YES
      const btts1hCns = pickConsensusOdds(perBook.btts1hYes);
      if (btts1hCns) {
        const overlayPP = overlayFor(overlay, fx?.league?.id, "BTTS1H");
        const pick = buildPick({ fixture: fx, market: "BTTS 1H", selection: "YES", modelProb: pBTTS_H1, consensus: btts1hCns, overlayPP });
        if (pick) cands.push({ pick, SAFE: (pBTTS_H1 >= 0.55 && btts1hCns.odds >= MIN_ODDS && pick.bookmakers_count >= 6) });
      }

      // OU Over 2.5 (FT) — striktno linija 2.5
      const ouCns = pickConsensusOdds(perBook.over25);
      if (ouCns) {
        const overlayPP = overlayFor(overlay, fx?.league?.id, "OU");
        const pick = buildPick({ fixture: fx, market: "OU", selection: "OVER 2.5", modelProb: pOver25, consensus: ouCns, overlayPP });
        if (pick) cands.push({ pick, SAFE: (pOver25 >= 0.60 && ouCns.odds >= MIN_ODDS && pick.bookmakers_count >= 6) });
      }

      // (Opciono) HT-FT — uključi samo kad postoji jasan trusted konsenzus
      const htftKeys = ["H/H","H/D","H/A","D/H","D/D","D/A","A/H","A/D","A/A"];
      const combos = htftKeys.map(k => {
        const cns = pickConsensusOdds(perBook.htft[k]);
        if (!cns || (cns.bookmakers_count_trusted||0) < 2) return null;
        const modelHT = { H: pHT_H, D: pHT_D, A: pHT_A };
        const modelFT = { H: pHome,  D: pDraw,  A: pAway };
        const [ht, ft] = k.split("/");
        const prob = (modelHT[ht]||0) * (modelFT[ft]||0);
        return { k, prob, consensus: cns };
      }).filter(Boolean)
        .map(x => ({ ...x, ev: edgeRatio(x.prob, impliedFromOdds(x.consensus.odds)) }))
        .filter(x => x.ev != null)
        .sort((a,b)=> b.ev - a.ev);
      if (combos.length && combos[0].ev > 0.02) {
        const best = combos[0];
        const overlayPP = overlayFor(overlay, fx?.league?.id, "HT-FT");
        const pick = buildPick({ fixture: fx, market: "HT-FT", selection: best.k, modelProb: best.prob, consensus: best.consensus, overlayPP });
        if (pick) cands.push({ pick, SAFE: (best.prob >= 0.60 && pick.bookmakers_count_trusted >= 2) });
      }

      // ---- Jedan predlog po meču (globalno) ----
      if (cands.length) {
        // Rang: SAFE → viši confidence → veći EV → skoriji kickoff
        cands.sort((a,b)=>{
          if ((b.SAFE?1:0) !== (a.SAFE?1:0)) return (b.SAFE?1:0) - (a.SAFE?1:0);
          if (b.pick.confidence_pct !== a.pick.confidence_pct) return b.pick.confidence_pct - a.pick.confidence_pct;
          const eva = Number.isFinite(a.pick.ev) ? a.pick.ev : -Infinity;
          const evb = Number.isFinite(b.pick.ev) ? b.pick.ev : -Infinity;
          if (evb !== eva) return evb - eva;
          const ta = Number(new Date(a.pick?.datetime_local?.starting_at?.date_time || 0).getTime());
          const tb = Number(new Date(b.pick?.datetime_local?.starting_at?.date_time || 0).getTime());
          return ta - tb;
        });
        const best = cands[0].pick;
        outCandidatesByFixture.set(best.fixture_id, best);
      }
    }

    // Finalni output (jedan po meču)
    const out = Array.from(outCandidatesByFixture.values());

    // Globalno sortiranje radi lepšeg prikaza
    out.sort((a, b) => {
      if (b.confidence_pct !== a.confidence_pct) return b.confidence_pct - a.confidence_pct;
      const eva = Number.isFinite(a.ev) ? a.ev : -Infinity;
      const evb = Number.isFinite(b.ev) ? b.ev : -Infinity;
      if (evb !== eva) return evb - eva;
      const ta = Number(new Date(a?.datetime_local?.starting_at?.date_time || 0).getTime());
      const tb = Number(new Date(b?.datetime_local?.starting_at?.date_time || 0).getTime());
      return ta - tb;
    });

    res.status(200).json({
      value_bets: out,
      generated_at: new Date().toISOString(),
      calls_used
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
