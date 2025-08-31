// pages/api/debug/kv.js
// Unified KV dijagnostika: vb:day:* pointeri (CET/UTC) + skeniranje vbl/vbl_full (0/-1/-2 dana)
// uz dekodiranje (JSON string, base64, base64-gzip) i „pametno” brojanje.

// ⚠️ NEMA novih fajlova; ovo je 1:1 zamena postojećeg debug endpointa.

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

function gunzipBase64ToString(b64){
  try {
    const zlib = require("zlib");
    const buf = Buffer.from(b64, "base64");
    const out = zlib.gunzipSync(buf);
    return out.toString("utf8");
  } catch { return null; }
}
function tryDecode(raw){
  if (raw && typeof raw === "object") return raw;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch {}
    const maybe = gunzipBase64ToString(raw);
    if (maybe){ try { return JSON.parse(maybe); } catch {} }
    try {
      const dec = Buffer.from(raw, "base64").toString("utf8");
      try { return JSON.parse(dec); } catch {}
    } catch {}
  }
  return raw;
}
function looksLikeBet(o){
  if (!o || typeof o !== "object") return false;
  const keys = Object.keys(o);
  const must = ["fixture_id","teams","home","away","selection","pick","market","kickoff","confidence_pct","model_prob"];
  let score = 0;
  for (const k of must){ if (k in o) score++; }
  return score >= 2 || ("league" in o && ("teams" in o || "home" in o || "away" in o));
}
function collectCandidateArrays(x, limit = 500){
  const out = [];
  const seen = new Set();
  const stack = [x];
  let guard = 0;
  while (stack.length && out.length < limit && guard < 2000){
    guard++;
    const cur = stack.pop();
    if (!cur) continue;
    if (Array.isArray(cur)){
      if (cur.length && typeof cur[0] === "object" && looksLikeBet(cur[0])) {
        const id = `arr:${cur.length}:${Object.keys(cur[0]).slice(0,5).join(",")}`;
        if (!seen.has(id)){ seen.add(id); out.push(cur); }
        continue;
      }
      for (const it of cur){ if (it && (typeof it==="object" || Array.isArray(it))) stack.push(it); }
      continue;
    }
    if (typeof cur === "object"){
      for (const k in cur){
        const v = cur[k];
        if (v && (typeof v==="object" || Array.isArray(v))) stack.push(v);
      }
    }
  }
  return out;
}
function countAny(v){
  try { v = tryDecode(v); } catch {}
  const arr =
    (Array.isArray(v) && v) ||
    (Array.isArray(v?.items) && v.items) ||
    (Array.isArray(v?.value_bets) && v.value_bets) ||
    (Array.isArray(v?.football) && v.football) ||
    (Array.isArray(v?.data?.items) && v.data.items) ||
    (Array.isArray(v?.data?.value_bets) && v.data.value_bets) ||
    (Array.isArray(v?.data?.football) && v.data.football) ||
    (Array.isArray(v?.full) && v.full) ||
    (Array.isArray(v?.slim) && v.slim) ||
    (Array.isArray(v?.list) && v.list) ||
    (Array.isArray(v?.arr) && v.arr) ||
    (Array.isArray(v?.recs) && v.recs) ||
    (Array.isArray(v?.recommendations) && v.recommendations) ||
    (Array.isArray(v?.football_full) && v.football_full) ||
    (Array.isArray(v?.football_slim) && v.football_slim) ||
    (collectCandidateArrays(v)[0] || []);
  return { count: arr.length, sample: arr[0] ?? null, keys: v && typeof v === "object" ? Object.keys(v) : [] };
}

async function kvGETraw(key){
  const r = await fetch(`${KV_URL.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json().catch(()=>null) : await r.text().catch(()=>null);
  const result = (body && typeof body==="object" && "result" in body) ? body.result : body;
  const exists = result != null;
  return { exists, raw: result };
}

async function derefPointer(val) {
  if (val == null) return { target: null, exists: false, count: 0 };
  if (typeof val === "string") {
    try {
      const obj = JSON.parse(val);
      if (obj && typeof obj === "object" && typeof obj.key === "string") {
        const got = await kvGETraw(obj.key);
        const { count } = countAny(got.raw);
        return { target: obj.key, exists: got.exists, count };
      }
    } catch { /* not JSON */ }
    const got2 = await kvGETraw(val);
    const { count: c2 } = countAny(got2.raw);
    return { target: val, exists: got2.exists, count: c2 };
  }
  const { count } = countAny(val);
  return { target: "(embedded)", exists: count > 0, count };
}

export default async function handler(req, res){
  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ ok:false, error:"KV_REST_API_URL / KV_REST_API_TOKEN not set" });
  }

  const now = new Date();
  const dayCET = ymdInTZ(now, TZ);
  const dayUTC = ymdInTZ(now, "UTC");

  // 1) vb:day pointers (CET/UTC)
  const ptrCETkey = `vb:day:${dayCET}:last`;
  const ptrUTCkey = `vb:day:${dayUTC}:last`;
  const ptrCETraw = await kvGETraw(ptrCETkey);
  const ptrUTCraw = await kvGETraw(ptrUTCkey);
  const ptrCET = await derefPointer(ptrCETraw.raw);
  const ptrUTC = await derefPointer(ptrUTCraw.raw);

  // 2) skeniranje vbl/vbl_full + locked varijante, za 0/-1/-2 dana
  const days = [0, -1, -2];
  const slots = ["pm","am","late"];
  const scan = [];
  for (const d of days) {
    const y = ymdInTZ(shiftDays(now, d), TZ);
    for (const s of slots) {
      for (const prefix of ["vbl","vbl_full"]) {
        const key = `${prefix}:${y}:${s}`;
        const raw = await kvGETraw(key);
        const { count } = countAny(raw.raw);
        scan.push({ key, ymd:y, slot:s, exists: raw.exists, count });
      }
      for (const alt of ["vb:locked","vb_locked","vb-locked","locked:vbl"]) {
        const key = `${alt}:${y}:${s}`;
        const raw = await kvGETraw(key);
        const { count } = countAny(raw.raw);
        scan.push({ key, ymd:y, slot:s, exists: raw.exists, count });
      }
    }
    // pointer za taj YMD
    const kDay = `vb:day:${y}:last`;
    const rawDay = await kvGETraw(kDay);
    const deref = await derefPointer(rawDay.raw);
    scan.push({ key: kDay, ymd:y, slot:"-", exists: rawDay.exists, pointer_target: deref.target, pointer_count: deref.count });
  }

  return res.status(200).json({
    ok: true,
    tz: TZ,
    dayCET, dayUTC,
    pointer: {
      cet_key: ptrCETkey, cet_target: ptrCET.target, cet_exists: ptrCET.exists, cet_count: ptrCET.count,
      utc_key: ptrUTCkey, utc_target: ptrUTC.target, utc_exists: ptrUTC.exists, utc_count: ptrUTC.count,
    },
    scan
  });
}
