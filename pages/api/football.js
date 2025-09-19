// pages/api/football.js
import { arrFromAny, toJson } from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

/* KV */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}
async function kvGetItems(key) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      const res = j && ("result" in j ? j.result : j);
      const obj = toJson(res);
      const items = arrFromAny(obj);
      if (!r.ok) continue;
      return { items, obj, flavor: b.flavor, kvResult: res };
    } catch {}
  }
  return { items: [], obj: null, flavor: null, kvResult: null };
}

/* Helpers */
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour: "2-digit" }).format(d));
const now = () => new Date();
const isUEFA = (name = "") => /UEFA|Champions\s*League|Europa|Conference/i.test(name);
const confidence = (it) => (Number.isFinite(it?.confidence_pct) ? it.confidence_pct : Number(it?.confidence) || 0);

/* Caps / tier env */
function intEnv(v, d, lo = 0, hi = 999) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
}
function numEnv(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function safeRegex(s) {
  try {
    return new RegExp(s, "i");
  } catch {
    return /$a^/;
  }
}

const TIER1_RE = safeRegex(process.env.TIER1_RE || "(Premier League|La Liga|Serie A|Bundesliga|Ligue 1|Champions League|UEFA\\s*Champ)");
const TIER2_RE = safeRegex(process.env.TIER2_RE || "(Championship|Eredivisie|Primeira|Liga Portugal|Super Lig|Pro League|Bundesliga 2|Serie B|LaLiga 2|Ligue 2|Eerste Divisie)");
const TIER1_CAP = intEnv(process.env.TIER1_CAP, 7, 0, 15);
const TIER2_CAP = intEnv(process.env.TIER2_CAP, 5, 0, 15);
const TIER3_CAP = intEnv(process.env.TIER3_CAP, 3, 0, 15);

const MAX_PER_LEAGUE = intEnv(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10);
const UEFA_DAILY_CAP = intEnv(process.env.UEFA_DAILY_CAP, 6, 1, 20);

/* Tier scoring */
function tierScore(leagueName = "") {
  if (TIER1_RE.test(leagueName)) return 3;
  if (TIER2_RE.test(leagueName)) return 2;
  return 1;
}

export default async function handler(req, res) {
  try {
    const d = now();
    const ymd = ymdInTZ(d, TZ);
    const h = hourInTZ(d, TZ);
    const slot = h < 10 ? "late" : h < 15 ? "am" : "pm";

    const wantDebug = String(req.query?.debug || "") === "1";

    const fullKey = `vbl_full:${ymd}:${slot}`;
    const full = await kvGetItems(fullKey);

    let items = full.items;
    let chosenFlavor = items.length ? full.flavor : null;
    let chosenResult = items.length ? full.kvResult : undefined;
    let debugFlavor = full.flavor;
    let debugResult = full.kvResult;

    if (!items.length) {
      const fallbacks = [`vb:day:${ymd}:${slot}`, `vb:day:${ymd}:union`, `vb:day:${ymd}:last`];
      for (const key of fallbacks) {
        const attempt = await kvGetItems(key);
        if (!debugFlavor && attempt.flavor) debugFlavor = attempt.flavor;
        if (debugResult === undefined && attempt.kvResult !== undefined) debugResult = attempt.kvResult;
        if (attempt.items.length) {
          items = attempt.items;
          chosenFlavor = attempt.flavor;
          chosenResult = attempt.kvResult;
          break;
        }
      }
    }

    const resolvedFlavor = chosenFlavor || debugFlavor || "unknown";
    const resolvedResult = chosenResult !== undefined ? chosenResult : debugResult;

    const countsByLeague = new Map();
    let uefaCnt = 0;
    const picked = [];

    for (const it of items.sort((a, b) => {
      const la = String(a?.league?.name || "");
      const lb = String(b?.league?.name || "");
      const ta = tierScore(la);
      const tb = tierScore(lb);
      if (tb !== ta) return tb - ta;
      return confidence(b) - confidence(a);
    })) {
      const league = String(it?.league?.name || "");
      const key = (it?.league?.id ?? league).toString().toLowerCase();

      if (isUEFA(league)) {
        if (uefaCnt >= UEFA_DAILY_CAP) continue;
      } else {
        const cur = countsByLeague.get(key) || 0;
        if (cur >= MAX_PER_LEAGUE) continue;
      }

      picked.push(it);
      if (isUEFA(league)) uefaCnt++;
      else countsByLeague.set(key, (countsByLeague.get(key) || 0) + 1);
      if (picked.length >= TIER1_CAP + TIER2_CAP + TIER3_CAP) break;
    }

    const payload = {
      ok: true,
      ymd,
      slot,
      items: picked.slice(0, 15),
    };

    if (wantDebug) {
      payload.debug = {
        sourceFlavor: resolvedFlavor,
        kvObject: typeof resolvedResult === "object",
      };
    }

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
