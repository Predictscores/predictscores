// pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d); // YYYY-MM-DD
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}

async function kvSET(key, value){
  // Upstash/Vercel KV: POST body { value: "<string>" }
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
  let js=null; try{ js=await r.json(); }catch{}
  return { ok:r.ok, js };
}

export default async function handler(req, res){
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const base  = `${proto}://${host}`;

    // 1) GENERATE (uzima sve kandidate za danas)
    const r = await fetch(`${base}/api/value-bets`, { headers: { "cache-control":"no-store" } });
    if (!r.ok) return res.status(200).json({ ok:false, error:`generator ${r.status}` });
    const j = await r.json().catch(()=>null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];
    const count = arr.length;

    // 2) UPIS u KV — čuvamo OBJEKAT sa array-em (da reader sigurno prepozna format)
    const now = new Date();
    const dayCET = ymdInTZ(now, TZ);
    const dayUTC = ymdInTZ(now, "UTC");
    const rev = Math.floor(Date.now()/1000);

    const payload = { value_bets: arr, meta: { dayCET, dayUTC, rev } };

    const writes = [];
    writes.push(await kvSET(`vb:day:${dayCET}:rev:${rev}`, payload));
    writes.push(await kvSET(`vb:day:${dayCET}:last`, payload));
    writes.push(await kvSET(`vb:day:${dayUTC}:last`, payload)); // alias

    const persisted = writes.every(w => w.ok);
    return res.status(200).json({ ok:true, snapshot_for:dayCET, count, rev, persisted });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
