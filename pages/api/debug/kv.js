// pages/api/debug/kv.js
// Unified KV diagnostika: vb:day:* pointeri (CET/UTC) + skeniranje vbl/vbl_full za 0/-1/-2 dana.
// Radi samo sa KV REST (nema spoljnog API-ja).

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = fmt.formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function shiftDays(d, days){ const nd = new Date(d.getTime()); nd.setUTCDate(nd.getUTCDate()+days); return nd; }

async function kvGETraw(key){
  const r = await fetch(`${KV_URL.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json().catch(()=>null) : await r.text().catch(()=>null);
  return (body && typeof body === "object" && "result" in body) ? body.result : body;
}

function countItems(v) {
  try { if (typeof v === "string") v = JSON.parse(v); } catch { /* leave as-is */ }
  const arr =
    (Array.isArray(v) && v) ||
    (Array.isArray(v?.items) && v.items) ||
    (Array.isArray(v?.value_bets) && v.value_bets) ||
    (Array.isArray(v?.football) && v.football) ||
    (Array.isArray(v?.data?.items) && v.data.items) ||
    (Array.isArray(v?.data?.value_bets) && v.data.value_bets) ||
    (Array.isArray(v?.data?.football) && v.data.football) ||
    [];
  return { count: arr.length, sample: arr[0] ?? null };
}

// Ako pointer vrednost izgleda kao JSON { key: "..." } ili kao plain key string, dereferenciraj
async function derefPointer(val) {
  if (val == null) return { target: null, exists: false, count: 0 };
  // 1) JSON object with key
  if (typeof val === "string") {
    try {
      const obj = JSON.parse(val);
      if (obj && typeof obj === "object" && typeof obj.key === "string") {
        const raw = await kvGETraw(obj.key);
        const { count } = countItems(raw);
        return { target: obj.key, exists: raw != null, count };
      }
    } catch { /* not JSON */ }
    // 2) Treat as key
    const raw2 = await kvGETraw(val);
    const { count: c2 } = countItems(raw2);
    return { target: val, exists: raw2 != null, count: c2 };
  }
  // 3) Embedded snapshot with items
  const { count } = countItems(val);
  return { target: "(embedded)", exists: count > 0, count };
}

export default async function handler(req, res){
  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ ok:false, error:"KV_REST_API_URL / KV_REST_API_TOKEN not set" });
  }

  const now = new Date();
  const dayCET = ymdInTZ(now, TZ);
  const dayUTC = ymdInTZ(now, "UTC");

  // 1) vb:day pointers
  const ptrCETkey = `vb:day:${dayCET}:last`;
  const ptrUTCkey = `vb:day:${dayUTC}:last`;
  const ptrCETraw = await kvGETraw(ptrCETkey);
  const ptrUTCraw = await kvGETraw(ptrUTCkey);

  const ptrCET = await derefPointer(ptrCETraw);
  const ptrUTC = await derefPointer(ptrUTCraw);

  // 2) vbl/vbl_full scan for 0/-1/-2 days, slots pm/am/late
  const days = [0, -1, -2];
  const slots = ["pm","am","late"];
  const scan = [];
  for (const d of days) {
    const y = ymdInTZ(shiftDays(now, d), TZ);
    for (const s of slots) {
      for (const prefix of ["vbl","vbl_full"]) {
        const key = `${prefix}:${y}:${s}`;
        const raw = await kvGETraw(key);
        const { count } = countItems(raw);
        scan.push({ key, ymd:y, slot:s, exists: raw != null, count });
      }
      // i locked varijante koje se ponekad koriste
      for (const alt of ["vb:locked","vb_locked","vb-locked","locked:vbl"]) {
        const key = `${alt}:${y}:${s}`;
        const raw = await kvGETraw(key);
        const { count } = countItems(raw);
        scan.push({ key, ymd:y, slot:s, exists: raw != null, count });
      }
    }
    // vb:day:<ymd>:last pointer za taj dan
    const kDay = `vb:day:${y}:last`;
    const rawDay = await kvGETraw(kDay);
    const deref = await derefPointer(rawDay);
    scan.push({ key: kDay, ymd:y, slot:"-", exists: rawDay != null, pointer_target: deref.target, pointer_count: deref.count });
  }

  return res.status(200).json({
    ok: true,
    tz: TZ,
    dayCET, dayUTC,
    pointer: {
      cet_key: ptrCETkey, cet_target: ptrCET.target, cet_exists: ptrCET.exists, cet_count: ptrCET.count,
      utc_key: ptrUTCkey, utc_target: ptrUTC.target, utc_exists: ptrUTC.exists, utc_count: ptrUTC.count,
    },
    scan // lista objekata: {key, ymd, slot, exists, count, ...}
  });
}
