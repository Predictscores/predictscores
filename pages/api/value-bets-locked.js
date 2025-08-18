// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

const VB_LIMIT   = parseInt(process.env.VB_LIMIT || "25", 10);
const LEAGUE_CAP = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const WINDOW_HOURS      = parseInt(process.env.VB_WINDOW_HOURS || "72", 10);
const FREEZE_MIN_BEFORE = parseInt(process.env.VB_FREEZE_MIN || "30", 10);

const MIN_ODDS      = 1.50;
const OU_MAX_ODDS   = 2.60;
const BTTS_MAX_ODDS = 2.80;

const isoNow = () => new Date().toISOString();
function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d);
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json().catch(()=>null);
    const val = (j && typeof j==="object" && "result" in j) ? j.result : j;
    try { return typeof val==="string" ? JSON.parse(val) : val; } catch { return val; }
  }
  const t = await r.text().catch(()=>null);
  try { return JSON.parse(t); } catch { return t; }
}
function isExcludedLeagueOrTeam(p){
  const ln = `${p?.league?.name||""}`.toLowerCase();
  const th = `${p?.teams?.home?.name||p?.teams?.home||""}`.toLowerCase();
  const ta = `${p?.teams?.away?.name||p?.teams?.away||""}`.toLowerCase();
  return ln.includes("women") || ln.includes("u19") || ln.includes("reserve") || th.includes("women") || ta.includes("women");
}
const impliedFromOdds = o => (Number(o)>0 ? 1/Number(o) : null);
const edgePP = (mp,ip) => (!Number.isFinite(mp)||!Number.isFinite(ip)||ip<=0)?null:((mp/ip-1)*100);

export default async function handler(req, res){
  try {
    const now = new Date();
    const dayCET = ymdInTZ(now, TZ);
    const dayUTC = ymdInTZ(now, "UTC");

    // 1) Pročitaj snapshot (CET pa UTC) — BEZ auto-rebuilda
    let arr = await kvGET(`vb:day:${dayCET}:last`);
    let source = "locked-cache";
    if (!Array.isArray(arr) || !arr.length) {
      arr = await kvGET(`vb:day:${dayUTC}:last`);
      source = Array.isArray(arr) && arr.length ? "locked-cache-utc" : "ensure-wait";
    }
    if (!Array.isArray(arr) || !arr.length) {
      return res.status(200).json({ value_bets: [], built_at: isoNow(), day: dayCET, source });
    }

    // 2) Filtriranje i priprema bez AF poziva
    const out = [];
    const byLeague = new Map();
    const nowMs = +now;
    const endMs = nowMs + WINDOW_HOURS*3600*1000;

    for (const p0 of arr) {
      try {
        const p = { ...p0 };
        const t = String(p?.datetime_local?.starting_at?.date_time || "").replace(" ","T");
        const ms = +new Date(t);
        if (!ms || ms > endMs) continue;
        const mins = Math.round((ms - nowMs)/60000);
        if (mins <= FREEZE_MIN_BEFORE) continue;

        if (isExcludedLeagueOrTeam(p)) continue;
        const lkey = `${p?.league?.id||""}`; const c = byLeague.get(lkey)||0;
        if (c >= LEAGUE_CAP) continue;

        // realistični rezovi na očiglednim outlier kvotama (bez doračunavanja)
        const cat  = String(p?.market_label || p?.market || "").toUpperCase();
        let odds   = Number(p?.market_odds || 0);
        if (!Number.isFinite(odds)) continue;
        if (odds < MIN_ODDS) continue;
        if (cat==="OU" && odds>OU_MAX_ODDS) continue;
        if (cat==="BTTS" && odds>BTTS_MAX_ODDS) continue;

        const ip = impliedFromOdds(odds);
        const ev = edgePP(Number(p?.model_prob||0), ip);
        p.market_odds  = Number(odds.toFixed(2));
        p.implied_prob = ip;
        p.edge_pp      = ev;

        // “Zašto” iz KV, a ako nema — kratak ljudski fallback
        const fid = p.fixture_id;
        let explain = p.explain || {};
        let line = null;
        if (fid) {
          const ins = await kvGET(`vb:insight:${fid}`).catch(()=>null);
          line = ins?.line || null;
        }
        if (!line) {
          const h = p?.teams?.home?.name || p?.teams?.home || "Home";
          const a = p?.teams?.away?.name || p?.teams?.away || "Away";
          const mrk = `${p?.market_label || p?.market || ""}`.toUpperCase();
          const sel = `${p?.selection || ""}`;
          line = `Duel: ${h} vs ${a}. Predlog: ${mrk} – ${sel}.`;
        }
        explain = { ...explain, summary: line };

        out.push({ ...p, explain });
        byLeague.set(lkey, c+1);
        if (out.length >= VB_LIMIT) break;
      } catch { /* preskoči jedan meč */ }
    }

    return res.status(200).json({
      value_bets: out,
      built_at: isoNow(),
      day: dayCET,
      source
    });
  } catch (e) {
    return res.status(200).json({ value_bets: [], built_at: isoNow(), day: ymdInTZ(new Date(), TZ), source:"error", error:String(e?.message||e) });
  }
}
