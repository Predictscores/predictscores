// pages/api/debug/kv.js
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

async function kvGETraw(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json().catch(()=>null) : await r.text().catch(()=>null);
  return (body && typeof body==="object" && "result" in body) ? body.result : body;
}
function normalizeSnapshot(raw) {
  let v = raw;
  try { if (typeof v === "string") v = JSON.parse(v); } catch { return { len:0, note:"parse-failed", preview:String(raw||"").slice(0,180) }; }
  let arr=[];
  if (Array.isArray(v)) arr=v;
  else if (v && typeof v==="object") {
    if (Array.isArray(v.value_bets)) arr=v.value_bets;
    else if (Array.isArray(v.arr)) arr=v.arr;
    else if (Array.isArray(v.data)) arr=v.data;
  }
  return { len:arr.length, type:Array.isArray(v)?"array":typeof v, sample:arr[0]||null, preview:String(raw||"").slice(0,180) };
}

export default async function handler(req, res){
  const now = new Date();
  const dayCET = ymdInTZ(now, TZ);
  const dayUTC = ymdInTZ(now, "UTC");
  const k = `vb:day:${dayCET}:last`;
  const kAlt = `vb:day:${dayUTC}:last`;
  const raw  = await kvGETraw(k);
  const raw2 = await kvGETraw(kAlt);

  return res.status(200).json({
    dayCET, dayUTC,
    cet_key:k, utc_key:kAlt,
    cet_info: normalizeSnapshot(raw),
    utc_info: normalizeSnapshot(raw2)
  });
}
