// pages/api/cron/refresh-odds.js
// Batch osvežavanje kvota (bez per-fixture spama).
// - Fixtures -> API_FOOTBALL_KEY (v3/fixtures)
// - Odds batch -> ODDS_API_KEY (v3/odds)
// - Trusted bookies filtriranje kroz TRUSTED_BOOKIES / TRUSTED_BOOKMAKERS
//   (+ ODDS_TRUSTED_ONLY / ODDS_TRUSTED_FALLBACK_MIN)
// - Keš: odds:fixture:<YMD>:<fixtureId> = { match_winner:{home,draw,away}, best, fav }
// - Budžet: odds:budget:<YMD> (samo broj eksternih poziva)

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_BASE = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";

// fixtures
const FIX_KEY = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL;

// odds (poseban ključ po tvojoj postavci)
const ODDS_KEY = process.env.ODDS_API_KEY || process.env.API_FOOTBALL_KEY;

// storage (primarno KV_REST_*, fallback UPSTASH_REDIS_*)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// behavior flags
const DAILY_BUDGET = Number(process.env.ODDS_CALL_BUDGET_DAILY || 5000);
const PER_FIXTURE_FALLBACK = String(process.env.ODDS_FALLBACK_PER_FIXTURE || "0") === "1";
const PER_FIXTURE_CAP = Number(process.env.ODDS_PER_FIXTURE_CAP || 100);

// trusted (kanonizacija)
const norm = (s) => String(s || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "") // "William Hill" / "william_hill" / "William-Hill" -> "williamhill"
  .trim();

const TRUSTED_LIST = String(process.env.TRUSTED_BOOKIES || process.env.TRUSTED_BOOKMAKERS || "")
  .split(",")
  .map(norm)
  .filter(Boolean);

const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "1") === "1";
const TRUSTED_FALLBACK_MIN = Number(process.env.ODDS_TRUSTED_FALLBACK_MIN || 0); // ako 0 → dozvoli fallback odmah

export default async function handler(req, res) {
  try {
    if (!FIX_KEY)  return res.status(200).json({ ok:false, error:"API_FOOTBALL_KEY missing" });
    if (!ODDS_KEY) return res.status(200).json({ ok:false, error:"ODDS_API_KEY missing" });

    const now = new Date();
    const ymd = ymdInTZ(now, TZ);

    // 1) fixtures za danas
    const fj = await fetchJSON(`${AF_BASE}/fixtures?date=${ymd}&timezone=${encodeURIComponent(TZ)}`, FIX_KEY);
    const fixtures = Array.isArray(fj?.response) ? fj.response : [];

    // 2) batch odds za danas (1 poziv)
    const oj = await fetchJSON(`${AF_BASE}/odds?date=${ymd}&timezone=${encodeURIComponent(TZ)}`, ODDS_KEY);
    await bumpBudget(ymd, 1);
    const batch = Array.isArray(oj?.response) ? oj.response : [];

    // 3) normalizuj po trusted pravilima i upiši per-fixture
    let covered = 0;
    const seen = new Set();

    for (const row of batch) {
      const fid = row?.fixture?.id;
      if (!fid || seen.has(fid)) continue;

      const odds = pickTrusted1X2(row, TRUSTED_LIST, TRUSTED_ONLY, TRUSTED_FALLBACK_MIN);
      if (odds) {
        await saveOdds(ymd, fid, odds);
        covered++;
      }
      seen.add(fid);
    }

    // 4) per-fixture fallback (opcionalno i limitirano)
    let fetched = 0;
    if (PER_FIXTURE_FALLBACK && (await getRemainingBudget(ymd)) > 0) {
      const allFids = fixtures.map(x => x?.fixture?.id).filter(Boolean);
      const missing = allFids.filter(fid => !seen.has(fid));
      const cap = Math.min(PER_FIXTURE_CAP, await getRemainingBudget(ymd), missing.length);

      for (let i = 0; i < cap; i++) {
        const fid = missing[i];
        try {
          const one = await fetchJSON(`${AF_BASE}/odds?fixture=${fid}&timezone=${encodeURIComponent(TZ)}`, ODDS_KEY);
          await bumpBudget(ymd, 1);
          const rows = Array.isArray(one?.response) ? one.response : [];
          if (rows.length) {
            const odds = pickTrusted1X2(rows[0], TRUSTED_LIST, TRUSTED_ONLY, TRUSTED_FALLBACK_MIN);
            if (odds) {
              await saveOdds(ymd, fid, odds);
              fetched++;
            }
          }
        } catch { /* ignore */ }
      }
    }

    return res.status(200).json({
      ok: true,
      ymd,
      fixtures: fixtures.length,
      odds_cached: covered,
      odds_fetched: fetched,
      budget_used: await getBudgetUsed(ymd),
      budget_limit: DAILY_BUDGET
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}

/* ---------------- helpers ---------------- */

async function fetchJSON(url, key) {
  const r = await fetch(url, { headers: { "x-apisports-key": key, "cache-control":"no-store" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) throw new Error(`Bad content-type for ${url}`);
  return r.json();
}

function pickTrusted1X2(row, trustedList, trustedOnly, trustedFallbackMin) {
  const books = Array.isArray(row?.bookmakers) ? row.bookmakers : [];
  if (!books.length) return null;

  function scanBooks(filterTrusted) {
    let home=null, draw=null, away=null, hits=0;
    for (const bk of books) {
      const name = norm(bk?.name);
      if (filterTrusted && trustedList.length && !trustedList.includes(name)) continue;

      const bets = Array.isArray(bk?.bets) ? bk.bets : [];
      for (const bet of bets) {
        const nm = String(bet?.name || "").toLowerCase();
        if (!/match\s*winner|^1x2$|^winner$/.test(nm)) continue;

        const vals = Array.isArray(bet?.values) ? bet.values : [];
        let gotAny=false;
        for (const v of vals) {
          const lbl = String(v?.value || v?.label || "").toLowerCase();
          const odd = Number(v?.odd);
          if (!Number.isFinite(odd)) continue;
          if (/(^|\b)(home|1)(\b|$)/.test(lbl)) { home = Math.max(home ?? 0, odd); gotAny=true; }
          else if (/(^|\b)(draw|x)(\b|$)/.test(lbl)) { draw = Math.max(draw ?? 0, odd); gotAny=true; }
          else if (/(^|\b)(away|2)(\b|$)/.test(lbl)) { away = Math.max(away ?? 0, odd); gotAny=true; }
        }
        if (gotAny) hits++;
      }
    }
    const best = Math.max(home||0, draw||0, away||0) || null;
    const fav  = best == null ? null : (best === home ? "HOME" : best === draw ? "DRAW" : "AWAY");
    return { match_winner:{home,draw,away}, best, fav, hits };
  }

  // prvo trusted
  const t = scanBooks(true);
  if (t.best != null) return { match_winner: t.match_winner, best: t.best, fav: t.fav };

  // ako nije striktno trustedOnly → fallback na sve bookije u skladu sa pragom
  if (!trustedOnly) {
    const a = scanBooks(false);
    if (a.best != null && (trustedFallbackMin <= 0 || t.hits >= trustedFallbackMin)) {
      return { match_winner: a.match_winner, best: a.best, fav: a.fav };
    }
  }
  return null;
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s).trim();
}

/* ---- storage & budget ---- */

async function saveOdds(ymd, fid, odds) {
  const key = `odds:fixture:${ymd}:${fid}`;
  // KV primarno
  if (KV_URL && KV_TOKEN) {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(odds) }),
    }).catch(()=>{});
  }
  // Upstash fallback
  if (UP_URL && UP_TOKEN) {
    await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(odds) }),
    }).catch(()=>{});
  }
}

async function getBudgetUsed(ymd){
  const key = `odds:budget:${ymd}`;
  if (!KV_URL || !KV_TOKEN) return 0;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json().catch(()=>null);
  const n = Number(j?.result ?? 0);
  return Number.isFinite(n) ? n : 0;
}
async function getRemainingBudget(ymd){
  const used = await getBudgetUsed(ymd);
  return Math.max(DAILY_BUDGET - used, 0);
}
async function bumpBudget(ymd, n){
  if (!KV_URL || !KV_TOKEN || !n) return;
  const key = `odds:budget:${ymd}`;
  await fetch(`${KV_URL}/incrby/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type":"application/json" },
    body: JSON.stringify({ value: n }),
  }).catch(()=>{});
}
