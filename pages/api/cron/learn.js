// pages/api/cron/learn.js
export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

// ---------- KV helpers
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  try { const js = await r.json(); return js?.result ?? null; } catch { return null; }
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}
function toArray(raw){
  try{
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object"){
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v){ const inner=v.value; if (typeof inner==="string") return JSON.parse(inner); if (Array.isArray(inner)) return inner; }
    }
  }catch{}
  return [];
}
function toJSON(raw){ try{ return typeof raw==="string" ? JSON.parse(raw) : raw; }catch{ return null; } }
function lastDays(n){
  const out=[], now=new Date();
  for (let i=0;i<n;i++){ const d=new Date(now); d.setDate(d.getDate()-i); out.push(d.toISOString().slice(0,10)); }
  return out;
}
function parseKickoff(iso){ if (!iso) return null; const d=new Date(iso); return Number.isFinite(+d)? d:null; }
function minutesDiff(a,b){ return Math.round((a.getTime()-b.getTime())/60000); }

// --- won from score + market/selection
function computeWon(entry, score){
  if (!score) return null;

  const ftStr =
    (typeof score.ft === "string" ? score.ft : null) ??
    (Number.isFinite(score.ftH) && Number.isFinite(score.ftA) ? `${score.ftH}:${score.ftA}` : null);
  if (!ftStr) return null;

  const [h,a] = String(ftStr).split(":").map(Number);
  if (!Number.isFinite(h)||!Number.isFinite(a)) return null;

  const m = String(entry?.market||"").toUpperCase();
  const s = String(entry?.selection||"").toUpperCase();

  if (m==="1X2"){ const r=(h>a)?"1":(h===a)?"X":"2"; return r===s; }
  if (m==="BTTS"){ return (h>=1 && a>=1); }
  if (m==="OU"){
    if (/OVER/.test(s)) return (h+a)>2;
    if (/UNDER/.test(s)) return (h+a)<3;
    return null;
  }
  if (m==="BTTS 1H"){
    const htStr =
      (typeof score?.ht === "string" ? score.ht : null) ??
      (Number.isFinite(score?.htH)&&Number.isFinite(score?.htA) ? `${score.htH}:${score.htA}` : null);
    if (!htStr) return null;
    const [hh,ha]=htStr.split(":").map(Number);
    if (!Number.isFinite(hh)||!Number.isFinite(ha)) return null;
    return (hh>=1 && ha>=1);
  }
  return null;
}

// --- bucketing
function bandOdds(o){
  if (!Number.isFinite(o)) return "UNK";
  if (o<1.8) return "1.50-1.79";
  if (o<2.2) return "1.80-2.19";
  if (o<3.0) return "2.20-2.99";
  return "3.00+";
}
function bandTTKO(mins){
  if (!Number.isFinite(mins)) return "UNK";
  if (mins<=180) return "≤3h";
  if (mins<=1440) return "≤24h";
  return ">24h";
}
function bucketKey(market, odds, ttko){
  return `${String(market||"").toUpperCase()}|${bandOdds(odds)}|${bandTTKO(ttko)}`;
}

export default async function handler(req,res){
  try{
    const days = Math.max(1, Math.min(14, Number(req.query.days || 14)));
    const idxRaw = await kvGet(`hist:index`);
    const idx = toArray(idxRaw);
    const ymds = idx.length ? idx.slice(0, days) : lastDays(days);

    const items=[];
    for (const ymd of ymds){
      for (const slot of ["am","pm","late"]){
        const arr = toArray(await kvGet(`hist:${ymd}:${slot}`));
        for (const e of arr){
          const fid = e?.fixture_id; if (!fid) continue;
          const score = toJSON(await kvGet(`vb:score:${fid}`)) || null;
          const close = toJSON(await kvGet(`vb:close:${fid}`)) || null;
          const won = computeWon(e, score);
          const oddsOpen = Number(e?.odds || e?.market_odds || 0) || null;
          const oddsClose = Number(close?.trusted_median_close||0) || null;

          const ko = parseKickoff(e?.kickoff);
          const lockedAt = e?.locked_at ? new Date(e.locked_at) : null;
          const ttko = (ko && lockedAt) ? minutesDiff(ko, lockedAt) : null;

          items.push({
            market: e?.market || null,
            oddsOpen, oddsClose,
            ttko,
            won
          });
        }
      }
    }

    // agregacija po bucketu
    const buckets = new Map();
    for (const it of items){
      const key = bucketKey(it.market, it.oddsOpen, it.ttko);
      const b = buckets.get(key) || { n:0, won:0, pnl:0, clvSum:0, clvN:0 };
      b.n++;
      if (it.won===true){ b.won++; b.pnl += (it.oddsOpen-1); }
      else if (it.won===false){ b.pnl -= 1; }
      const clvPct = (Number.isFinite(it.oddsOpen) && Number.isFinite(it.oddsClose) && it.oddsOpen>0 && it.oddsClose>0)
        ? ((it.oddsClose - it.oddsOpen) / it.oddsOpen) * 100
        : null;
      if (Number.isFinite(clvPct)){ b.clvSum += clvPct; b.clvN++; }
      buckets.set(key,b);
    }

    // overlay i ev prag po bucketu
    const overlay = {};
    const evmin = {};
    const bucketN = {};
    const clvavg  = {};
    for (const [key,b] of buckets){
      const winRate = b.n ? b.won/b.n : 0;
      const roi = b.n ? b.pnl/b.n : 0;
      const clv = b.clvN ? b.clvSum/b.clvN : 0;

      let delta = 0;
      let evReq = 0; // EV >= 0 default

      if (clv > 0.5 && roi >= -0.01) delta = +1;
      if (roi < -0.05 || clv < -0.5) delta = -2;
      if (roi < -0.10) delta = -3;

      if (roi < -0.05) evReq = 0.05;
      else if (clv > 0.8 && roi >= -0.01) evReq = -0.02;

      if (delta > 3) delta = 3;
      if (delta < -3) delta = -3;

      overlay[key] = delta;
      evmin[key]   = evReq;
      bucketN[key] = b.n;
      clvavg[key]  = b.clvN ? +(clv.toFixed(2)) : null;
    }

    const today = new Intl.DateTimeFormat("sv-SE",{ timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
    await kvSet(`learn:overlay:v1`, overlay);
    await kvSet(`learn:evmin:v1`, evmin);
    await kvSet(`learn:bucketN:v1`, bucketN);
    await kvSet(`learn:clvavg:v1`, clvavg);
    // aliases for legacy readers
    await kvSet(`vb:learn:weights`, { global: 0, markets: overlay });
    await kvSet(`vb:learn:evmin`, evmin);

    await kvSet(`learn:report:${today}`, {
      daysUsed: ymds,
      buckets: Array.from(buckets.entries()).map(([k,b])=>({
        key:k, n:b.n, win_rate: +(b.won/(b.n||1)).toFixed(3),
        roi: +((b.pnl/(b.n||1))).toFixed(3),
        clv_avg: b.clvN ? +(b.clvSum/b.clvN).toFixed(2) : null,
        overlay: overlay[k], evmin: evmin[k]
      }))
    });

    return res.status(200).json({ ok:true, buckets: Object.keys(overlay).length });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
