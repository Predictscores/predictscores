// pages/api/cron/learn.js
// Uči minimalne EV pragove po bucket-ima i upisuje u `learn:evmin:v1`.
// Bucket = MARKET | OPSEG_KVOTA | TTKO_BAND  (TTKO band se popunjava za sve tri vrednosti,
// čak i kada istorija nema precizan time-to-KO; tako rebuild može odmah da koristi filter.)
//
// Ulazi (istorija):
// - Preferirano:  vb:day:<YMD>:<SLOT>           // direktna LISTA predloga (apply-learning je piše)
// - Fallback:     vbl:<YMD>:<SLOT>              // locked payload { items: [...] }
//                 vb-locked:<YMD>:<SLOT>
//                 vb:locked:<YMD>:<SLOT>
//                 locked:vbl:<YMD>:<SLOT>
//                 vbl_full:<YMD>:<SLOT>         // po potrebi (koristi .items)
//
// Parametri:
//   ?days=N              // koliko dana unazad (default 14; max 60)
//   ?q=0.4               // kvantil za EV-min (default 0.40)
//   ?minn=25             // minimalan broj uzoraka po bucket-u da bi se pisao prag (default 25)
//   ?debug=1             // vrati dijagnostiku
//
// ENV (opciono; nije obavezno):
//   LEARN_EVMIN_Q        // npr. 0.40
//   LEARN_MIN_N          // npr. 25
//   EV_FLOOR             // fallback minimalni EV (default 0.02)
//
// Napomena: Ako nema dovoljno istorije, fajl će i dalje upisati `learn:evmin:v1` (možda prazan).

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// KV/Upstash endpoints (isti kao u ostatku projekta)
const KV_URL   = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function toInt(v, d=0){ const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; }
function toNum(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }

const DEFAULT_DAYS   = 14;
const DEFAULT_Q      = clamp01(envNum("LEARN_EVMIN_Q", 0.40));
const DEFAULT_MIN_N  = Math.max(1, toInt(process.env.LEARN_MIN_N, 25));
const EV_FLOOR       = toNum(process.env.EV_FLOOR, 0.02);

// --- KV helpers ---
async function kvGetRaw(key){
  if (!KV_URL || !KV_TOKEN) return null;
  try{
    const r = await fetch(`${KV_URL.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return j?.result ?? null;
  }catch{
    return null;
  }
}
async function kvGetJSON(key){
  const v = await kvGetRaw(key);
  if (v == null) return null;
  try{
    if (typeof v === "string") return JSON.parse(v);
    return v;
  }catch{ return null; }
}
async function kvSetJSON(key, value){
  if (!KV_URL || !KV_TOKEN) throw new Error("KV env not set");
  // pokušaj JSON body (Upstash/KV kompatibilno)
  let r = await fetch(`${KV_URL.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ value })
  }).catch(()=>null);
  if (r && r.ok) return true;
  // fallback put kroz path
  const enc = encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value));
  r = await fetch(`${KV_URL.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${enc}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  }).catch(()=>null);
  if (r && r.ok) return true;
  const msg = r ? await r.text().catch(()=>String(r.status)) : "network-error";
  throw new Error(`KV set failed: ${msg.slice(0,200)}`);
}

// --- time utils ---
function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    });
    const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type]=x.value, a), {});
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function ymdMinusDays(ymd, k){
  try{
    const [Y,M,D] = ymd.split("-").map(n=>parseInt(n,10));
    const dt = new Date(Date.UTC(Y, M-1, D, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() - k);
    return ymdInTZ(dt, TZ);
  }catch{ return ymd; }
}

// --- bucketing ---
function bandOdds(o){
  if (!Number.isFinite(o)) return "UNK";
  if (o < 1.80) return "1.50-1.79";
  if (o < 2.20) return "1.80-2.19";
  if (o < 3.00) return "2.20-2.99";
  return "3.00+";
}
// pisaćemo za SVE TTKO band-ove kako bismo pokrili rebuild lookup
const TTKO_BANDS = ["≤3h","≤24h",">24h"];
function key3(market, oddsBand, ttkoBand){
  return `${String(market||"").toUpperCase()}|${oddsBand}|${ttkoBand}`;
}

// --- robust parse of "locked list" ---
function ensureArray(v){
  try{
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === "string"){
      const s = v.trim();
      if (!s) return [];
      const j = JSON.parse(s);
      return ensureArray(j);
    }
    if (typeof v === "object"){
      if (Array.isArray(v.items)) return v.items;
      if (Array.isArray(v.football)) return v.football;
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.valueBets)) return v.valueBets;
      if (Array.isArray(v.list)) return v.list;
      // Neki ključevi znaju da budu { key, alt: [...] } -> to NIJE lista
      return [];
    }
    return [];
  }catch{ return []; }
}

async function readLockedList(ymd, slot){
  // 1) prefer vb:day:<ymd>:<slot> (direktna lista)
  const a = await kvGetJSON(`vb:day:${ymd}:${slot}`);
  let arr = ensureArray(a);
  if (arr.length) return arr;

  // 2) fallback na well-known locked payload ključeve
  const keys = [
    `vbl:${ymd}:${slot}`,
    `vb-locked:${ymd}:${slot}`,
    `vb:locked:${ymd}:${slot}`,
    `locked:vbl:${ymd}:${slot}`,
    `vbl_full:${ymd}:${slot}`
  ];
  for (const k of keys){
    const v = await kvGetJSON(k);
    arr = ensureArray(v);
    if (arr.length) return arr;
  }
  return [];
}

// --- statistika po bucketu -> prag ---
function quantile(sorted, q){
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * clamp01(q);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo]*(1-t) + sorted[hi]*t;
}

export default async function handler(req, res){
  try{
    const days   = Math.min(60, Math.max(1, toInt(req.query?.days, DEFAULT_DAYS)));
    const q      = clamp01(toNum(req.query?.q, DEFAULT_Q));
    const minN   = Math.max(1, toInt(req.query?.minn, DEFAULT_MIN_N));
    const debug  = String(req.query?.debug||"") === "1";

    const today = ymdInTZ(new Date(), TZ);
    const ymdd = Array.from({length: days}, (_,i)=> ymdMinusDays(today, i));
    const slots = ["am","pm","late"];

    // Skupljamo EV vrednosti po (MARKET|ODDS_BAND), TTKO band ćemo duplirati kasnije
    const bucketEV = new Map(); // key2 = "MARKET|ODDSBAND" -> [ev, ev, ...]
    let totalScanned = 0;
    let totalLists = 0;

    for (const ymd of ymdd){
      for (const slot of slots){
        const list = await readLockedList(ymd, slot);
        if (!list.length) continue;
        totalLists++;
        for (const it of list){
          const market = String(it?.market || "").toUpperCase();
          const price  = Number(it?.odds?.price ?? it?.price ?? it?.odd ?? it?.odds);
          const ev     = Number(it?._ev ?? it?.ev ?? it?.edge ?? NaN);
          if (!market || !Number.isFinite(price) || !Number.isFinite(ev)) continue;
          const ob = bandOdds(price);
          const key2 = `${market}|${ob}`;
          if (!bucketEV.has(key2)) bucketEV.set(key2, []);
          bucketEV.get(key2).push(ev);
          totalScanned++;
        }
      }
    }

    // Računamo pragove
    const evmin = {}; // puni key3 (sa TTKO band-ovima)
    const summary = [];

    for (const [key2, arr] of bucketEV.entries()){
      const vals = arr.filter(x=>Number.isFinite(x)).sort((a,b)=>a-b);
      const n = vals.length;
      if (n < minN) {
        summary.push({ bucket:key2, n, status:"skip(minN)" });
        continue;
      }
      const qv = quantile(vals, q);
      const thr = Math.max(EV_FLOOR, Number(qv.toFixed(6)));
      // upiši isti prag za sve TTKO band-ove
      for (const tt of TTKO_BANDS){
        const k3 = `${key2}|${tt}`; // MARKET|ODDSBAND|TTKO
        evmin[k3] = thr;
      }
      summary.push({ bucket:key2, n, q, thr });
    }

    // Upis u KV
    await kvSetJSON("learn:evmin:v1", evmin);

    const resp = {
      ok: true,
      buckets: Object.keys(evmin).length,
      base_groups: bucketEV.size,
      samples: totalScanned,
      lists_scanned: totalLists,
      params: { days, q, minN, tz: TZ }
    };
    if (debug) resp.summary = summary.slice(0, 200); // ne previše
    return res.status(200).json(resp);
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
