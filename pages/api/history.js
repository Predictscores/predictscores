// FILE: pages/api/history.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  try {
    const js = await r.json();
    return js?.result ?? null;
  } catch { return null; }
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
      if ("value" in v){
        const inner = v.value;
        if (typeof inner === "string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}

// unwrap {value:"…"} i/ili string -> object
function normalizeScore(raw){
  try{
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);

    if (v && typeof v === "object" && "value" in v){
      let inner = v.value;
      if (typeof inner === "string") {
        try { inner = JSON.parse(inner); } catch { /* ignore */ }
      }
      if (inner && typeof inner === "object") return inner;
    }
    return (v && typeof v === "object") ? v : null;
  }catch{ return null; }
}

function lastDays(n){
  const out=[], now=new Date();
  for (let i=0;i<n;i++){ const d=new Date(now); d.setDate(d.getDate()-i); out.push(d.toISOString().slice(0,10)); }
  return out;
}

// --- outcome
function computeWon(entry, scoreObj){
  // scoreObj može imati ft (string "H:A") ili ftH/ftA brojeve
  if (!scoreObj) return null;

  const ftStr =
    (typeof scoreObj.ft === "string" ? scoreObj.ft : null) ??
    (Number.isFinite(scoreObj.ftH) && Number.isFinite(scoreObj.ftA)
      ? `${scoreObj.ftH}:${scoreObj.ftA}` : null);

  if (!ftStr) return null;

  const [h,a] = String(ftStr).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;

  const m = String(entry.market||"").toUpperCase();
  const s = String(entry.selection||"").toUpperCase();

  if (m === "1X2"){
    const res = (h>a) ? "1" : (h===a) ? "X" : "2";
    return res === s;
  }
  if (m === "BTTS"){
    return (h>=1 && a>=1);
  }
  if (m === "OU"){
    // pretpostavka: OU 2.5 OVER/UNDER
    if (/OVER/.test(s)) return (h+a) > 2;
    if (/UNDER/.test(s)) return (h+a) < 3;
    return null;
  }
  if (m === "BTTS 1H"){
    const htStr =
      (typeof scoreObj.ht === "string" ? scoreObj.ht : null) ??
      (Number.isFinite(scoreObj.htH) && Number.isFinite(scoreObj.htA)
        ? `${scoreObj.htH}:${scoreObj.htA}` : null);
    if (!htStr) return null;
    const [hh,ha] = String(htStr).split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(ha)) return null;
    return (hh>=1 && ha>=1);
  }
  return null;
}

export default async function handler(req,res){
  try{
    if (process.env.FEATURE_HISTORY !== "1"){
      return res.status(200).json({ items: [], aggregates: {}, note: "history disabled" });
    }
    const days = Math.max(1, Math.min(14, Number(req.query.days || 14)));

    // prioritet: indeks; fallback: poslednjih N dana
    let idxRaw = await kvGet(`hist:index`);
    let idx = toArray(idxRaw);
    if (!idx.length) idx = lastDays(days);

    const all=[];
    for (const ymd of idx.slice(0, days)){
      const am = toArray(await kvGet(`hist:${ymd}:am`));
      const pm = toArray(await kvGet(`hist:${ymd}:pm`));
      const lt = toArray(await kvGet(`hist:${ymd}:late`));

      for (const e of [...am, ...pm, ...lt]){
        const rawScore = await kvGet(`vb:score:${e?.fixture_id}`);
        const score = normalizeScore(rawScore);
        const won = computeWon(e, score);

        // final/ht score string fallback
        const final_score =
          (score && (score.ft || (Number.isFinite(score.ftH)&&Number.isFinite(score.ftA) ? `${score.ftH}:${score.ftA}` : null))) ??
          e.final_score ?? null;
        const ht_score =
          (score && (score.ht || (Number.isFinite(score.htH)&&Number.isFinite(score.htA) ? `${score.htH}:${score.htA}` : null))) ??
          e.ht_score ?? null;

        all.push({
          ...e,
          final_score,
          ht_score,
          won: (won==null) ? (e.won ?? null) : won
        });
      }
    }

    // sort: najnovije prvo
    all.sort((a,b)=>{
      const da = +(new Date(a.locked_at || a.kickoff || 0));
      const db = +(new Date(b.locked_at || b.kickoff || 0));
      return db - da;
    });

    // agregati
    function agg(range){
      const set = new Set(range);
      const subset = all.filter(x => set.has((x.locked_at || x.kickoff || "").slice(0,10)));
      let n=0, won=0, pnl=0;
      for (const it of subset){
        if (it.won === true){ won++; n++; pnl += (Number(it.odds||0) - 1); }
        else if (it.won === false){ n++; pnl -= 1; }
      }
      const win_rate = n ? Math.round((won/n)*1000)/10 : 0;
      const roi = n ? Math.round((pnl/n)*1000)/1000 : 0;
      return { n, won, win_rate, roi };
    }
    const d7  = lastDays(7), d14 = lastDays(14);
    const aggregates = { "7d": agg(d7), "14d": agg(d14) };

    return res.status(200).json({ items: all, aggregates });
  }catch(e){
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
