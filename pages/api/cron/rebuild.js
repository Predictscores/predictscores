// FILE: pages/api/cron/rebuild.js
// Zaključava slotove iz /api/value-bets?slot=… (seed) i snima u LOCKED + vb:day:<YMD>:<slot>
// Pravila: BAN, min kvota (obavezna) ≥ MIN_ODDS (default 1.5), cap po ligi (UEFA=6, ostalo=2), Tier boost.

import { _internalSetLocked as setLocked } from "../value-bets-locked";

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.5);
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// BAN regex — isti kao u seed-u
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

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    if (!["am","pm","late"].includes(slot)) {
      return res.status(200).json({ ok:false, error:"invalid slot" });
    }

    // 1) Uzmi seed iz /api/value-bets
    const origin = getOrigin(req);
    const seedR = await fetch(`${origin}/api/value-bets?slot=${encodeURIComponent(slot)}`, {
      headers: { "cache-control":"no-store" }
    });
    const seedCT = (seedR.headers.get("content-type") || "").toLowerCase();
    const seedJ = seedCT.includes("application/json") ? await seedR.json() : {};
    const base = Array.isArray(seedJ?.value_bets) ? seedJ.value_bets : [];

    const ymd = ymdInTZ();

    if (!base.length) {
      // ipak očisti i zaključaj prazan (predvidivo ponašanje)
      await setLocked?.(`vbl:${ymd}:${slot}`, []);
      // i napiši prazan vb:day da apply-learning ne ruši last naslepo
      await kvSet(`vb:day:${ymd}:${slot}`, []);
      return res.status(200).json({ ok:true, slot, count:0, football:[], source:"seed:empty" });
    }

    // 2) Filtriranje + bodovanje + per-league cap
    const perLeagueCount = Object.create(null);
    const out = [];

    for (const x of base) {
      const leagueName = str(x?.league?.name) || str(x?.league_name);
      if (!leagueName) continue;

      const round = str(x?.league?.round) || str(x?.round);
      const stage = str(x?.league?.stage) || str(x?.stage);
      if (BAN_REGEX.test(`${leagueName} ${round} ${stage}`)) continue;

      // obavezna kvota: mora postojati i biti ≥ MIN_ODDS
      const odds = bestOdds(x);
      if (!(Number.isFinite(odds) && odds >= MIN_ODDS)) continue;

      const leagueKey = leagueKeyOf(x);
      const cap = isUEFA(leagueName) ? 6 : 2;
      perLeagueCount[leagueKey] = (perLeagueCount[leagueKey] || 0);
      if (perLeagueCount[leagueKey] >= cap) continue;

      const tier = tierOf(leagueName);
      const tierBoost = tier === 1 ? 30 : tier === 2 ? 10 : 0;

      const conf = num(x?.confidence_pct) ?? num(x?.confidence) ?? 0;
      const rankScore = conf + tierBoost;

      out.push({ ...x, __rank: rankScore, __tier: tier, __leagueKey: leagueKey });
      perLeagueCount[leagueKey] += 1;
    }

    out.sort((a,b) => num(b.__rank) - num(a.__rank));

    // 3) Upisi u LOCKED + vb:day:<ymd>:<slot> (da learning ima ulaz)
    await setLocked?.(`vbl:${ymd}:${slot}`, out);
    await kvSet(`vb:day:${ymd}:${slot}`, out);

    return res.status(200).json({ ok:true, slot, count: out.length, football: out, source:"rebuild" });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}

/* ================= utils ================= */
function getOrigin(req){
  const env = process.env.NEXT_PUBLIC_BASE_URL;
  if (env) return env.replace(/\/+$/,"");
  const host = req?.headers?.host;
  return host ? `https://${host}` : "";
}
function ymdInTZ(d=new Date(), tz=TZ){
  const s = d.toLocaleString("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s);
}
function str(x){ return (typeof x === "string" ? x : x==null ? "" : String(x)); }
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
function makeSet(arr){ const s=new Set(); arr.forEach(v=>s.add(v)); return s; }
function tierOf(leagueName){ if (TIER1.has(leagueName)) return 1; if (TIER2.has(leagueName)) return 2; return 3; }
function isUEFA(leagueName){ return /UEFA/i.test(leagueName); }
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

/* ----- Upstash KV (za vb:day feed) ----- */
async function kvSet(key, val) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type":"application/json" },
      body: JSON.stringify({ value: val }),
    });
  } catch {}
}
