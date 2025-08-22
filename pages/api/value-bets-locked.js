// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), da = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  }
}
async function kvGET(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return js?.result ?? null;
}
async function kvParseArr(key) {
  try {
    const raw = await kvGET(key);
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner === "string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  } catch {}
  return [];
}
async function kvGetJSON(key) {
  try {
    const raw = await kvGET(key);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return null; }
}

function parseKOts(p){
  try{
    const s = p?.datetime_local?.starting_at?.date_time
           || p?.datetime_local?.date_time
           || p?.time?.starting_at?.date_time
           || null;
    if (!s) return Number.MAX_SAFE_INTEGER;
    const t = +new Date(String(s).replace(" ", "T"));
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  }catch{ return Number.MAX_SAFE_INTEGER; }
}

// ---------- learning helpers (overlay & evmin from KV) ----------
function normalizeMarket(p){
  const raw = String(p?.market_label || p?.market || "").toUpperCase();
  if (/BTTS/.test(raw) && /1H/.test(raw)) return "BTTS 1H";
  if (/BTTS/.test(raw)) return "BTTS";
  if (/^OU$/.test(raw) || /OVER\/UNDER|OVER\s*2\.?5|UNDER\s*2\.?5/.test(raw)) return "OU";
  if (/1X2/.test(raw)) return "1X2";
  return raw;
}
function impliedFromOdds(o){ const n = Number(o); return Number.isFinite(n) && n>0 ? 1/n : null; }
function bandOdds(o){
  const n = Number(o);
  if (!Number.isFinite(n)) return "UNK";
  if (n < 1.8) return "1.50-1.79";
  if (n < 2.2) return "1.80-2.19";
  if (n < 3.0) return "2.20-2.99";
  return "3.00+";
}
function bandTTKO(mins){
  if (!Number.isFinite(mins)) return "UNK";
  if (mins <= 180) return "≤3h";
  if (mins <= 1440) return "≤24h";
  return ">24h";
}
function minutesToKO(p){
  try {
    const ts = parseKOts(p); 
    if (!Number.isFinite(ts)) return null;
    const diffMin = Math.round((ts - Date.now())/60000);
    return diffMin;
  } catch { return null; }
}
function bucketKeyFor(p){
  const market = normalizeMarket(p);
  const odds = Number(p?.market_odds || p?.odds || 0) || null;
  const ttko = minutesToKO(p);
  return `${market}|${bandOdds(odds)}|${bandTTKO(ttko)}`;
}
function readOverlayDelta(overlay, key){
  if (!overlay || typeof overlay !== "object") return 0;
  if (Object.prototype.hasOwnProperty.call(overlay, key) && typeof overlay[key] === "number") return overlay[key];
  // fallback: average across same market + odds band (ignore TTKO band)
  const [m, ob] = String(key).split("|");
  let sum = 0, n = 0;
  for (const k in overlay){
    if (k.startsWith(`${m}|${ob}|`)){
      const v = overlay[k];
      if (typeof v === "number"){ sum += v; n++; }
    }
  }
  return n ? (sum / n) : 0;
}
function readEvMin(evmin, key){
  if (!evmin || typeof evmin !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(evmin, key) && typeof evmin[key] === "number") return evmin[key];
  const [m, ob] = String(key).split("|");
  let sum = 0, n = 0;
  for (const k in evmin){
    if (k.startsWith(`${m}|${ob}|`)){
      const v = evmin[k];
      if (typeof v === "number"){ sum += v; n++; }
    }
  }
  return n ? (sum / n) : null;
}
// compose 2-line bullets: "Zašto: ..." and "Forma… • H2H… GD …"
function buildTwoLineExplain(ins, fallbackSummary){
  let zasto = null, formaLine = null;
  const bullets = Array.isArray(ins?.bullets) ? ins.bullets : [];
  const plain = bullets.map(b => String(b).replace(/<[^>]+>/g,"").trim());
  const bForma = plain.find(x => /^Forma:/i.test(x)) || null;
  const bH2H  = plain.find(x => /^H2H/i.test(x)) || null;
  if (ins?.line){
    zasto = `Zašto: ${ins.line.replace(/<[^>]+>/g,"").trim()}`;
  } else if (fallbackSummary){
    zasto = `Zašto: ${String(fallbackSummary).replace(/<[^>]+>/g,"").trim()}`;
  }
  if (bForma || bH2H){
    const h2hs = bH2H ? bH2H.replace(/\s*\(L5\)\s*/i,"").replace(/^H2H\s*:?\s*/i,"H2H:").replace(/\s+/g," ").trim() : null;
    const forma = bForma ? bForma.replace(/^Forma:\s*/i,"Forma:").replace(/\s+/g," ").trim() : null;
    formaLine = [forma, h2hs].filter(Boolean).join(" • ");
  }
  const out = [];
  if (zasto) out.push(zasto);
  if (formaLine) out.push(formaLine);
  return out.length ? out : null;
}

export default async function handler(req, res) {
  try {
    const day = ymdInTZ(new Date(), TZ);
    const alt = ymdInTZ(new Date(), "UTC");

    // 1) union today
    let items = await kvParseArr(`vb:day:${day}:last`);
    let source = "union";

    // 2) fallback: join slots today
    if (!items.length) {
      const am = await kvParseArr(`vb:day:${day}:am`);
      const pm = await kvParseArr(`vb:day:${day}:pm`);
      const lt = await kvParseArr(`vb:day:${day}:late`);
      items = [...am, ...pm, ...lt];
      source = "slots-joined";
    }

    // 3) fallback: union UTC day
    if (!items.length && alt !== day) {
      items = await kvParseArr(`vb:day:${alt}:last`);
      source = "union-utc";
      if (!items.length) {
        const am = await kvParseArr(`vb:day:${alt}:am`);
        const pm = await kvParseArr(`vb:day:${alt}:pm`);
        const lt = await kvParseArr(`vb:day:${alt}:late`);
        items = [...am, ...pm, ...lt];
        source = "slots-joined-utc";
      }
    }

    // Learning overlay + insights → 2 reda ("Zašto" i "Forma/H2H")
    const overlay = await kvGetJSON("learn:overlay:v1");
    const evmin   = await kvGetJSON("learn:evmin:v1");

    const out = [];
    for (const p of items) {
      const p2 = { ...p };
      const fid = p2?.fixture_id || p2?.id || null;

      // apply learning overlay to confidence (±3)
      const key = bucketKeyFor(p2);
      const delta = Math.round(readOverlayDelta(overlay, key));
      if (Number.isFinite(p2.confidence_pct)) {
        let c = Number(p2.confidence_pct) + delta;
        if (c < 35) c = 35;
        if (c > 90) c = 90;
        p2.confidence_pct = c;
      }

      // optional EV-min filter per bucket
      let keep = true;
      const minEv = readEvMin(evmin, key);
      if (minEv != null) {
        const model = Number(p2.model_prob);
        const implied = Number.isFinite(p2.implied_prob) ? Number(p2.implied_prob) : impliedFromOdds(p2.market_odds);
        const evGap = (Number.isFinite(model) && Number.isFinite(implied)) ? (model - implied) : Number(p2.ev);
        if (Number.isFinite(evGap)) keep = (evGap >= Number(minEv));
      }
      if (!keep) continue;

      // "Zašto" bullets: 2 linije max
      let explain = p2?.explain || {};
      if (fid) {
        const ins = await kvGetJSON(`vb:insight:${fid}`);
        if (ins) {
          const two = buildTwoLineExplain(ins, explain.summary);
          if (two && two.length) {
            explain = { ...explain, bullets: two };
          } else if (ins.line) {
            if (!explain.summary || /Model .* vs .* EV /.test(explain.summary)) {
              explain = { ...explain, summary: String(ins.line) };
            }
          }
        }
      }
      out.push({ ...p2, explain });
    }

    // stabilno sortiranje (po kickoff, a onda po confidence/EV ako je potrebno)
    out.sort((a,b)=>{
      const ta = parseKOts(a), tb = parseKOts(b);
      if (ta !== tb) return ta - tb;
      const ca = Number(a?.confidence_pct||0), cb = Number(b?.confidence_pct||0);
      if (cb!==ca) return cb - ca;
      const ea = Number(a?.ev||0), eb = Number(b?.ev||0);
      return eb - ea;
    });

    return res.status(200).json({
      value_bets: out,
      built_at: new Date().toISOString(),
      day,
      source
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
