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

async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return { ok:false, status:r.status, len:0, type:"", sample:null };
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json().catch(()=>null) : await r.text().catch(()=>null);
  let raw = body;
  if (body && typeof body==="object" && "result" in body) raw = body.result;

  let parsed = null;
  try { parsed = (typeof raw==="string") ? JSON.parse(raw) : raw; } catch {}
  let arr = [];
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed==="object") {
    if (Array.isArray(parsed.value_bets)) arr = parsed.value_bets;
    else if (Array.isArray(parsed.arr)) arr = parsed.arr;
    else if (Array.isArray(parsed.data)) arr = parsed.data;
  }

  return {
    ok:true,
    status:r.status,
    len: arr.length,
    type: Array.isArray(parsed) ? "array" : typeof parsed,
    sample: arr[0] || null,
    rawType: typeof raw
  };
}

export default async function handler(req, res){
  const now = new Date();
  const dayCET = ymdInTZ(now, TZ);
  const dayUTC = ymdInTZ(now, "UTC");
  const k1 = `vb:day:${dayCET}:last`;
  const k2 = `vb:day:${dayUTC}:last`;

  const r1 = await kvGET(k1);
  const r2 = await kvGET(k2);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ dayCET, dayUTC, k1, k2, k1_info: r1, k2_info: r2 });
}
