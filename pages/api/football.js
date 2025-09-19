// pages/api/football.js
export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

/* KV */
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
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const payload = j?.result ?? j?.value;
      let raw = null;
      const fromObject = payload && typeof payload === "object";
      if (typeof payload === "string") {
        raw = payload;
      } else if (payload !== undefined) {
        try { raw = JSON.stringify(payload ?? null); } catch { raw = null; }
      }
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit: typeof raw === "string", kvObject: fromObject });
      if (!r.ok) continue;
      return { raw: typeof raw === "string" ? raw : null, flavor:b.flavor, kvObject: fromObject };
    } catch (e) {
      trace && trace.push({ get:key, ok:false, err:String(e?.message||e) });
    }
  }
  return { raw:null, flavor:null, kvObject:null };
}
function recordMeta(store, key, info) {
  if (!store) return;
  store[key] = {
    flavor: info?.flavor ?? null,
    kvObject: info?.kvObject ?? null,
  };
}
const J = s => { try { return JSON.parse(s); } catch { return null; } };

/* Helpers */
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour:"2-digit" }).format(d));
const now = () => new Date();
const isUEFA = (name="") => /UEFA|Champions\s*League|Europa|Conference/i.test(name);
const confidence = it => Number.isFinite(it?.confidence_pct) ? it.confidence_pct : (Number(it?.confidence)||0);

/* Caps / tier env (mogu se podešavati ENV-om, postoje safe default-i) */
function intEnv(v, d, lo=0, hi=999) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }
function numEnv(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function safeRegex(s) { try { return new RegExp(s, "i"); } catch { return /$a^/; } }

const TIER1_RE  = safeRegex(process.env.TIER1_RE || "(Premier League|La Liga|Serie A|Bundesliga|Ligue 1|Champions League|UEFA\\s*Champ)");
const TIER2_RE  = safeRegex(process.env.TIER2_RE || "(Championship|Eredivisie|Primeira|Liga Portugal|Super Lig|Pro League|Bundesliga 2|Serie B|LaLiga 2|Ligue 2|Eerste Divisie)");
const TIER1_CAP = intEnv(process.env.TIER1_CAP, 7, 0, 15);
const TIER2_CAP = intEnv(process.env.TIER2_CAP, 5, 0, 15);
const TIER3_CAP = intEnv(process.env.TIER3_CAP, 3, 0, 15);

const MAX_PER_LEAGUE = intEnv(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10);
const UEFA_DAILY_CAP = intEnv(process.env.UEFA_DAILY_CAP, 6, 1, 20);

/* Tier scoring */
function tierScore(leagueName="") {
  if (TIER1_RE.test(leagueName)) return 3;
  if (TIER2_RE.test(leagueName)) return 2;
  return 1;
}

export default async function handler(req, res) {
  try {
    const debugRequested = req.query.debug === "1";
    const trace = debugRequested ? [] : null;
    const kvMeta = debugRequested ? {} : null;
    const d = now();
    const ymd = ymdInTZ(d, TZ);
    const h = hourInTZ(d, TZ);
    const slot = h<10 ? "late" : h<15 ? "am" : "pm";

    // Try locked full for slot
    const primaryKey = `vbl_full:${ymd}:${slot}`;
    const primaryRes = await kvGETraw(primaryKey, trace);
    recordMeta(kvMeta, primaryKey, primaryRes);
    let items = J(primaryRes.raw) || [];

    // Fallback: uzmi vb:day:<ymd>:<slot> / union / last (bez poziva frontu)
    if (!items.length) {
      const fallbackKeys = [
        `vb:day:${ymd}:${slot}`,
        `vb:day:${ymd}:union`,
        `vb:day:${ymd}:last`,
      ];
      const [fall1, fall2, fall3] = await Promise.all(
        fallbackKeys.map(async (key) => {
          const resGet = await kvGETraw(key, trace);
          recordMeta(kvMeta, key, resGet);
          return J(resGet.raw) || [];
        })
      );
      items = fall1.length ? fall1 : (fall2.length ? fall2 : fall3);
    }

    // Sort po tier pa confidence, uz cap per league, UEFA do 6 ukupno
    const countsByLeague = new Map();
    let uefaCnt = 0;
    const picked = [];

    for (const it of items.sort((a,b)=>{
      const la = String(a?.league?.name||"");
      const lb = String(b?.league?.name||"");
      const ta = tierScore(la), tb = tierScore(lb);
      if (tb!==ta) return tb-ta;
      return (confidence(b)-confidence(a));
    })) {
      const league = String(it?.league?.name||"");
      const key = (it?.league?.id ?? league).toString().toLowerCase();

      // UEFA globalni dnevni cap (preko svih UEFA takmičenja)
      if (isUEFA(league)) {
        if (uefaCnt >= UEFA_DAILY_CAP) continue;
      } else {
        const cur = countsByLeague.get(key) || 0;
        if (cur >= MAX_PER_LEAGUE) continue;
      }

      picked.push(it);
      if (isUEFA(league)) uefaCnt++;
      else countsByLeague.set(key, (countsByLeague.get(key)||0)+1);
      if (picked.length >= 15) break;
    }

    const response = { ok:true, ymd, slot, items: picked.slice(0,15) };
    if (debugRequested) {
      const sourceFlavor = {};
      const kvObject = {};
      for (const [key, info] of Object.entries(kvMeta || {})) {
        sourceFlavor[key] = info?.flavor ?? null;
        kvObject[key] = info?.kvObject ?? null;
      }
      response.debug = { trace: trace || [], sourceFlavor, kvObject };
    }

    return res.status(200).json(response);
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
