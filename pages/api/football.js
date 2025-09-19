// pages/api/football.js
import { arrFromAny, toJson } from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

/* KV */
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${KV_TOKEN}` }, cache:"no-store" });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    const payload = j?.result ?? j?.value;
    if (typeof payload === "string") return payload;
    if (payload !== undefined) {
      try { return JSON.stringify(payload ?? null); } catch { return null; }
    }
    return null;
  } catch { return null; }
}
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
    const d = now();
    const ymd = ymdInTZ(d, TZ);
    const h = hourInTZ(d, TZ);
    const slot = h<10 ? "late" : h<15 ? "am" : "pm";

    const wantDebug = String(req.query?.debug || "") === "1";
    const readMeta = wantDebug ? [] : null;

    // Try locked full for slot
    const fullKey = `vbl_full:${ymd}:${slot}`;
    const fullRaw = await kvGetRaw(fullKey);
    const fullValue = toJson(fullRaw);
    const fullArr = arrFromAny(fullValue);
    if (wantDebug) {
      const fullJsonMeta = { ...fullValue.meta };
      const fullArrayMeta = { ...fullArr.meta };
      readMeta.push({ key: fullKey, json: fullJsonMeta, array: fullArrayMeta });
    }
    let items = fullArr.array;

    // Fallback: uzmi vb:day:<ymd>:<slot> / union / last (bez poziva frontu)
    if (!items.length) {
      const keySlot = `vb:day:${ymd}:${slot}`;
      const fall1Raw = await kvGetRaw(keySlot);
      const fall1Value = toJson(fall1Raw);
      const fall1Arr = arrFromAny(fall1Value);
      if (wantDebug) {
        const fall1JsonMeta = { ...fall1Value.meta };
        const fall1ArrayMeta = { ...fall1Arr.meta };
        readMeta.push({ key: keySlot, json: fall1JsonMeta, array: fall1ArrayMeta });
      }

      const keyUnion = `vb:day:${ymd}:union`;
      const fall2Raw = await kvGetRaw(keyUnion);
      const fall2Value = toJson(fall2Raw);
      const fall2Arr = arrFromAny(fall2Value);
      if (wantDebug) {
        const fall2JsonMeta = { ...fall2Value.meta };
        const fall2ArrayMeta = { ...fall2Arr.meta };
        readMeta.push({ key: keyUnion, json: fall2JsonMeta, array: fall2ArrayMeta });
      }

      const keyLast = `vb:day:${ymd}:last`;
      const fall3Raw = await kvGetRaw(keyLast);
      const fall3Value = toJson(fall3Raw);
      const fall3Arr = arrFromAny(fall3Value);
      if (wantDebug) {
        const fall3JsonMeta = { ...fall3Value.meta };
        const fall3ArrayMeta = { ...fall3Arr.meta };
        readMeta.push({ key: keyLast, json: fall3JsonMeta, array: fall3ArrayMeta });
      }

      const fall1 = fall1Arr.array;
      const fall2 = fall2Arr.array;
      const fall3 = fall3Arr.array;
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

    return res.status(200).json({ ok:true, ymd, slot, items: picked.slice(0,15), debug: { reads: wantDebug ? readMeta : null } });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
