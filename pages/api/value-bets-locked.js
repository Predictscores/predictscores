// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{ headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit:!!raw });
      if (!r.ok) continue;
      return { raw, flavor:b.flavor };
    } catch (e) {
      trace && trace.push({ get:key, ok:false, err:String(e?.message||e) });
    }
  }
  return { raw:null, flavor:null };
}
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }
function targetYmdForSlot(now, slot, tz){
  const h=hourInTZ(now,tz);
  if (slot==="late") return ymdInTZ(h<10?now:addDays(now,1), tz);
  if (slot==="am")   return ymdInTZ(h<15?now:addDays(now,1), tz);
  if (slot==="pm")   return ymdInTZ(h<15?now:addDays(now,1), tz);
  return ymdInTZ(now, tz);
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();

    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;
    const ymd   = targetYmdForSlot(now, slot, TZ);

    // Football list (za kartice)
    // prioritet: vbl_full → vbl → vb:day:<slot> → vb:day:union
    const poolKeys = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`
    ];
    let items=null, source=null;
    for (const k of poolKeys) {
      const { raw } = await kvGETraw(k, trace);
      const j = J(raw);
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.items)? j.items : []);
      if (arr.length){ items=arr; source=k; break; }
    }

    // Tiketi (strogo zamrznuti)
    const { raw:rawT } = await kvGETraw(`tickets:${ymd}:${slot}`, trace);
    const tickets = J(rawT) || null;

    // Ne pokušavamo gradnju tiketa ovde (insights-build to radi i zamrzava)
    return res.status(200).json({
      ok:true, ymd, slot,
      source, items: Array.isArray(items)? items : [],
      tickets: tickets || { btts:[], ou25:[], htft:[], fh_ou15:[] },
      debug: { trace }
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
