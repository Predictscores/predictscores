// pages/api/history.js
// Vraća poslednje N dana History (AM/PM/LATE Top3/Top1) + agregate (7d/14d win rate, ROI).
// Za skor koristi vb:score:<fixture_id> koje puni pages/api/history-check.js.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
function parseArray(raw){
  try{ let v=raw; if (typeof v==="string") v=JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v==="object"){
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner==="string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}
function parseJSON(raw){
  try{ return (typeof raw==="string") ? JSON.parse(raw) : raw; }catch{ return null; }
}
function lastDays(n){
  const out = [];
  const now = new Date();
  for (let i=0;i<n;i++){
    const d = new Date(now);
    d.setDate(d.getDate()-i);
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

// outcome helpers
function computeWon(entry, scoreObj){
  if (!scoreObj || scoreObj.ft == null) return null;
  const [h,a] = String(scoreObj.ft).split(":").map(x=>Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const market = String(entry.market||"").toUpperCase();
  if (market === "1X2"){
    const sel = String(entry.selection||"").toUpperCase();
    const res = (h>a) ? "1" : (h===a) ? "X" : "2";
    return (res === sel);
  }
  if (market === "BTTS"){
    return (h>=1 && a>=1);
  }
  if (market === "OU" && /OVER/.test(String(entry.selection||"").toUpperCase())){
    return ((h+a) > 2);
  }
  if (market === "BTTS 1H"){
    const ht = scoreObj.ht;
    if (!ht) return null;
    const [hh,ha] = String(ht).split(":").map(x=>Number(x));
    if (!Number.isFinite(hh) || !Number.isFinite(ha)) return null;
    return (hh>=1 && ha>=1);
  }
  return null;
}

function aggregateFor(days, items){
  // filtriraj po locked_at/kickoff u poslednjih X dana
  const ymdSet = new Set(days);
  const subset = items.filter(x => {
    const ymd = (x.locked_at || x.kickoff || "").slice(0,10);
    return ymdSet.has(ymd);
  });

  let n=0, won=0, pnl=0;
  for (const it of subset){
    if (it.won === true){ won++; n++; pnl += (Number(it.odds||0) - 1); }
    else if (it.won === false){ n++; pnl -= 1; }
  }
  const win_rate = n ? Math.round((won/n)*1000)/10 : 0;
  const roi = n ? Math.round((pnl/n)*1000)/1000 : 0; // per-bet ROI (decimal odds)
  return { n, won, win_rate, roi };
}

export default async function handler(req, res){
  try{
    if (process.env.FEATURE_HISTORY !== "1") {
      return res.status(200).json({ items: [], aggregates: {}, note: "history disabled" });
    }
    const daysParam = Math.max(1, Math.min(14, Number(req.query.days || 14)));
    // prioritet: hist:index; fallback: poslednjih N dana
    let idx = parseArray(await kvGet(`hist:index`));
    if (!idx.length) idx = lastDays(daysParam);
    // skupi sve slotove po danu
    const all = [];
    for (const ymd of idx.slice(0, daysParam)){
      const am  = parseArray(await kvGet(`hist:${ymd}:am`));
      const pm  = parseArray(await kvGet(`hist:${ymd}:pm`));
      const lt  = parseArray(await kvGet(`hist:${ymd}:late`));
      for (const e of [...am, ...pm, ...lt]){
        // dopuni skorom ako postoji
        const scoreRaw = await kvGet(`vb:score:${e.fixture_id}`);
        const score = parseJSON(scoreRaw) || null;
        const won = computeWon(e, score);
        all.push({
          ...e,
          final_score: score?.ft ?? e.final_score ?? null,
          ht_score: score?.ht ?? null,
          won: (won==null) ? e.won : won
        });
      }
    }

    // sortiraj (novije prvo)
    all.sort((a,b)=>{
      const da = +(new Date(a.locked_at || a.kickoff || 0));
      const db = +(new Date(b.locked_at || b.kickoff || 0));
      return db - da;
    });

    // agregati 7d/14d
    const days7  = lastDays(7);
    const days14 = lastDays(14);
    const aggregates = {
      "7d":  aggregateFor(days7, all),
      "14d": aggregateFor(days14, all)
    };

    return res.status(200).json({ items: all, aggregates });
  } catch (e){
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
