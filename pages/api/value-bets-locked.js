// FILE: pages/api/value-bets-locked.js
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
    if (!items.length) {
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

    // Enrich "Zašto" iz vb:insight:<fixture_id>
    const out = [];
    for (const p of items) {
      const fid = p?.fixture_id;
      let explain = p?.explain || {};
      if (fid) {
        const ins = await kvGetJSON(`vb:insight:${fid}`);
        const line = ins?.line;
        if (line) {
          // ne menjamo UI; samo obogatimo summary ako nije već tekstualan
          if (!explain.summary || /Model .* vs .* EV /.test(explain.summary)) {
            explain = { ...explain, summary: line };
          }
        }
      }
      out.push({ ...p, explain });
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
