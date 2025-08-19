// pages/api/cron/rebuild.js
// Pravi dnevni snapshot i upisuje ČIST niz u KV (bez wrapper-a).
// Idempotentna zaštita: minimalni razmak 60s između run-ova.

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

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const base  = `${proto}://${host}`;

    const r = await fetch(`${base}/api/value-bets`, { headers: { "cache-control":"no-store" } });
    if (!r.ok) return res.status(200).json({ ok:false, error:`generator ${r.status}` });
    const j = await r.json().catch(()=>null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];
    const count = arr.length;

    const now = new Date();
    const dayCET = ymdInTZ(now, TZ);
    const dayUTC = ymdInTZ(now, "UTC");
    const rev = Math.floor(nowMs/1000);

    const writes = [];
    writes.push(await kvSET(`vb:day:${dayCET}:rev:${rev}`, arr));
    writes.push(await kvSET(`vb:day:${dayCET}:last`, arr));
    writes.push(await kvSET(`vb:day:${dayUTC}:last`, arr));
    await kvSET(`vb:jobs:last:rebuild`, { ts: nowMs });

    const persisted = writes.every(w => w.ok);
    return res.status(200).json({ ok:true, snapshot_for:dayCET, count, rev, persisted });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message || e) });
  }
}
