// FILE: pages/api/football.js
// Vraća listu predloga po slotu: prvo LOCKED, ako je prazno → /api/value-bets fallback.
// Drži BAN, min kvotu, cap i tier-boost (za fallback slučaj).
// UI čita odavde za Football tab; Combined koristi :last (learning job).

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.5);
const WEEKDAY_CAP = intFrom(process.env.SLOT_WEEKDAY_CAP, 15);
const WEEKEND_CAP = intFrom(process.env.SLOT_WEEKEND_CAP, 25);

const BAN_REGEX =
  /(?:^|[^A-Za-z0-9])U\s*-?\s*\d{1,2}s?(?:[^A-Za-z0-9]|$)|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

const TIER1 = makeSet([
  "UEFA Champions League","UEFA Europa League","UEFA Europa Conference League",
  "UEFA Champions League Qualification","UEFA Europa League Qualification",
  "UEFA Europa Conference League Qualification",
  "Premier League","LaLiga","Serie A","Bundesliga","Ligue 1",
  "Eredivisie","Primeira Liga","Pro League","Süper Lig","Super Lig","Premiership",
  "Austrian Bundesliga","Swiss Super League",
  "SuperLiga","Serbian SuperLiga"
]);
const TIER2 = makeSet([
  "Championship","LaLiga2","Serie B","2. Bundesliga","Ligue 2",
  "Scottish Premiership","Scottish Championship",
  "Danish Superliga","Superligaen","Ekstraklasa","Eliteserien","Allsvenskan",
  "Czech Liga","Romania Liga I","Croatia HNL","Poland Ekstraklasa",
  "Norway Eliteserien","Sweden Allsvenskan",
  "MLS","Argentina Liga Profesional","Brazil Serie A"
]);

export default async function handler(req, res){
  try{
    const slot = String(req.query?.slot || "am").toLowerCase();
    const noRebuild = String(req.query?.norebuild || "").trim() === "1";
    if (!["am","pm","late"].includes(slot)){
      return res.status(200).json({ ok:false, error:"invalid slot" });
    }

    const origin = getOrigin(req);

    // 1) pokušaj LOCKED
    const lockedR = await fetch(`${origin}/api/value-bets-locked?slot=${slot}`, {
      headers:{ "cache-control":"no-store" }
    });
    const lockedCT = (lockedR.headers.get("content-type")||"").toLowerCase();
    const lockedJ = lockedCT.includes("application/json") ? await lockedR.json() : {};
    let base =
      Array.isArray(lockedJ?.items) ? lockedJ.items :
      Array.isArray(lockedJ?.football) ? lockedJ.football : [];

    let source = "locked";

    // 2) fallback na seed (ako nema zaključanih)
    if (!base.length) {
      const seedR = await fetch(`${origin}/api/value-bets?slot=${slot}`, {
        headers:{ "cache-control":"no-store" }
      });
      const seedCT = (seedR.headers.get("content-type")||"").toLowerCase();
      const seedJ = seedCT.includes("application/json") ? await seedR.json() : {};
      base = Array.isArray(seedJ?.value_bets) ? seedJ.value_bets : [];
      source = "seed";
    }

    if (!base.length){
      return res.status(200).json({ ok:true, slot, tz: TZ, football: [], source });
    }

    const nowLocal = new Date(new Date().toLocaleString("en-US",{ timeZone: TZ }));
    const isWeekend = [0,6].includes(nowLocal.getDay());
    const SLOT_LIST_CAP = isWeekend ? WEEKEND_CAP : WEEKDAY_CAP;

    // Ako smo u seed fallback-u, primeni filtere (BAN/min kvota/cap/tier)
    let cleaned = [];
    const perLeagueCount = Object.create(null);

    for (const x of base){
      const leagueName = str(x?.league?.name) || str(x?.league_name);
      if (!leagueName) continue;

      const round = str(x?.league?.round) || str(x?.round);
      const stage = str(x?.league?.stage) || str(x?.stage);
      if (BAN_REGEX.test(`${leagueName} ${round} ${stage}`)) continue;

      const odds = bestOdds(x);
      if (!(Number.isFinite(odds) && odds >= MIN_ODDS)) continue;

      const homeName =
        str(x?.teams?.home?.name) || str(x?.home) || str(x?.home_name) || str(x?.homeTeam);
      const awayName =
        str(x?.teams?.away?.name) || str(x?.away) || str(x?.away_name) || str(x?.awayTeam);
      if (!homeName || !awayName) continue;

      const leagueKey = leagueKeyOf(x);
      const cap = isUEFA(leagueName) ? 6 : 2;
      perLeagueCount[leagueKey] = (perLeagueCount[leagueKey] || 0);
      if (perLeagueCount[leagueKey] >= cap) continue;

      const tier = tierOf(leagueName);
      const tierBoost = tier===1 ? 30 : tier===2 ? 10 : 0;
      const conf = num(x?.confidence_pct) ?? num(x?.confidence) ?? 0;
      const rankScore = conf + tierBoost;

      cleaned.push({
        ...x,
        teams: {
          home: { id: x?.teams?.home?.id ?? x?.home_id ?? null, name: homeName },
          away: { id: x?.teams?.away?.id ?? x?.away_id ?? null, name: awayName },
        },
        __rank: rankScore,
        __tier: tier,
        __leagueKey: leagueKey,
      });

      perLeagueCount[leagueKey] += 1;
    }

    // Ako je izvor bio LOCKED, pretpostavljamo da je filter već primenjen — ali ćemo ipak ograničiti dužinu liste za UI
    if (source === "locked") {
      cleaned = base.slice();
    }

    cleaned.sort((a,b) => num(b.__rank) - num(a.__rank));

    const limited = cleaned.slice(0, SLOT_LIST_CAP);

    return res.status(200).json({ ok:true, slot, tz: TZ, football: limited, source });
  } catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}

/* =============== utils =============== */
function getOrigin(req){
  const env = process.env.NEXT_PUBLIC_BASE_URL;
  if (env) return env.replace(/\/+$/,"");
  const host = req?.headers?.host;
  return host ? `https://${host}` : "";
}
function makeSet(arr){ const s=new Set(); arr.forEach(v=>s.add(v)); return s; }
function intFrom(x, def){ const n=Number(x); return Number.isFinite(n) ? n : def; }
function str(x){ return (typeof x === "string" ? x : x==null ? "" : String(x)); }
function num(x){ const n=Number(x); return Number.isFinite(n) ? n : null; }
function isUEFA(leagueName){ return /UEFA/i.test(leagueName); }
function tierOf(leagueName){ if (TIER1.has(leagueName)) return 1; if (TIER2.has(leagueName)) return 2; return 3; }
function leagueKeyOf(x){
  const name = str(x?.league?.name) || str(x?.league_name);
  const country = str(x?.league?.country) || str(x?.country);
  return `${country}:${name}`.toLowerCase();
}
function bestOdds(x){
  const cands = [
    x?.odds?.best, x?.best_odds, x?.market_odds_decimal, x?.market_odds, x?.odds,
    x?.odds?.home?.win, x?.odds?.match_winner?.best,
    x?.book?.best, x?.price, x?.odd, x?.odds_value
  ];
  for (const c of cands){
    const n = Number(c);
    if (Number.isFinite(n) && n > 1.0 && n < 100) return n;
  }
  return NaN;
}
