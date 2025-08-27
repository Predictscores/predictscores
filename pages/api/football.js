// FILE: pages/api/football.js
// Vraća listu predloga po slotu (late/am/pm), pokušava: locked -> value-bets -> (opciono) rebuild.
// Primena BAN (name+round+stage), min kvota 1.50, cap (UEFA=6, ostale=2), tier-prioritet.
// Služi i za Combined tab (Top 3 se bira na UI strani).

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.5);
const WEEKDAY_CAP = intFrom(process.env.SLOT_WEEKDAY_CAP, 15);
const WEEKEND_CAP = intFrom(process.env.SLOT_WEEKEND_CAP, 25);

// isti BAN regex kao u rebuild-u
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

    // fallback lanac
    const urls = [
      `${origin}/api/value-bets-locked?slot=${slot}`,
      `${origin}/api/value-bets?slot=${slot}`,
      ...(noRebuild ? [] : [`${origin}/api/cron/rebuild?slot=${slot}`]),
    ];

    let base = [], source = "miss";
    for (let i=0;i<urls.length;i++){
      const r = await fetch(urls[i], { headers:{ "cache-control":"no-store" }});
      const ct = (r.headers.get("content-type")||"").toLowerCase();
      const j = ct.includes("application/json") ? await r.json() : {};
      const arr =
        Array.isArray(j?.items) ? j.items
      : Array.isArray(j?.football) ? j.football
      : Array.isArray(j?.value_bets) ? j.value_bets
      : [];
      if (arr.length){
        base = arr; source = i===0?"locked":i===1?"value-bets":"rebuild";
        break;
      }
    }

    if (!base.length){
      return res.status(200).json({ ok:true, slot, tz: TZ, football: [], source });
    }

    // weekday/weekend cap
    const nowLocal = new Date(new Date().toLocaleString("en-US",{ timeZone: TZ }));
    const isWeekend = [0,6].includes(nowLocal.getDay());
    const SLOT_LIST_CAP = isWeekend ? WEEKEND_CAP : WEEKDAY_CAP;

    // Filtriranje + bodovanje + per-league cap
    const perLeagueCount = Object.create(null);
    const cleaned = [];

    for (const x of base){
      const leagueName = str(x?.league?.name) || str(x?.league_name);
      if (!leagueName) continue;

      const round = str(x?.league?.round) || str(x?.round);
      const stage = str(x?.league?.stage) || str(x?.stage);
      const banHaystack = `${leagueName} ${round} ${stage}`;
      if (BAN_REGEX.test(banHaystack)) continue;

      // odds
      const odds = bestOdds(x);
      if (odds !== null && odds < MIN_ODDS) continue;

      // teams (robustan fallback)
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

    cleaned.sort((a,b) => num(b.__rank) - num(a.__rank));

    // ograniči ukupnu listu po slotu (da ne bude predugačko)
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
// tolerantno izvlačenje kvote/best oddsa
function bestOdds(x){
  const cands = [
    x?.odds?.best, x?.best_odds, x?.market?.best, x?.oddsBest,
    x?.odds?.home?.win, x?.odds?.match_winner?.best,
    x?.book?.best, x?.price, x?.odd, x?.odds_value,
    x?.closing_odds_decimal, x?.market_odds_decimal, x?.market_odds, x?.odds
  ];
  for (const c of cands){
    const n = Number(c);
    if (Number.isFinite(n) && n > 1.0 && n < 100) return n;
  }
  return null;
}
