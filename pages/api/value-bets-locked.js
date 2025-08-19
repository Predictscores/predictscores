// pages/api/value-bets-locked.js
// Čita slotove (AM/PM/LATE) za današnji dan, pravi UNION (dedupe) i primenjuje filtere
// prozor=72h, freeze=30min, league-cap, min kvota. Fallback: :last ako slotovi ne postoje.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

const VB_LIMIT   = parseInt(process.env.VB_LIMIT || "25", 10);
const LEAGUE_CAP = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const WINDOW_HOURS      = parseInt(process.env.VB_WINDOW_HOURS || "72", 10);
const FREEZE_MIN_BEFORE = parseInt(process.env.VB_FREEZE_MIN || "30", 10);
const MIN_ODDS          = parseFloat(process.env.MIN_ODDS || "1.5");

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
async function kvGETraw(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
function parseArray(raw){
  try{
    let v = raw;
    if (typeof v==="string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v==="object"){
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner==="string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}
function dedupe(list){
  const m = new Map();
  for (const p of list){
    const id = p?.fixture_id ?? `${p?.league?.id||""}-${p?.teams?.home?.name||""}-${p?.teams?.away?.name||""}`;
    if (!m.has(id)) m.set(id, p);
  }
  return Array.from(m.values());
}
const impliedFromOdds = o => (Number(o)>0 ? 1/Number(o) : null);
const edgePP = (mp,ip) => (!Number.isFinite(mp)||!Number.isFinite(ip)||ip<=0)?null:((mp/ip-1)*100);
function isExcluded(p){
  const ln = `${p?.league?.name||""}`.toLowerCase();
  const th = `${p?.teams?.home?.name||p?.teams?.home||""}`.toLowerCase();
  const ta = `${p?.teams?.away?.name||p?.teams?.away||""}`.toLowerCase();
  return /(women|ladies|u19|u21|u23|youth|reserve|res\.?)/i.test(ln) || /(women)/i.test(th) || /(women)/i.test(ta);
}

export default async function handler(req, res){
  try {
    const now = new Date();
    const dayCET = ymdInTZ(now, TZ);
    const dayUTC = ymdInTZ(now, "UTC");

    // probaj slotove
    const am  = parseArray(await kvGETraw(`vb:day:${dayCET}:am`));
    const pm  = parseArray(await kvGETraw(`vb:day:${dayCET}:pm`));
    const lt  = parseArray(await kvGETraw(`vb:day:${dayCET}:late`));

    let arr = dedupe([ ...am, ...pm, ...lt ]);
    let source = "slots-union";
    if (!arr.length) {
      // fallback na :last
      arr = parseArray(await kvGETraw(`vb:day:${dayCET}:last`));
      source = arr.length ? "locked-last" : "ensure-wait";
      if (!arr.length) {
        arr = parseArray(await kvGETraw(`vb:day:${dayUTC}:last`));
        if (arr.length) source = "locked-last-utc";
      }
    }

    if (!arr.length) {
      return res.status(200).json({ value_bets: [], built_at: isoNow(), day: dayCET, source });
    }

    // filteri
    const out = [];
    const byLeague = new Map();
    const nowMs = +now;
    const endMs = nowMs + WINDOW_HOURS*3600*1000;

    // sortiraj pre rezanja radi stabilnosti
    arr.sort((a,b)=>{
      if ((b?.confidence_pct||0)!==(a?.confidence_pct||0)) return (b.confidence_pct||0)-(a.confidence_pct||0);
      const eva = Number.isFinite(a?.ev) ? a.ev : -Infinity;
      const evb = Number.isFinite(b?.ev) ? b.ev : -Infinity;
      if (evb!==eva) return evb-eva;
      const ta=+new Date(String(a?.datetime_local?.starting_at?.date_time||"").replace(" ","T"));
      const tb=+new Date(String(b?.datetime_local?.starting_at?.date_time||"").replace(" ","T"));
      return ta-tb;
    });

    for (const p0 of arr) {
      try {
        const p = { ...p0 };
        if (isExcluded(p)) continue;

        const t = String(p?.datetime_local?.starting_at?.date_time || "").replace(" ","T");
        const ms = +new Date(t);
        if (!ms || ms > endMs) continue;

        const mins = Math.round((ms - nowMs)/60000);
        if (mins <= FREEZE_MIN_BEFORE) continue;

        let odds = Number(p?.market_odds);
        if (!Number.isFinite(odds) || odds < MIN_ODDS) continue;

        const ip = impliedFromOdds(odds);
        const ev = edgePP(Number(p?.model_prob||0), ip);

        out.push({
          ...p,
          market_odds: Number(odds.toFixed(2)),
          implied_prob: ip,
          edge_pp: ev,
          explain: p.explain || {}
        });

        const lkey = `${p?.league?.id||""}`;
        byLeague.set(lkey, (byLeague.get(lkey)||0)+1);
        if (byLeague.get(lkey) >= LEAGUE_CAP && out.length >= VB_LIMIT) break;
        if (out.length >= VB_LIMIT) break;
      } catch {}
    }

    return res.status(200).json({
      value_bets: out,
      built_at: isoNow(),
      day: dayCET,
      source
    });
  } catch (e) {
    return res.status(200).json({
      value_bets: [],
      built_at: isoNow(),
      day: ymdInTZ(new Date(), TZ),
      source: "error",
      error: String(e?.message || e)
    });
  }
}
