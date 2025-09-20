// pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ helpers ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));

/* ---------- KV (Vercel KV or Upstash REST) ---------- */
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
      const v = j?.result ?? j?.value ?? null;
      if (v==null) continue;
      const out = typeof v==="string" ? JSON.parse(v) : v;
      trace.push({kv:"hit", key, flavor:b.flavor, size: (Array.isArray(out?.items)?out.items.length: (Array.isArray(out)?out.length:0))});
      return out;
    } catch {}
  }
  trace.push({kv:"miss", key});
  return null;
}
async function kvSET(key, val, trace=[]) {
  const saves = [];
  for (const b of kvBackends()) {
    try {
      const body = typeof val==="string" ? val : JSON.stringify(val);
      const u = `${b.url}/set/${encodeURIComponent(key)}`;
      const r = await fetch(u, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${b.tok}` }, body: JSON.stringify({ value: body }) });
      saves.push({ key, flavor:b.flavor, ok:r.ok });
    } catch (e) {
      saves.push({ key, flavor:b.flavor, ok:false, error:String(e?.message||e) });
    }
  }
  trace.push({kv:"set", key, saves});
  return saves;
}

/* ---------- API-Football thin wrapper (uses official header) ---------- */
const { afxFixturesByDate } = require("../../../lib/sources/apiFootball");

/* ---------- utils ---------- */
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function isYouthLeague(name=""){ name=String(name||"").toLowerCase(); return /(u-?\d{2}|youth|reserve|women|futsal)/.test(name); }
function kickoffISOFromAF(fix){ return fix?.fixture?.date || null; }
function leagueFromAF(fix){ return { id: fix?.league?.id, name: fix?.league?.name, country: fix?.league?.country, season: fix?.league?.season }; }
function teamsFromAF(fix){ return { home: fix?.teams?.home?.name, away: fix?.teams?.away?.name, home_id: fix?.teams?.home?.id, away_id: fix?.teams?.away?.id }; }

function slotFilter(dateISO, slot){
  if(!dateISO) return false;
  const d = new Date(dateISO);
  const h = hourInTZ(d, TZ);
  if (slot==="late") return h < 10;
  if (slot==="am")   return h >= 10 && h < 15;
  if (slot==="pm")   return h >= 15;
  return true;
}
function perLeagueCap(slot, isWeekend){
  const CAP_LATE = Number(process.env.CAP_LATE)||6;
  const CAP_AM_WD = Number(process.env.CAP_AM_WD)||15;
  const CAP_PM_WD = Number(process.env.CAP_PM_WD)||15;
  const CAP_AM_WE = Number(process.env.CAP_AM_WE)||20;
  const CAP_PM_WE = Number(process.env.CAP_PM_WE)||20;
  if (slot==="late") return CAP_LATE;
  if (!isWeekend) return slot==="am" ? CAP_AM_WD : CAP_PM_WD;
  return slot==="am" ? CAP_AM_WE : CAP_PM_WE;
}
function isWeekendYmd(ymd, tz){
  const [y,m,d]=ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d, 12, 0, 0));
  const w = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, weekday:"short"}).format(dt).toLowerCase();
  return w==="sat"||w==="sun";
}

/* ---------- main ---------- */
export default async function handler(req, res){
  const trace = [];
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    let slot = canonicalSlot(req.query.slot);
    if (slot==="auto") {
      const h = hourInTZ(now, TZ);
      slot = (h<10) ? "late" : (h<15) ? "am" : "pm";
    }
    const weekend = isWeekendYmd(ymd, TZ);
    const capPerLeague = perLeagueCap(slot, weekend);

    // 1) try existing KV
    const unionKey = `vb:day:${ymd}:${slot}`;
    const fullKey  = `vbl_full:${ymd}:${slot}`;
    let base = await kvGET(unionKey, trace);
    let full  = await kvGET(fullKey,  trace);
    const baseItems = Array.isArray(base?.items) ? base.items : (Array.isArray(base)?base:[]);
    const fullItems = Array.isArray(full?.items) ? full.items : (Array.isArray(full)?full:[]);

    let items = fullItems.length ? fullItems : baseItems;
    let budgetStop = false;

    const respond = ({ items: responseItems = items, source } = {}) => {
      const resolvedSource = source ?? (responseItems.length ? "af:seed-or-kv" : (budgetStop ? "budget" : "empty"));
      return res.status(200).json({
        ok:true,
        ymd, slot,
        counts: { full: responseItems.length },
        source: resolvedSource,
        budget_exhausted: budgetStop,
        trace
      });
    };

    // 2) If base empty, fetch fixtures for the day and seed KV
    if (!items.length){
      const af = await afxFixturesByDate(ymd, { priority: "P2" });
      const list = Array.isArray(af?.response) ? af.response : null;
      if (!list) {
        budgetStop = true;
        trace.push({ afx: "fixtures", ymd, budget: "exhausted" });
        const preserved = fullItems.length ? fullItems : baseItems;
        return respond({ items: preserved, source: "budget" });
      }
      const mapped = list
        .filter(f => !isYouthLeague(f?.league?.name))
        .filter(f => slotFilter(kickoffISOFromAF(f), slot))
        .map(f => {
          const dateISO = kickoffISOFromAF(f);
          return {
            fixture_id: f?.fixture?.id,
            fixture: { id: f?.fixture?.id, date: dateISO, timezone: f?.fixture?.timezone },
            kickoff: dateISO,
            kickoff_utc: dateISO,
            league: leagueFromAF(f),
            league_name: f?.league?.name,
            league_country: f?.league?.country,
            teams: teamsFromAF(f),
            home: f?.teams?.home?.name,
            away: f?.teams?.away?.name,
            markets: {} // to be filled by refresh-odds
          };
        });

      // per-league cap for slim list; full list keeps all (by slot)
      const perLeagueCounter = new Map();
      const slim = [];
      for (const it of mapped){
        const key = String(it?.league?.id || it?.league?.name || "?");
        const cur = perLeagueCounter.get(key)||0;
        if (cur < capPerLeague){ slim.push(it); perLeagueCounter.set(key, cur+1); }
      }

      await kvSET(fullKey,  { items: slim   }, trace);
      await kvSET(unionKey, { items: slim   }, trace);
      await kvSET(`vb:day:${ymd}:last`,  { items: slim }, trace);
      await kvSET(`vb:day:${ymd}:union`, { items: slim }, trace);

      items = mapped;
    }

    // Response diagnostic
    return respond();
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
