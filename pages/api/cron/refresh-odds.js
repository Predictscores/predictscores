// pages/api/cron/refresh-odds.js
// Batch + auto fallback (bez ENV prekidača):
// 1) pokuša /odds?date=… sa ODDS_API_KEY (batch)
// 2) ako batch vrati 0 (ili vrlo malo), automatski pređe na /odds?fixture=… SAMO za traženi slot
// 3) kvote filtrira po TRUSTED_BOOKIES (kanonizovano ime bukija), ali ako nema trusted – proba i sve bookije
// 4) sve upisuje u KV/Upstash kao: odds:fixture:<YMD>:<fixtureId>

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_BASE = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";

// ključevi
const FIX_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL; // fixtures
const ODDS_KEY = process.env.ODDS_API_KEY     || process.env.API_FOOTBALL_KEY; // odds

// storage
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// budžet / cap
const DAILY_BUDGET = Number(process.env.ODDS_CALL_BUDGET_DAILY || 5000);
const AUTO_FALLBACK_CAP = Number(process.env.ODDS_PER_FIXTURE_CAP || 200); // automatski cap per fixture

// trusted lista (kanonizacija)
const canon = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
const TRUSTED_LIST = String(process.env.TRUSTED_BOOKIES || process.env.TRUSTED_BOOKMAKERS || "")
  .split(",").map(canon).filter(Boolean);

// market nazivi koji znače 1X2
const ONE_X_TWO = /match\s*winner|^1x2$|^winner$/i;

export default async function handler(req, res) {
  try {
    if (!FIX_KEY)  return res.status(200).json({ ok:false, error:"API_FOOTBALL_KEY missing" });
    if (!ODDS_KEY) return res.status(200).json({ ok:false, error:"ODDS_API_KEY missing" });

    const slot = String(req.query?.slot || "am").toLowerCase();
    const ymd  = ymdInTZ(new Date(), TZ);

    // 1) fixtures za danas
    const fj = await fetchJSON(`${AF_BASE}/fixtures?date=${ymd}&timezone=${encodeURIComponent(TZ)}`, FIX_KEY);
    const fixtures = Array.isArray(fj?.response) ? fj.response : [];

    // izdvoji fixtureId-ove za traženi slot (da fallback ne pogađa ceo dan)
    const slotFixtureIds = fixtures
      .filter(fx => inSlotWindow(fx?.fixture?.date, TZ, slot))
      .map(fx => fx?.fixture?.id)
      .filter(Boolean);

    // 2) PROBAJ BATCH (1 poziv)
    let covered = 0;
    let fetched = 0;
    let mode = "batch";
    const seen = new Set();

    try {
      const oj = await fetchJSON(`${AF_BASE}/odds?date=${ymd}&timezone=${encodeURIComponent(TZ)}`, ODDS_KEY);
      await bumpBudget(ymd, 1);
      const batch = Array.isArray(oj?.response) ? oj.response : [];

      for (const row of batch) {
        const fid = row?.fixture?.id;
        if (!fid || seen.has(fid)) continue;
        const odds = pick1X2(row);
        if (odds) { await saveOdds(ymd, fid, odds); covered++; }
        seen.add(fid);
      }
    } catch {
      // ako batch padne na nivou mreže – ignoriši, ide fallback
    }

    // 3) Ako batch NIJE dao kvote → AUTO FALLBACK za slot (cap)
    if (covered < 5 && slotFixtureIds.length) {
      mode = "fallback";
      const cap = Math.min(AUTO_FALLBACK_CAP, await getRemainingBudget(ymd), slotFixtureIds.length);
      for (let i = 0; i < cap; i++) {
        const fid = slotFixtureIds[i];
        if (!fid || seen.has(fid)) continue;
        try {
          const one = await fetchJSON(`${AF_BASE}/odds?fixture=${fid}&timezone=${encodeURIComponent(TZ)}`, ODDS_KEY);
          await bumpBudget(ymd, 1);
          const rows = Array.isArray(one?.response) ? one.response : [];
          if (rows.length) {
            const odds = pick1X2(rows[0]);
            if (odds) { await saveOdds(ymd, fid, odds); fetched++; }
          }
          seen.add(fid);
        } catch { /* ignore pojedinačne greške */ }
      }
    }

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      fixtures: fixtures.length,
      slot_fixtures: slotFixtureIds.length,
      odds_cached: covered,
      odds_fetched: fetched,
      mode,
      budget_used: await getBudgetUsed(ymd),
      budget_limit: DAILY_BUDGET
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}

/* ---------------- helpers ---------------- */

async function fetchJSON(url, key) {
  const r = await fetch(url, { headers: { "x-apisports-key": key, "cache-control":"no-store" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) throw new Error(`Bad content-type for ${url}`);
  return r.json();
}

function pick1X2(row) {
  const books = Array.isArray(row?.bookmakers) ? row.bookmakers : [];
  if (!books.length) return null;

  // 1) probaj TRUSTED
  let out = scanBooks(books, true);
  if (out.best != null) return out;

  // 2) ako trusted nema ništa, probaj sve bookije
  out = scanBooks(books, false);
  return out.best != null ? out : null;
}

function scanBooks(books, onlyTrusted) {
  let home = null, draw = null, away = null, hits = 0;

  for (const bk of books) {
    const nameCanon = canon(bk?.name);
    if (onlyTrusted && TRUSTED_LIST.length && !TRUSTED_LIST.includes(nameCanon)) continue;

    const bets = Array.isArray(bk?.bets) ? bk.bets : [];
    for (const bet of bets) {
      const nm = String(bet?.name || "");
      if (!ONE_X_TWO.test(nm)) continue;

      const vals = Array.isArray(bet?.values) ? bet.values : [];
      let gotAny = false;

      for (const v of vals) {
        const lbl = String(v?.value || v?.label || "").toLowerCase();
        const odd = Number(v?.odd);
        if (!Number.isFinite(odd)) continue;

        if (/(^|\b)(home|1)(\b|$)/.test(lbl)) { home = Math.max(home ?? 0, odd); gotAny = true; }
        else if (/(^|\b)(draw|x)(\b|$)/.test(lbl)) { draw = Math.max(draw ?? 0, odd); gotAny = true; }
        else if (/(^|\b)(away|2)(\b|$)/.test(lbl)) { away = Math.max(away ?? 0, odd); gotAny = true; }
      }
      if (gotAny) hits++;
    }
  }

  const best = Math.max(home||0, draw||0, away||0) || null;
  const fav  = best == null ? null : (best === home ? "HOME" : best === draw ? "DRAW" : "AWAY");
  return { match_winner:{home,draw,away}, best, fav, hits };
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s).trim();
}

function inSlotWindow(iso, tz, slot){
  if (!iso) return false;
  const d = new Date(iso);
  const day = ymdInTZ(new Date(), tz);
  const ymd = ymdInTZ(new Date(d), tz);
  if (ymd !== day) return false;

  const h = Number(d.toLocaleString("en-GB",{ timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false }).split(":")[0]);
  if (slot === "late") return h >= 0 && h < 10;
  if (slot === "am")   return h >= 10 && h < 15;
  if (slot === "pm")   return h >= 15 && h < 24;
  return true;
}

/* ---- storage & budget ---- */

async function saveOdds(ymd, fid, odds) {
  const key = `odds:fixture:${ymd}:${fid}`;
  // KV
  if (KV_URL && KV_TOKEN) {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type":"application/json" },
      body: JSON.stringify({ value: JSON.stringify(odds) }),
    }).catch(()=>{});
  }
  // Upstash fallback
  if (UP_URL && UP_TOKEN) {
    await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UP_TOKEN}`, "content-type":"application/json" },
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
