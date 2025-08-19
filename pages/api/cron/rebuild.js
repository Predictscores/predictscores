// pages/api/cron/rebuild.js
// Pravi snapshot po slotu (AM/PM/LATE) i upisuje u KV.
// Zatim pravi i kombinovani "last" = AM ∪ PM ∪ LATE (dedupe).
// Idempotent guard: min razmak 60s.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d);
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function hourInTZ(d=new Date(), tz=TZ){
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, hour:"2-digit", hour12:false });
    return parseInt(fmt.format(d),10);
  } catch {
    return d.getHours();
  }
}
function toTZDate(iso, tz=TZ) {
  // vrati { ymd, hour } kickoff-a u zadatoj zoni
  const dt = new Date(iso);
  return { ymd: ymdInTZ(dt, tz), hour: hourInTZ(dt, tz) };
}

async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
async function kvSET(key, value){
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  let js=null; try{ js=await r.json(); }catch{}
  return { ok:r.ok, js };
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
function dedupeUnion(...lists){
  const map = new Map();
  for (const L of lists){
    for (const p of (L||[])){
      const id = p?.fixture_id ?? `${p?.league?.id||""}-${p?.teams?.home?.name||""}-${p?.teams?.away?.name||""}`;
      if (!map.has(id)) map.set(id, p);
    }
  }
  return Array.from(map.values());
}

export default async function handler(req, res){
  try {
    // idempotent guard (60s)
    const lastRunRaw = await kvGET(`vb:jobs:last:rebuild`);
    const nowMs = Date.now();
    try {
      const last = (typeof lastRunRaw==="string") ? JSON.parse(lastRunRaw) : lastRunRaw;
      if (last && nowMs - Number(last?.ts||0) < 60_000) {
        return res.status(200).json({ ok:true, skipped:true, reason:"cooldown", at:new Date().toISOString() });
      }
    } catch {}

    // utvrdi slot: ?slot=am|pm|late (preporuka), ili po satu u TZ
    const slotQ = String(req.query.slot||"").toLowerCase();
    const now = new Date();
    const dayCET = ymdInTZ(now, TZ);
    let slot = slotQ;
    if (!slot) {
      const h = hourInTZ(now, TZ);
      if (h < 15) slot = "am";
      else if (h < 24) slot = "pm";
      else slot = "late";
    }

    // pozovi generator (sve mečeve)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const base  = `${proto}://${host}`;
    const r = await fetch(`${base}/api/value-bets`, { headers: { "cache-control":"no-store" } });
    if (!r.ok) return res.status(200).json({ ok:false, error:`generator ${r.status}` });
    const j = await r.json().catch(()=>null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

    // filtriraj po slot prozoru (lokalno vreme)
    const inWindow = (pick) => {
      const t = String(pick?.datetime_local?.starting_at?.date_time || "").replace(" ","T");
      const tz = toTZDate(t, TZ);
      if (tz.ymd !== dayCET) return false;
      if (slot === "am")   return tz.hour >= 10 && tz.hour < 15;
      if (slot === "pm")   return tz.hour >= 15 && tz.hour < 24;
      if (slot === "late") return tz.hour >= 0  && tz.hour <  3;
      return true;
    };
    const bySlot = arr.filter(inWindow);

    // upiši slot ključ
    const slotKey = `vb:day:${dayCET}:${slot}`;
    await kvSET(slotKey, bySlot);

    // pročitaj postojeće slotove i napravi kombinovani "last"
    const am  = parseArray(await kvGET(`vb:day:${dayCET}:am`));
    const pm  = parseArray(await kvGET(`vb:day:${dayCET}:pm`));
    const lt  = parseArray(await kvGET(`vb:day:${dayCET}:late`));
    const union = dedupeUnion(am, pm, lt);

    const rev = Math.floor(nowMs/1000);
    await kvSET(`vb:day:${dayCET}:rev:${rev}`, union);
    await kvSET(`vb:day:${dayCET}:last`, union);
    await kvSET(`vb:day:${ymdInTZ(now, "UTC")}:last`, union);
    await kvSET(`vb:jobs:last:rebuild`, { ts: nowMs, slot });

    return res.status(200).json({
      ok:true, snapshot_for:dayCET, slot, count_slot:bySlot.length, count_union:union.length, rev, persisted:true
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
