// pages/api/cron/rebuild.js
// Zaključava po slotu i poštuje limit 15 po slotu (ili SLOT_*_COUNT iz ENV).
// Upisuje: vbl:<YMD>:<slot> (Football tab) i vb:day:<YMD>:<slot> (Combined/History ulaz).

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.5);

// slot limiti
const LATE_LIMIT = Number(process.env.SLOT_LATE_COUNT || process.env.SLOT_LATE_WEEKDAY_LIMIT || 15);
const AM_LIMIT   = Number(process.env.SLOT_AM_COUNT   || 15);
const PM_LIMIT   = Number(process.env.SLOT_PM_COUNT   || 15);

// KV
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Tier mape
const TIER1 = toSet([
  "UEFA Champions League","UEFA Europa League","UEFA Europa Conference League",
  "UEFA Champions League Qualification","UEFA Europa League Qualification","UEFA Europa Conference League Qualification",
  "Premier League","LaLiga","Serie A","Bundesliga","Ligue 1","Eredivisie","Primeira Liga",
  "Pro League","Süper Lig","Super Lig","Premiership","Austrian Bundesliga","Swiss Super League",
  "SuperLiga","Serbian SuperLiga"
]);
const TIER2 = toSet([
  "Championship","LaLiga2","Serie B","2. Bundesliga","Ligue 2","Scottish Premiership","Scottish Championship",
  "Danish Superliga","Superligaen","Ekstraklasa","Eliteserien","Allsvenskan","Czech Liga","Romania Liga I","Croatia HNL",
  "Poland Ekstraklasa","Norway Eliteserien","Sweden Allsvenskan","MLS","Argentina Liga Profesional","Brazil Serie A"
]);

const BAN_REGEX = /\bU\s*-?\s*\d{1,2}\b|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

export default async function handler(req, res){
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    if (!["am","pm","late"].includes(slot)) return res.status(200).json({ ok:false, error:"invalid slot" });

    const origin = getOrigin(req);
    const r = await fetch(`${origin}/api/value-bets?slot=${encodeURIComponent(slot)}`, { headers: { "cache-control":"no-store" }});
    const j = await r.json().catch(()=>({}));
    const base = Array.isArray(j?.value_bets) ? j.value_bets : [];

    const ymd = ymdInTZ(new Date(), TZ);
    if (!base.length) {
      await setKV(`vbl:${ymd}:${slot}`, []);
      await setKV(`vb:day:${ymd}:${slot}`, []);
      return res.status(200).json({ ok:true, slot, count:0, football:[], source:"seed:empty" });
    }

    const perLeague = Object.create(null);
    const out = [];

    for (const x of base) {
      const leagueName = String(x?.league?.name || "");
      const round = String(x?.league?.round || "");
      const stage = String(x?.league?.stage || "");
      if (BAN_REGEX.test(`${leagueName} ${round} ${stage}`)) continue;

      const best = Number(x?.market_odds) || Number(x?.odds?.best) || null;
      if (!(Number.isFinite(best) && best >= MIN_ODDS)) continue;

      const leagueKey = leagueKeyOf(x);
      const cap = /UEFA/i.test(leagueName) ? 6 : 2; // liga cap u slotu
      perLeague[leagueKey] = perLeague[leagueKey] || 0;
      if (perLeague[leagueKey] >= cap) continue;

      const tier = TIER1.has(leagueName) ? 1 : TIER2.has(leagueName) ? 2 : 3;
      const boost = tier === 1 ? 30 : tier === 2 ? 10 : 0;
      const conf  = Number(x?.confidence_pct || 0);
      out.push({ ...x, __rank: conf + boost, __tier: tier, __leagueKey: leagueKey });
      perLeague[leagueKey] += 1;
    }

    out.sort((a,b) => Number(b.__rank) - Number(a.__rank));

    // limit po slotu (default 15)
    const LIMIT = slot === "late" ? LATE_LIMIT : slot === "am" ? AM_LIMIT : PM_LIMIT;
    const sliced = out.slice(0, LIMIT);

    await setKV(`vbl:${ymd}:${slot}`, sliced);   // Football tab
    await setKV(`vb:day:${ymd}:${slot}`, sliced);// Combined/History ulaz (TOP-LEVEL niz)

    return res.status(200).json({ ok:true, slot, count: sliced.length, football: sliced });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}

/* helpers */
function toSet(arr){ return new Set(arr); }
function ymdInTZ(d=new Date(), tz=TZ){
  const s = d.toLocaleString("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s).trim();
}
function leagueKeyOf(x){
  const c = String(x?.league?.country || "").toLowerCase() || "world";
  const n = String(x?.league?.name || "").toLowerCase();
  return `${c}:${n}`;
}
function getOrigin(req){
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}
async function setKV(key, arr){
  if (KV_URL && KV_TOKEN) {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${KV_TOKEN}`, "content-type":"application/json" },
      body: JSON.stringify({ value: JSON.stringify(arr) }),
    }).catch(()=>{});
  }
  const US = process.env.UPSTASH_REDIS_REST_URL;
  const UT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (US && UT) {
    await fetch(`${US}/set/${encodeURIComponent(key)}`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${UT}`, "content-type":"application/json" },
      body: JSON.stringify({ value: JSON.stringify(arr) }),
    }).catch(()=>{});
  }
}
