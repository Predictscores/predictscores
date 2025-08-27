// pages/api/cron/rebuild.js
// Kreira zaključane slotove (AM/PM/LATE) sa filtrima i ban listom i upisuje u vbl:${YMD}:${slot}

import { _internalSetLocked as setLocked } from "../value-bets-locked";

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const TRUSTED = (process.env.TRUSTED_BOOKIES || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TRUSTED_SET = new Set(TRUSTED);

// BAN: Under/Uxx, Women/Girls, Reserves, Youth/Academy/Development
// (NE ban “B Team”/“II” jer su seniorski u nekim ligama)
const BAN_REGEX = /\bU\s*-?\s*\d{1,2}\b|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

// Tier mape (Serbia: samo SuperLiga je T1; Prva Liga je T3)
const TIER1 = makeSet([
  "UEFA Champions League","UEFA Europa League","UEFA Europa Conference League",
  "UEFA Champions League Qualification","UEFA Europa League Qualification",
  "UEFA Europa Conference League Qualification",
  "Premier League","LaLiga","Serie A","Bundesliga","Ligue 1",
  "Eredivisie","Primeira Liga","Pro League","Süper Lig","Super Lig","Premiership",
  "Austrian Bundesliga","Swiss Super League","Russian Premier League",
  "SuperLiga","Serbian SuperLiga"
]);
const TIER2 = makeSet([
  "Super League","Superleague",
  "Danish Superliga","Superligaen","Fortuna Liga","HNL","Ekstraklasa",
  "Eliteserien","Allsvenskan","Ukrainian Premier League","Liga I","NB I",
  "Championship","LaLiga2","Serie B","2. Bundesliga","Ligue 2",
  "Scottish Championship","Czech Liga","Romania Liga I","Poland Ekstraklasa",
  "Croatia HNL","Norway Eliteserien","Sweden Allsvenskan",
  "MLS","Argentina Liga Profesional","Brazil Serie A"
]);
const SERBIA_PRVA_KEYS = makeSet(["Prva Liga","Serbian Prva Liga","Prva liga Srbije"]);

function makeSet(arr){ return new Set(arr.map(s => (s||"").toString().trim())); }
function str(x){ return x==null ? "" : String(x); }
function num(x){ const n = Number(x); return Number.isFinite(n)?n:0; }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function ymdInTZ(d=new Date(), tz=TZ){
  const s = d.toLocaleString("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return s.split(",")[0] || s;
}
function isWeekendInTZ(tz=TZ){
  const d = new Date(new Date().toLocaleString("en-US",{timeZone:tz}));
  const wd = d.getDay(); // 0=Sun .. 6=Sat
  return wd===0 || wd===6;
}
// tolerantno traži „best odds“ iz više polja
function bestOdds(x){
  const cands = [
    x?.closing_odds_decimal, x?.market_odds_decimal, x?.market_odds, x?.odds,
    x?.odds?.best, x?.best_odds, x?.market?.best, x?.oddsBest,
    x?.odds?.home?.win, x?.odds?.match_winner?.best, x?.book?.best, x?.price, x?.odd, x?.odds_value
  ];
  for (const c of cands){
    const n = Number(c);
    if (Number.isFinite(n) && n>1.0 && n<100) return n;
  }
  return null;
}

export default async function handler(req, res){
  try{
    const slot = String(req.query?.slot || "am").toLowerCase(); // am|pm|late
    if (!["am","pm","late"].includes(slot)) {
      return res.status(200).json({ ok:false, error:"invalid slot", slot });
    }

    const origin = process.env.NEXT_PUBLIC_BASE_URL || (req.headers?.host ? `https://${req.headers.host}` : "");
    if (!origin) return res.status(200).json({ ok:false, error:"no origin" });

    // ❗️Ne čitamo više value-bets direktno (da ne vuče externals).
    // Uzimamo već spremnu bazu iz FOOTBALL, ali sa norebuild=1 da ne napravimo rekurziju.
    const r = await fetch(`${origin}/api/football?slot=${encodeURIComponent(slot)}&norebuild=1`, { headers: { "cache-control":"no-store" }});
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const baseJ = ct.includes("application/json") ? await r.json() : {};
    const raw = Array.isArray(baseJ?.football) ? baseJ.football : [];

    // Ako nema ničega, upiši prazan slot i izađi (da UI dobije prazan ali validan lock)
    if (!raw.length){
      await setLocked?.(`vbl:${ymdInTZ()}:${slot}`, []);
      return res.status(200).json({ ok:true, slot, count:0, football: [] });
    }

    // Filtriranje i normalizacija
    const cleaned = [];
    for (const m of raw){
      const leagueName = str(m?.league?.name || m?.league_name).trim();
      if (!leagueName) continue;
      if (BAN_REGEX.test(leagueName)) continue; // Women/Uxx/Reserves/Youth...

      const country = str(m?.league?.country || m?.country).trim();

      // Trusted bookies: ako books_used PRAZAN -> pusti; ako nije prazan -> traži bar jednog trusted
      const books = (m?.books_used || []).map((b) => String(b).toLowerCase());
      if (TRUSTED_SET.size && books.length && !books.some((b) => TRUSTED_SET.has(b))) continue;

      const odds = bestOdds(m);
      if (odds !== null && odds < 1.5) continue; // min kvota 1.50

      const home = str(m?.teams?.home?.name) || str(m?.home) || str(m?.home_name);
      const away = str(m?.teams?.away?.name) || str(m?.away) || str(m?.away_name);
      if (!home || !away) continue;

      // Tier
      let tier = 3;
      if (TIER1.has(leagueName)) tier = 1;
      else if (TIER2.has(leagueName)) tier = 2;
      else if (SERBIA_PRVA_KEYS.has(leagueName)) tier = 3;

      const isUEFA = /Champions League|Europa League|Conference League/i.test(leagueName);

      // Score
      const baseScore = num(m?.score || m?._score || m?.model_prob || m?.model || 0);
      const learnBoost = num(m?.learnScore || m?.learn_boost || 0);
      const tierBoost = tier === 1 ? 0.10 : (tier === 2 ? 0.05 : 0);
      const oddsBoost = odds !== null ? clamp((odds - 1.6) * 0.03, -0.05, 0.08) : 0;
      const score = baseScore + tierBoost + oddsBoost + learnBoost;

      cleaned.push({
        ...m,
        league: m.league || { name: leagueName, country },
        league_name: leagueName,
        country,
        teams: m.teams || { home: { name: home }, away: { name: away } },
        home_name: home,
        away_name: away,
        __leagueKey: `${country}:${leagueName}`,
        __odds: odds,
        __score: score,
        isUEFA,
        tier
      });
    }

    // Per-league cap: UEFA=6, ostalo=2  (po ključu country:league)
    const plc = Object.create(null);
    const perLeagueCapped = [];
    for (const x of cleaned.sort((a,b)=>b.__score - a.__score)){
      const lid = String(x.__leagueKey || x.league_name || "");
      const cap = x.isUEFA ? 6 : 2;
      const cnt = plc[lid] || 0;
      if (cnt >= cap) continue;
      plc[lid] = cnt + 1;
      perLeagueCapped.push(x);
    }

    // Slot cap: 15 radnim danom, 25 vikendom
    const slotCap = isWeekendInTZ() ? 25 : 15;
    const finalList = perLeagueCapped.slice(0, slotCap);

    // Upis u locked storage po slotu
    const ymd = ymdInTZ();
    await setLocked?.(`vbl:${ymd}:${slot}`, finalList);

    return res.status(200).json({
      ok: true,
      slot,
      count: finalList.length,
      football: finalList
    });
  } catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
