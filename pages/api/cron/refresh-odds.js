// pages/api/cron/refresh-odds.js
// STRICT BATCH (bez fallbacka).
// - Fixtures -> API_FOOTBALL_KEY
// - Odds batch -> API_FOOTBALL_KEY (isti host/provajder)
// - Trusted bookies uz kanonizaciju imena (lowercase + ukloni sve osim [a-z0-9])
// - Keš: odds:fixture:<YMD>:<fixtureId> = { match_winner:{home,draw,away}, best, fav }

export const config = { api: { bodyParser: false } };

const TZ   = process.env.TZ_DISPLAY || "Europe/Belgrade";
const BASE = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";

const FIX_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL;
// KLJUČNO: odds batch ide sa API_FOOTBALL_KEY (ne sa ODDS_API_KEY)
const ODDS_KEY = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL;

// storage
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// trusted lista (kanonizacija)
const canon = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
const TRUSTED_LIST = String(process.env.TRUSTED_BOOKIES || process.env.TRUSTED_BOOKMAKERS || "")
  .split(",").map(canon).filter(Boolean);

// 1X2 market detekcija
const ONE_X_TWO = /match\s*winner|^1x2$|^winner$/i;

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    if (!["am","pm","late"].includes(slot)) return res.status(200).json({ ok:false, error:"invalid slot" });
    if (!FIX_KEY)  return res.status(200).json({ ok:false, error:"API_FOOTBALL_KEY missing" });

    const ymd = ymdInTZ(new Date(), TZ);

    // fixtures (informativno)
    const fj = await jfetch(`${BASE}/fixtures?date=${ymd}&timezone=${encodeURIComponent(TZ)}`, FIX_KEY);
    const fixtures = Array.isArray(fj?.response) ? fj.response : [];

    // STRICT BATCH za kvote (sa API_FOOTBALL_KEY)
    const oj = await jfetch(`${BASE}/odds?date=${ymd}&timezone=${encodeURIComponent(TZ)}`, ODDS_KEY);
    const batch = Array.isArray(oj?.response) ? oj.response : [];

    let cached = 0;
    const seen = new Set();

    for (const row of batch) {
      const fid = row?.fixture?.id;
      if (!fid || seen.has(fid)) continue;
      const odds = pick1x2(row);
      if (odds) {
        await saveOdds(ymd, fid, odds);
        cached++;
      }
      seen.add(fid);
    }

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      fixtures: fixtures.length,
      batch_items: batch.length,
      odds_cached: cached,
      source: "batch:API_FOOTBALL_KEY"
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message || e) });
  }
}

/* ---------------- helpers ---------------- */

async function jfetch(url, key){
  const r = await fetch(url, { headers: { "x-apisports-key": key, "cache-control":"no-store" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) throw new Error(`Bad content-type for ${url}`);
  const j = await r.json();
  if (j && typeof j === "object" && j.errors && Object.keys(j.errors).length) {
    return { response: [] };
  }
  return j;
}

function pick1x2(row){
  const books = Array.isArray(row?.bookmakers) ? row.bookmakers : [];
  if (!books.length) return null;

  // strogo: uzimamo samo trusted
  return scanBooks(books, true);
}

function scanBooks(books, onlyTrusted){
  let home=null, draw=null, away=null, hits=0;

  for (const bk of books) {
    const nameCanon = canon(bk?.name);
    if (onlyTrusted && TRUSTED_LIST.length && !TRUSTED_LIST.includes(nameCanon)) continue;

    const bets = Array.isArray(bk?.bets) ? bk.bets : [];
    for (const bet of bets) {
      const nm = String(bet?.name || "");
      if (!ONE_X_TWO.test(nm)) continue;

      const vals = Array.isArray(bet?.values) ? bet.values : [];
      let got=false;

      for (const v of vals) {
        const lbl = String(v?.value || v?.label || "").toLowerCase();
        const odd = Number(v?.odd);
        if (!Number.isFinite(odd)) continue;

        if (/(^|\b)(home|1)(\b|$)/.test(lbl)) { home = Math.max(home ?? 0, odd); got=true; }
        else if (/(^|\b)(draw|x)(\b|$)/.test(lbl)) { draw = Math.max(draw ?? 0, odd); got=true; }
        else if (/(^|\b)(away|2)(\b|$)/.test(lbl)) { away = Math.max(away ?? 0, odd); got=true; }
      }
      if (got) hits++;
    }
  }

  const best = Math.max(home||0, draw||0, away||0) || null;
  const fav  = best == null ? null : (best === home ? "HOME" : best === draw ? "DRAW" : "AWAY");
  return best == null ? null : { match_winner:{home,draw,away}, best, fav, hits };
}

function ymdInTZ(d=new Date(), tz=TZ){
  const s = d.toLocaleString("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s).trim();
}

async function saveOdds(ymd, fid, odds){
  const key = `odds:fixture:${ymd}:${fid}`;
  if (KV_URL && KV_TOKEN) {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${KV_TOKEN}`, "content-type":"application/json" },
      body: JSON.stringify({ value: JSON.stringify(odds) })
    }).catch(()=>{});
  }
  if (UP_URL && UP_TOKEN) {
    await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${UP_TOKEN}`, "content-type":"application/json" },
      body: JSON.stringify({ value: JSON.stringify(odds) })
    }).catch(()=>{});
  }
}
