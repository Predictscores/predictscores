// pages/api/debug/alias-last.js
export const config = { api: { bodyParser: false } };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d); // YYYY-MM-DD
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
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json().catch(()=>null);
    const val = (j && typeof j === "object" && "result" in j) ? j.result : j;
    try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return val; }
  }
  const t = await r.text().catch(()=>null);
  try { return JSON.parse(t); } catch { return t; }
}

async function kvSET(key, value){
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body
  });
  const ok = r.ok;
  let res = null;
  try { res = await r.json(); } catch {}
  return { ok, res };
}

export default async function handler(req, res){
  try {
    const day = (req.query.day || ymdInTZ()).toString();
    const rev = (req.query.rev || "").toString().trim();

    if (!KV_URL || !KV_TOKEN) {
      return res.status(200).json({ ok: false, error: "KV env missing" });
    }
    if (!rev) {
      return res.status(200).json({ ok: false, error: "Provide ?rev=NN (from /api/cron/rebuild)" });
    }

    const srcKey = `vb:day:${day}:rev:${rev}`;
    const dstKey = `vb:day:${day}:last`;

    const data = await kvGET(srcKey);
    if (!Array.isArray(data) || !data.length) {
      return res.status(200).json({ ok:false, error:"Source rev not found or empty", srcKey });
    }

    const { ok, res:writeRes } = await kvSET(dstKey, data);
    if (!ok) {
      return res.status(200).json({ ok:false, error:"KV set failed", dstKey, writeRes });
    }

    return res.status(200).json({ ok:true, aliased:{ from:srcKey, to:dstKey, size:data.length } });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
