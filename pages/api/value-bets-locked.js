// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ helpers ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
function pickSlotAuto(now) {
  const h = hourInTZ(now, TZ);
  return (h<10) ? "late" : (h<15) ? "am" : "pm";
}
function isWeekendYmd(ymd, tz){
  const [y,m,dd]=ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, dd, 12, 0, 0));
  const w = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, weekday:"short"}).format(dt).toLowerCase();
  return w==="sat"||w==="sun";
}

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGET(key, trace=[]) {
  for (const b of kvBackends()) {
    try {
      const u = `${b.url}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${b.tok}` }, cache:"no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const v = (j && ("result" in j ? j.result : j.value)) ?? null;
      if (v==null) continue;
      trace.push({ get:key, ok:true, flavor:b.flavor, hit:true });
      return v;
    } catch {}
  }
  trace.push({ get:key, ok:true, hit:false });
  return null;
}

/* ---------- Safe deserialization ---------- */
function kvToItems(doc) {
  if (doc == null) return { items: [] };
  let v = doc;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return { items: [] }; }
  }
  if (v && typeof v === "object" && typeof v.value === "string") {
    try { v = JSON.parse(v.value); } catch { return { items: [] }; }
  }
  if (Array.isArray(v)) return { items: v };
  if (v && Array.isArray(v.items)) return v;
  return { items: [] };
}

/* ---------- ENV params ---------- */
const VB_LIMIT = Number(process.env.VB_LIMIT || 25);
const VB_MAX_PER_LEAGUE = Number(process.env.VB_MAX_PER_LEAGUE || 2);
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.50);
const MAX_ODDS = Number(process.env.MAX_ODDS || 5.50);
const UEFA_DAILY_CAP = Number(process.env.UEFA_DAILY_CAP || 6);

const CAP_LATE = Number(process.env.CAP_LATE || 6);
const CAP_AM_WD = Number(process.env.CAP_AM_WD || 15);
const CAP_PM_WD = Number(process.env.CAP_PM_WD || 15);
const CAP_AM_WE = Number(process.env.CAP_AM_WE || 20);
const CAP_PM_WE = Number(process.env.CAP_PM_WE || 20);

/* ---------- Helpers ---------- */
function isUEFA(league) {
  const name = String(league?.name||"").toLowerCase();
  return /uefa|champions league|europa league|conference league|ucl|uel|uecl/.test(name);
}
function confFromOdds(oddsPrice) {
  if (!Number.isFinite(oddsPrice) || oddsPrice <= 1.0) return 0;
  const p = 1 / oddsPrice;
  return Math.round(Math.max(0, Math.min(100, p*100)));
}

/* ---------- Builders ---------- */
function toCandidates(fix){
  const out = [];
  const { markets = {} } = fix || {};
  const fixtureId = fix.fixture_id || fix.fixture?.id;

  if (markets.btts?.yes && markets.btts.yes >= MIN_ODDS && markets.btts.yes <= MAX_ODDS) {
    const price = Number(markets.btts.yes);
    out.push({ fixture_id: fixtureId, market: "BTTS", pick: "Yes", pick_code: "BTTS:Y", selection_label: "BTTS Yes", odds: { price }, confidence_pct: confFromOdds(price) });
  }
  if (markets.ou25?.over && markets.ou25.over >= MIN_ODDS && markets.ou25.over <= MAX_ODDS) {
    const price = Number(markets.ou25.over);
    out.push({ fixture_id: fixtureId, market: "OU2.5", pick: "Over 2.5", pick_code: "O2.5", selection_label: "Over 2.5", odds: { price }, confidence_pct: confFromOdds(price) });
  }
  if (markets.fh_ou15?.over && markets.fh_ou15.over >= MIN_ODDS && markets.fh_ou15.over <= Math.max(MAX_ODDS, 10)) {
    const price = Number(markets.fh_ou15.over);
    out.push({ fixture_id: fixtureId, market: "FH_OU1.5", pick: "Over 1.5 FH", pick_code: "FH O1.5", selection_label: "FH Over 1.5", odds: { price }, confidence_pct: confFromOdds(price) });
  }
  const htft = markets.htft || {};
  const HTFT_ORDER = ["hh","dd","aa","hd","dh","ha","ah","da","ad"];
  for (const code of HTFT_ORDER) {
    const price = Number(htft[code]);
    if (Number.isFinite(price) && price >= MIN_ODDS && price <= Math.max(MAX_ODDS, 10)) {
      out.push({ fixture_id: fixtureId, market: "HTFT", pick: code.toUpperCase(), pick_code: `HTFT:${code.toUpperCase()}`, selection_label: `HT/FT ${code.toUpperCase()}`, odds: { price }, confidence_pct: confFromOdds(price) });
      if (out.length >= 6) break;
    }
  }
  for (const c of out) {
    c.league = fix.league; c.league_name = fix.league?.name; c.league_country = fix.league?.country;
    c.teams = fix.teams; c.home = fix.home; c.away = fix.away;
    c.kickoff = fix.kickoff; c.kickoff_utc = fix.kickoff_utc || fix.kickoff;
    c.model_prob = null;
  }
  return out;
}

function oneXtwoOffers(fix){
  const xs = [];
  const x = fix?.markets?.['1x2'] || {};
  const pushIf = (code, label, price) => {
    if (Number.isFinite(price) && price >= 1.01) {
      xs.push({ fixture_id: fix.fixture_id || fix.fixture?.id, market: "1x2", pick: code, selection_label: label, odds: { price: Number(price) }, confidence_pct: confFromOdds(Number(price)), league: fix.league, league_name: fix.league?.name, league_country: fix.league?.country, teams: fix.teams, home: fix.home, away: fix.away, kickoff: fix.kickoff, kickoff_utc: fix.kickoff_utc || fix.kickoff });
    }
  };
  if (x.home) pushIf("1", "Home", x.home);
  if (x.draw) pushIf("X", "Draw", x.draw);
  if (x.away) pushIf("2", "Away", x.away);
  return xs;
}

function capPerLeague(items, maxPerLeague) {
  const per = new Map(); const out = [];
  for (const it of items){
    const key = String(it?.league?.id || it?.league_name || "?");
    const cur = per.get(key) || 0;
    if (cur >= maxPerLeague) continue;
    per.set(key, cur+1);
    out.push(it);
  }
  return out;
}
function applyUefaCap(items, uefaCap) {
  const out = []; let uefaCount = 0;
  for (const it of items){
    const uefa = isUEFA(it.league);
    if (uefa) { if (uefaCount >= uefaCap) continue; uefaCount++; }
    out.push(it);
  }
  return out;
}
function groupTickets(items){
  const t = { btts: [], ou25: [], fh_ou15: [], htft: [] };
  for (const it of items){
    if (it.market === "BTTS") t.btts.push(it);
    else if (it.market === "OU2.5") t.ou25.push(it);
    else if (it.market === "FH_OU1.5") t.fh_ou15.push(it);
    else if (it.market === "HTFT") t.htft.push(it);
  }
  const clamp = arr => arr.slice(0, Math.max(3, Math.min(5, arr.length)));
  t.btts = clamp(t.btts); t.ou25 = clamp(t.ou25); t.fh_ou15 = clamp(t.fh_ou15); t.htft = clamp(t.htft);
  return t;
}
function oneXtwoCapForSlot(slot, isWeekend) {
  if (slot === "late") return CAP_LATE;
  if (!isWeekend) return slot==="am" ? CAP_AM_WD : CAP_PM_WD;
  return slot==="am" ? CAP_AM_WE : CAP_PM_WE;
}

/* ---------- main ---------- */
export default async function handler(req, res){
  const trace = [];
  try{
    const now = new Date(); const ymd = ymdInTZ(now, TZ);
    let slot = String(req.query.slot||"auto").toLowerCase();
    if (!["late","am","pm"].includes(slot)) slot = pickSlotAuto(now);
    const weekend = isWeekendYmd(ymd, TZ);

    const unionKey = `vb:day:${ymd}:${slot}`;
    const fullKey  = `vbl_full:${ymd}:${slot}`;
    let union = kvToItems(await kvGET(unionKey, trace));
    let full  = kvToItems(await kvGET(fullKey,  trace));
    const base = full.items.length ? full.items : union.items;

    if (!base.length){
      return res.status(200).json({ ok:true, ymd, slot, source:null, items:[], tickets:{ btts:[], ou25:[], fh_ou15:[], htft:[] }, one_x_two: [], debug:{ trace } });
    }

    const candidates = []; for (const f of base) candidates.push(...toCandidates(f));
    const byFixture = new Map();
    for (const c of candidates) { const fid=c.fixture_id; const s=byFixture.get(fid)||new Set(); s.add(c.market); byFixture.set(fid,s); }
    const goodFixture = new Set([...byFixture.entries()].filter(([_,s])=>s.size>=2).map(([fid])=>fid));
    const filtered = candidates.filter(c=>goodFixture.has(c.fixture_id));
    filtered.sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
    const afterUefa = applyUefaCap(filtered, UEFA_DAILY_CAP);
    const leagueCapped = capPerLeague(afterUefa, VB_MAX_PER_LEAGUE);
    const topN = leagueCapped.slice(0, VB_LIMIT);
    const tickets = groupTickets(topN);

    const oneXtwoAll = []; for (const f of base) oneXtwoAll.push(...oneXtwoOffers(f));
    oneXtwoAll.sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
    const oneXtwoCap = oneXtwoCapForSlot(slot, weekend);
    const oneXtwo = capPerLeague(oneXtwoAll, VB_MAX_PER_LEAGUE).slice(0, oneXtwoCap);

    return res.status(200).json({ ok:true, ymd, slot, source: full.items.length?"vbl_full":"vb:day", items: topN, tickets, one_x_two: oneXtwo, debug:{ trace } });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
