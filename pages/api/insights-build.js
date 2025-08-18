// pages/api/insights-build.js
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
async function kvSET(key, value){
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body
  });
  return r.ok;
}
async function readAnySnapshot(){
  const now = new Date();
  const keys = [
    `vb:day:${ymdInTZ(now, TZ)}:last`,
    `vb:day:${ymdInTZ(now, "UTC")}:last`
  ];
  for (const k of keys) {
    const v = await kvGET(k);
    if (Array.isArray(v) && v.length) return { arr:v, key:k };
  }
  return { arr:[], key: keys.join(" | ") };
}

export default async function handler(req, res){
  try {
    const { arr, key } = await readAnySnapshot();
    if (!Array.isArray(arr) || !arr.length) {
      return res.status(200).json({ updated:0, reason:"no snapshot", tried:key });
    }

    let updated = 0;
    for (const p of arr) {
      try {
        const fid = p?.fixture_id;
        if (!fid) continue;
        const k = `vb:insight:${fid}`;
        const seen = await kvGET(k).catch(()=>null);
        if (seen?.line) continue;

        const h = p?.teams?.home?.name || p?.teams?.home || "Home";
        const a = p?.teams?.away?.name || p?.teams?.away || "Away";
        const mrk = `${p?.market_label || p?.market || ""}`.toUpperCase();
        const sel = `${p?.selection || ""}`;
        const line = `Duel: ${h} vs ${a}. Predlog: ${mrk} – ${sel}.`;

        const ok = await kvSET(k, { line });
        if (ok) updated++;
      } catch {}
    }
    return res.status(200).json({ updated, from:key });
  } catch (e) {
    return res.status(200).json({ updated:0, error:String(e?.message||e) });
  }
}
