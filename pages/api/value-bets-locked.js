// FILE: pages/api/value-bets-locked.js
// Zaključani feed za AKTIVNI slot (ceo prozor), sa normalizacijom KO vremena (ko_local "HH:mm" po Europe/Belgrade).
export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function ymd(tz = TZ, d = new Date()) {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function hourInTZ(tz = TZ, d = new Date()){
  try { return parseInt(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour:"2-digit",hour12:false}).format(d),10); }
  catch { return d.getHours(); }
}
function activeSlot(now = new Date()){
  const h = hourInTZ(TZ, now);
  if (h >= 0  && h < 10) return "late"; // 00–10
  if (h >= 10 && h < 15) return "am";   // 10–15
  return "pm";                           // 15–24
}
function parseMaybe(v){ if(v==null) return null; if(typeof v==="object") return v; if(typeof v==="string"){ try{return JSON.parse(v);}catch{return v;} } return v; }
function arr(v){ const p=parseMaybe(v); if(Array.isArray(p?.items)) return p.items; if(Array.isArray(p)) return p; return []; }

async function kvGet(key){
  if (!KV_URL || !KV_TOKEN) throw new Error("KV env missing");
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers:{Authorization:`Bearer ${KV_TOKEN}`}, cache:"no-store" });
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  return j && typeof j==="object" && "result" in j ? j.result : j;
}

function isoFromItem(it){
  return it?.datetime_local?.starting_at?.date_time
      || it?.datetime_local?.date_time
      || it?.time?.starting_at?.date_time
      || it?.ko
      || null;
}
function inSlotWindow(item, day, slot){
  const iso = isoFromItem(item); if(!iso) return false;
  const dt = new Date(String(iso).replace(" ","T"));
  const partsDay = ymd(TZ, dt);
  if (partsDay !== day) return false;
  const h = hourInTZ(TZ, dt);
  if (slot === "am")   return h >= 10 && h < 15;
  if (slot === "pm")   return h >= 15 && h < 24;
  if (slot === "late") return h >= 0  && h < 10;
  return true;
}
function koLocal(iso){
  try{
    const dt = new Date(String(iso||"").replace(" ","T"));
    return new Intl.DateTimeFormat("sr-RS",{timeZone:TZ,hour:"2-digit",minute:"2-digit"}).format(dt);
  }catch{ return "—"; }
}

async function localGet(req, path){
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"]  || req.headers.host;
  const base  = `${proto}://${host}`;
  const r = await fetch(`${base}${path}`, { headers: { "cache-control":"no-store" } });
  if (!r.ok) return null;
  return r.json().catch(()=>null);
}

export default async function handler(req, res){
  res.setHeader("Content-Type","application/json; charset=utf-8");
  try{
    const day  = String(req.query.ymd || ymd());
    const slot = activeSlot();

    let source = "last";
    let items  = arr(await kvGet(`vb:day:${day}:last`)).filter(p=>inSlotWindow(p,day,slot));

    if (!items.length){
      const s = arr(await kvGet(`vb:day:${day}:${slot}`)).filter(p=>inSlotWindow(p,day,slot));
      if (s.length){ items=s; source="slot"; }
    }
    if (!items.length){
      const u = arr(await kvGet(`vb:day:${day}:union`)).filter(p=>inSlotWindow(p,day,slot));
      if (u.length){ items=u; source="union"; }
    }
    if (!items.length){
      const gen = await localGet(req, `/api/value-bets`);
      const vb  = Array.isArray(gen?.value_bets) ? gen.value_bets : [];
      const f   = vb.filter(p=>inSlotWindow(p,day,slot));
      if (f.length){ items=f; source="generator"; }
    }

    // NORMALIZUJ: dodaj ko_local i sortiraj
    const norm = (items||[]).map(it=>{
      const iso = isoFromItem(it);
      return { ...it, ko_local: koLocal(iso) };
    }).sort((a,b)=>{
      const ta=+new Date(String(isoFromItem(a)||"").replace(" ","T"));
      const tb=+new Date(String(isoFromItem(b)||"").replace(" ","T"));
      return ta - tb;
    });

    res.status(200).end(JSON.stringify({
      ok: true,
      ymd: day,
      slot,
      built_at: new Date().toISOString(),
      items: norm,
      source,
      locked_version: "v6-ko-local"
    }));
  }catch(e){
    res.status(200).end(JSON.stringify({ ok:false, error:String(e?.message||e), ymd:null, slot:null, built_at:null, items:[], source:"error", locked_version:"v6-ko-local" }));
  }
}
