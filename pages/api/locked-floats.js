// pages/api/locked-floats.js
// KV-only: warms/maintains today's UNION strictly from snapshot/legacy/previous UNION.
// ZERO external API calls. No tickets/odds here.

export const config = { api: { bodyParser: false } };

/* ---------- TZ ---------- */
const TZ = (() => {
  try { const z = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim(); new Intl.DateTimeFormat("en-CA",{timeZone:z}); return z; }
  catch { return "Europe/Belgrade"; }
})();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

/* ---------- KV (Vercel KV + Upstash fallback) ---------- */
const KV_URL = process.env.KV_REST_API_URL ? String(process.env.KV_REST_API_URL).replace(/\/+$/,"") : "";
const KV_TOK = process.env.KV_REST_API_TOKEN || "";
const hasKV  = Boolean(KV_URL && KV_TOK);

const R_URL  = process.env.UPSTASH_REDIS_REST_URL ? String(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/,"") : "";
const R_TOK  = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const hasR   = Boolean(R_URL && R_TOK);

const J = s => { try { return JSON.parse(String(s ?? "")); } catch { return null; } };

async function kvGetREST(k){ if(!hasKV) return null; const r=await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${KV_TOK}`},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return typeof j?.result==="string"?j.result:null; }
async function kvSetREST(k,v){ if(!hasKV) return false; const r=await fetch(`${KV_URL}/set/${encodeURIComponent(k)}`,{method:"POST",headers:{Authorization:`Bearer ${KV_TOK}`,"Content-Type":"application/json"},body:typeof v==="string"?v:JSON.stringify(v)}); return r.ok; }
async function kvGetUp(k){ if(!hasR) return null; const r=await fetch(`${R_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${R_TOK}`},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return typeof j?.result==="string"?j.result:null; }
async function kvSetUp(k,v){ if(!hasR) return false; const r=await fetch(`${R_URL}/set/${encodeURIComponent(k)}`,{method:"POST",headers:{Authorization:`Bearer ${R_TOK}`,"Content-Type":"application/json"},body:typeof v==="string"?v:JSON.stringify(v)}); return r.ok; }
const kvGetAny = (k)=>kvGetREST(k).then(v=>v!=null?v:kvGetUp(k));
const kvSetBoth = (k,v)=>Promise.all([kvSetREST(k,v),kvSetUp(k,v)]).then(([a,b])=>a||b);

/* ---------- helpers ---------- */
const idsFrom = raw => {
  const v = typeof raw==="string" ? (J(raw)??raw) : raw;
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (Array.isArray(v.items)) return v.items.filter(Boolean);
  return [];
};
const rowsFrom = raw => {
  const v = typeof raw==="string" ? (J(raw)??raw) : raw;
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.items)) return v.items;
  return [];
};
const fxId = r => r?.id ?? r?.fixture_id ?? r?.fixture?.id ?? null;

/* ---------- handler ---------- */
export default async function handler(req,res){
  try{
    if(!hasKV && !hasR) return res.status(200).json({ok:false,error:"No KV configured."});

    const today = String(req.query.ymd || ymdInTZ(new Date(), TZ));
    const warm  = String(req.query.warm || "") === "1";
    if(!warm) return res.status(200).json({ ok:true, note:"locked-floats KV-only" });

    const unionKey = `vb:day:${today}:union`;

    // 1) Use existing UNION if present
    const existing = await kvGetAny(unionKey);
    let union = idsFrom(existing);

    // 2) Else derive UNION from snapshot/index (KV only)
    if (!union.length) {
      const idxKey = `vb:day:${today}:snapshot:index`;
      const legKey = `vb:day:${today}:snapshot`;
      const idxRaw = await kvGetAny(idxKey);
      const idx = typeof idxRaw==="string" ? (J(idxRaw)??idxRaw) : idxRaw;

      let rows = [];
      if (Array.isArray(idx) && idx.length && typeof idx[0]==="object") rows = idx;
      else if (idx && typeof idx==="object" && Array.isArray(idx.items)) rows = idx.items;
      else {
        let chunkKeys = [];
        if (typeof idx==="string" && idx!==idxKey) chunkKeys=[idx];
        else if (idx && Array.isArray(idx.chunks)) chunkKeys = idx.chunks.filter(Boolean);
        else if (Array.isArray(idx) && idx.length && typeof idx[0]==="string") chunkKeys = idx.filter(Boolean);
        for (const ck of chunkKeys) {
          const cRaw = await kvGetAny(ck);
          rows.push(...rowsFrom(cRaw));
        }
        if (!rows.length) {
          const legRaw = await kvGetAny(legKey);
          rows = rowsFrom(legRaw);
        }
      }
      union = Array.from(new Set(rows.map(fxId).filter(Boolean)));
      if (union.length) await kvSetBoth(unionKey, union);
    }

    const ts = new Date().toISOString();
    return res.status(200).json({
      ok:true,
      warm:{ union_count: union.length, tickets_created:false, tickets_counts:{btts:0,ou25:0,htft:0}, budget_exhausted:false },
      ymd: today,
      ts
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
