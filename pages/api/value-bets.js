// pages/api/value-bets.js
// Lightweight generator: 1 API call (odds) po meču, blaži uslovi konsenzusa,
// jedan najbolji predlog po meču (1X2 / BTTS YES / OU 2.5 OVER).

export const config = { api: { bodyParser: false } };

// ---------- ENV ----------
const BASE = "https://v3.football.api-sports.io";
const TZ   = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Minimalna kvota (možeš u env): 1.50 default
const MIN_ODDS = parseFloat(process.env.MIN_ODDS || "1.50");

// Konsenzus pragovi (blaži)
const TRUSTED_BOOKIES = String(process.env.TRUSTED_BOOKIES || "")
  .split(/[,|]/).map(s => s.trim().toLowerCase()).filter(Boolean);

const TRUSTED_SPREAD_MAX = parseFloat(process.env.TRUSTED_SPREAD_MAX || "0.15"); // 15%
const ALL_SPREAD_MAX     = parseFloat(process.env.ALL_SPREAD_MAX     || "0.20"); // 20%
const ONE_TRUSTED_TOL    = parseFloat(process.env.ONE_TRUSTED_TOL    || "0.08"); // 8%

// Limit mečeva koje obrađujemo (smanji rate-limit udare)
const VB_CANDIDATE_MAX = parseInt(process.env.VB_CANDIDATE_MAX || "60", 10);

// ---------- helpers: time ----------
function ymdTZ(d = new Date(), tz = TZ) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d);
  } catch {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}

// ---------- API-Football fetch ----------
async function afGet(path) {
  const key =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key, Accept: "application/json" },
    cache: "no-store",
  });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const txt = await r.text().catch(() => "");
    throw new Error(`AF ${path} ${r.status}: ${txt.slice(0, 180)}`);
  }
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

// ---------- math utils ----------
function median(arr){ const a=[...arr].sort((x,y)=>x-y); const n=a.length; if(!n)return null; return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2; }
function spreadRatioImplied(odds){
  const imps = odds.map(o => 1/Number(o)).filter(v => Number.isFinite(v) && v>0);
  if (!imps.length) return null;
  const min = Math.min(...imps), max = Math.max(...imps);
  if (min <= 0) return null;
  return (max - min) / ((max + min) / 2); // relativni raspon
}
const norm = s => String(s||"").trim().toLowerCase();

// ---------- KV (opciono overlay za +/− pp) ----------
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
async function kvGET(key){
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers:{Authorization:`Bearer ${KV_TOKEN}` }});
  if (!r.ok) return null;
  try { const js=await r.json(); return js && typeof js==="object" && "result" in js ? js.result : js; } catch { return null; }
}
async function loadOverlay(){
  try{
    const raw = await kvGET("learn:overlay:current");
    const v = typeof raw==="string" ? JSON.parse(raw) : raw;
    return v && typeof v==="object" ? v : {};
  }catch{return {}}
}
function overlayFor(overlay, leagueId, market){
  try{
    const o = overlay?.[String(leagueId)]?.[market];
    return typeof o==="number" ? o : 0;
  }catch{return 0}
}

// ---------- parse odds ----------
function collectOddsFromAF(oddsResponse){
  const out = {
    x12: { home:[], draw:[], away:[] },
    btts: { yes:[] },
    ou25: { over:[] }
  };
  for (const item of oddsResponse||[]){
    const books = item?.bookmakers || [];
    for (const bk of books){
      const book = norm(bk?.name);
      const bets = bk?.bets || [];
      for (const bet of bets){
        const name = norm(bet?.name);
        const values = bet?.values || [];

        // 1X2
        if (name.includes("match winner") || name === "1x2" || name.includes("winner")){
          for (const v of values){
            const val = String(v?.value||"").toLowerCase();
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || odd <= 1.02) continue;
            if (val.includes("home") || val === "1") out.x12.home.push({book,odds:odd});
            else if (val.includes("draw") || val === "x") out.x12.draw.push({book,odds:odd});
            else if (val.includes("away") || val === "2") out.x12.away.push({book,odds:odd});
          }
        }

        // BTTS YES
        if (name.includes("both teams") || name.includes("btts")){
          for (const v of values){
            const val = String(v?.value||"").toLowerCase();
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || odd <= 1.02) continue;
            if (val.includes("yes")) out.btts.yes.push({book,odds:odd});
          }
        }

        // OU 2.5 OVER
        if (name.includes("over/under") || name.includes("goals over/under") || name.includes("totals")){
          for (const v of values){
            const label = norm(v?.value||v?.label);
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || odd <= 1.02) continue;
            if (label.includes("over 2.5") || label === "2.5" || (label.includes("over") && label.includes("2.5"))){
              out.ou25.over.push({book,odds:odd});
            }
          }
        }
      }
    }
  }
  return out;
}

function pickConsensusOdds(pairs){
  if (!pairs || pairs.length < 3) return null; // tražimo bar 3 kladionice total

  const all = pairs.map(p=>p.odds).filter(Number.isFinite);
  if (!all.length) return null;

  const trusted = pairs.filter(p => TRUSTED_BOOKIES.includes(p.book)).map(p=>p.odds);
  const trCount = trusted.length;
  const allSpread = spreadRatioImplied(all);

  // 2+ trusted i mali spread → median trusted (sa blagim capom)
  if (trCount >= 2){
    const trSpread = spreadRatioImplied(trusted);
    if (trSpread != null && trSpread <= TRUSTED_SPREAD_MAX){
      const tMed = median(trusted);
      const tMax = Math.max(...trusted);
      const capped = Math.min(tMax, tMed * 1.06); // blaži cap 6%
      return { odds: capped, bookmakers_count: all.length, bookmakers_count_trusted: trCount, src:"trusted≥2" };
    }
  }

  // 1 trusted + ≥5 all i blizu medijane all (±8%)
  if (trCount === 1 && all.length >= 5){
    const aMed = median(all);
    const tOnly = trusted[0];
    if (aMed>0 && Math.abs(aMed - tOnly)/tOnly <= ONE_TRUSTED_TOL){
      return { odds: aMed, bookmakers_count: all.length, bookmakers_count_trusted: 1, src:"trusted=1+all" };
    }
  }

  // bez trusted: 6+ all i spread ≤ 20% → median(all)
  if (all.length >= 6 && allSpread != null && allSpread <= ALL_SPREAD_MAX){
    return { odds: median(all), bookmakers_count: all.length, bookmakers_count_trusted: 0, src:"all-median" };
  }

  // fallback: ako ima ≥8 all bez trusted, uzmi median bez spread provere (da ne ostanemo prazni)
  if (all.length >= 8){
    return { odds: median(all), bookmakers_count: all.length, bookmakers_count_trusted: 0, src:"all-median(fallback)" };
  }

  return null;
}

// ---------- Confidence ----------
function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }
function withConfidence(basePctGuess, bookmakersCount, trustedCount, overlayPP = 0) {
  // Nemamo Poisson model ovde → basePctGuess postavi 60 kao default,
  // pa ga modifikuj po “snazi” konsenzusa.
  let c = Number.isFinite(basePctGuess) ? Math.round(basePctGuess) : 60;

  if (bookmakersCount >= 6)  c += 2;
  if (bookmakersCount >= 10) c += 2;
  if (bookmakersCount >= 14) c += 1;

  if (trustedCount >= 1) c += 1;
  if (trustedCount >= 3) c += 2;
  if (trustedCount >= 5) c += 1;

  c += Math.max(-3, Math.min(3, Math.round(overlayPP)));

  return clamp(c, 35, 97); // dozvoljava Top ≥ 90%
}

// ---------- make pick ----------
function makePick({ fixture, market, selection, consensus, overlayPP }){
  const baseGuess =
    market === "1X2"
      ? (selection === "HOME" ? 64 : selection === "AWAY" ? 58 : 40)
      : (market === "BTTS" ? 62 : 60);

  const conf = withConfidence(
    baseGuess,
    Number(consensus?.bookmakers_count || 0),
    Number(consensus?.bookmakers_count_trusted || 0),
    overlayPP || 0
  );

  return {
    fixture_id: fixture?.fixture?.id,
    teams: {
      home: { id: fixture?.teams?.home?.id, name: fixture?.teams?.home?.name },
      away: { id: fixture?.teams?.away?.id, name: fixture?.teams?.away?.name },
    },
    league: {
      id: fixture?.league?.id,
      name: fixture?.league?.name,
      country: fixture?.league?.country,
      season: fixture?.league?.season,
    },
    datetime_local: {
      starting_at: { date_time: String(fixture?.fixture?.date || "").replace(" ","T") },
    },
    market,
    market_label: market,
    selection,
    type: "ODDS-CONSENSUS",
    model_prob: null, // bez modela u light modu
    market_odds: Number(consensus?.odds || 0),
    implied_prob: (Number(consensus?.odds) > 0) ? 1/Number(consensus.odds) : null,
    edge: null,
    edge_pp: null,
    ev: null,
    movement_pct: 0,
    confidence_pct: conf,
    bookmakers_count: Number(consensus?.bookmakers_count || 0),
    bookmakers_count_trusted: Number(consensus?.bookmakers_count_trusted || 0),
    explain: {
      summary: `Consensus ${consensus?.bookmakers_count} (trusted ${consensus?.bookmakers_count_trusted})`,
      bullets: [],
    },
  };
}

// ---------- handler ----------
export default async function handler(req, res){
  try{
    const overlay = await loadOverlay();
    const date = ymdTZ(); // danas po TZ

    // 1) Uzmi današnje mečeve
    const fixtures = await afGet(`/fixtures?date=${date}`);
    const todays = fixtures.filter(fx => {
      const st = String(fx?.fixture?.status?.short || "").toUpperCase();
      return (st === "NS" || st === "TBD"); // još nisu počeli
    });

    // Cap da se ne probije rate limit
    const LIMIT = Math.min(todays.length, VB_CANDIDATE_MAX);
    const outByFixture = new Map();
    let calls_used = 1;

    for (let i=0; i<LIMIT; i++){
      const fx = todays[i];
      const fid = fx?.fixture?.id;
      if (!fid) continue;

      // 2) Kvotne linije (1 poziv po meču)
      let oddsRaw = [];
      try { oddsRaw = await afGet(`/odds?fixture=${fid}`); calls_used++; } catch {}
      if (!Array.isArray(oddsRaw) || oddsRaw.length === 0) continue;

      const perBook = collectOddsFromAF(oddsRaw);

      // 3) Izračunaj konsenzus za svaki podržani market
      const cX12H = pickConsensusOdds(perBook.x12.home);
      const cX12D = pickConsensusOdds(perBook.x12.draw);
      const cX12A = pickConsensusOdds(perBook.x12.away);
      const cBTTS = pickConsensusOdds(perBook.btts.yes);
      const cOUov = pickConsensusOdds(perBook.ou25.over);

      // 4) Odaberi JEDAN market za ovaj meč (po prioritetu i dostupnosti)
      const candidates = [];

      if (cX12H && cX12H.odds >= MIN_ODDS){
        candidates.push({ market:"1X2", selection:"HOME", consensus:cX12H, score: scoreConsensus(cX12H) });
      }
      if (cX12A && cX12A.odds >= MIN_ODDS){
        candidates.push({ market:"1X2", selection:"AWAY", consensus:cX12A, score: scoreConsensus(cX12A) });
      }
      // 1X2 DRAW retko ima smisla za MIN_ODDS≥1.5 — preskačemo ga da ne “trošimo” slotove

      if (cBTTS && cBTTS.odds >= MIN_ODDS){
        candidates.push({ market:"BTTS", selection:"YES", consensus:cBTTS, score: scoreConsensus(cBTTS) + 0.5 });
      }

      if (cOUov && cOUov.odds >= MIN_ODDS){
        candidates.push({ market:"OU", selection:"OVER 2.5", consensus:cOUov, score: scoreConsensus(cOUov) });
      }

      if (!candidates.length) continue;

      // 5) Izaberi najboljeg po “snazi” konsenzusa
      candidates.sort((a,b)=> b.score - a.score);
      const best = candidates[0];

      const overlayPP = overlayFor(overlay, fx?.league?.id, best.market);
      const pick = makePick({
        fixture: fx,
        market: best.market,
        selection: best.selection,
        consensus: best.consensus,
        overlayPP
      });

      outByFixture.set(pick.fixture_id, pick);
    }

    // sortiraj po confidence pa po ranijem KO
    const out = Array.from(outByFixture.values()).sort((a,b)=>{
      if ((b?.confidence_pct||0) !== (a?.confidence_pct||0)) return (b.confidence_pct||0)-(a.confidence_pct||0);
      const ta = Number(new Date(a?.datetime_local?.starting_at?.date_time||0));
      const tb = Number(new Date(b?.datetime_local?.starting_at?.date_time||0));
      return ta - tb;
    });

    res.status(200).json({
      value_bets: out,
      generated_at: new Date().toISOString(),
      calls_used
    });
  }catch(e){
    res.status(500).json({ error: String(e?.message || e) });
  }
}

// “snaga” konsenzusa radi rangiranja markets za isti meč
function scoreConsensus(cns){
  const all = Number(cns?.bookmakers_count||0);
  const tr  = Number(cns?.bookmakers_count_trusted||0);
  return all + tr*1.5;
}
