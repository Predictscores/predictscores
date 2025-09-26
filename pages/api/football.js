// pages/api/football.js
import { arrFromAny, toJson } from "../../lib/kv-read";
import { storeTierMetrics } from "../../lib/kv-meta";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

/* KV */
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN;
async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const payload = j?.result ?? j?.value;
    if (typeof payload === "string") return payload;
    if (payload !== undefined) {
      try {
        return JSON.stringify(payload ?? null);
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
/* Helpers */
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour:"2-digit" }).format(d));
const now = () => new Date();
const isUEFA = (name = "") => /UEFA|Champions\s*League|Europa|Conference/i.test(name);
const confidence = (it) =>
  Number.isFinite(it?.confidence_pct) ? it.confidence_pct : Number(it?.confidence) || 0;

/* Caps / tier env (mogu se podešavati ENV-om, postoje safe default-i) */
function intEnv(v, d, lo=0, hi=999) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }
function numEnv(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function safeRegex(s) { try { return new RegExp(s, "i"); } catch { return /$a^/; } }

const TIER1_RE = safeRegex(
  process.env.TIER1_RE ||
    "(Premier League|La Liga|Serie A|Bundesliga|Ligue 1|Champions League|UEFA\\s*Champ)"
);
const TIER2_RE = safeRegex(
  process.env.TIER2_RE ||
    "(Championship|Eredivisie|Primeira|Liga Portugal|Super Lig|Pro League|Bundesliga 2|Serie B|LaLiga 2|Ligue 2|Eerste Divisie)"
);
const TIER1_CAP = intEnv(process.env.TIER1_CAP, 7, 0, 15);
const TIER2_CAP = intEnv(process.env.TIER2_CAP, 5, 0, 15);
const TIER3_CAP = intEnv(process.env.TIER3_CAP, 3, 0, 15);

const MAX_PER_LEAGUE = intEnv(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10);
const UEFA_DAILY_CAP = intEnv(process.env.UEFA_DAILY_CAP, 6, 1, 20);

/* Tier scoring */
const tierKey = (score) => {
  if (score >= 3) return "T1";
  if (score >= 2) return "T2";
  return "T3";
};

function tierScore(leagueName = "") {
  if (TIER1_RE.test(leagueName)) return 3;
  if (TIER2_RE.test(leagueName)) return 2;
  return 1;
}

function summarizeTierMetrics({ items = [], picks = [], excludedByPattern = {} } = {}) {
  const base = () => ({ T1: 0, T2: 0, T3: 0 });
  const candidatesByTier = base();
  const pickedByTier = base();

  for (const it of Array.isArray(items) ? items : []) {
    const league = String(it?.league?.name || "");
    const key = tierKey(tierScore(league));
    candidatesByTier[key] += 1;
  }

  for (const it of Array.isArray(picks) ? picks : []) {
    const league = String(it?.league?.name || "");
    const key = tierKey(tierScore(league));
    pickedByTier[key] += 1;
  }

  const shortfallTier1 = Math.max(0, TIER1_CAP - pickedByTier.T1);

  const normalizedExcluded = {};
  if (excludedByPattern && typeof excludedByPattern === "object") {
    for (const [pattern, count] of Object.entries(excludedByPattern)) {
      const trimmed = typeof pattern === "string" ? pattern.trim() : "";
      const num = Number(count);
      if (!trimmed || !Number.isFinite(num) || num <= 0) continue;
      normalizedExcluded[trimmed] = num;
    }
  }

  return {
    candidatesByTier,
    pickedByTier,
    shortfallTier1,
    excludedByPattern: normalizedExcluded,
    totalCandidates: candidatesByTier.T1 + candidatesByTier.T2 + candidatesByTier.T3,
    totalPicked: pickedByTier.T1 + pickedByTier.T2 + pickedByTier.T3,
  };
}

async function loadItems({ ymd, slot, wantDebug, readMeta }) {
  const fullKey = `vbl_full:${ymd}:${slot}`;
  const fullRaw = await kvGetRaw(fullKey);
  const fullValue = toJson(fullRaw);
  const fullArr = arrFromAny(fullValue);
  if (wantDebug && readMeta) {
    const fullJsonMeta = { ...fullValue.meta };
    const fullArrayMeta = { ...fullArr.meta };
    readMeta.push({ key: fullKey, json: fullJsonMeta, array: fullArrayMeta });
  }
  let items = fullArr.array;

  if (items.length) {
    return items;
  }

  const keySlot = `vb:day:${ymd}:${slot}`;
  const fall1Raw = await kvGetRaw(keySlot);
  const fall1Value = toJson(fall1Raw);
  const fall1Arr = arrFromAny(fall1Value);
  if (wantDebug && readMeta) {
    const fall1JsonMeta = { ...fall1Value.meta };
    const fall1ArrayMeta = { ...fall1Arr.meta };
    readMeta.push({ key: keySlot, json: fall1JsonMeta, array: fall1ArrayMeta });
  }

  const keyUnion = `vb:day:${ymd}:union`;
  const fall2Raw = await kvGetRaw(keyUnion);
  const fall2Value = toJson(fall2Raw);
  const fall2Arr = arrFromAny(fall2Value);
  if (wantDebug && readMeta) {
    const fall2JsonMeta = { ...fall2Value.meta };
    const fall2ArrayMeta = { ...fall2Arr.meta };
    readMeta.push({ key: keyUnion, json: fall2JsonMeta, array: fall2ArrayMeta });
  }

  const keyLast = `vb:day:${ymd}:last`;
  const fall3Raw = await kvGetRaw(keyLast);
  const fall3Value = toJson(fall3Raw);
  const fall3Arr = arrFromAny(fall3Value);
  if (wantDebug && readMeta) {
    const fall3JsonMeta = { ...fall3Value.meta };
    const fall3ArrayMeta = { ...fall3Arr.meta };
    readMeta.push({ key: keyLast, json: fall3JsonMeta, array: fall3ArrayMeta });
  }

  const fall1 = fall1Arr.array;
  const fall2 = fall2Arr.array;
  const fall3 = fall3Arr.array;
  items = fall1.length ? fall1 : fall2.length ? fall2 : fall3;
  return items;
}

function selectFinalPicks(items) {
  const countsByLeague = new Map();
  let uefaCnt = 0;
  const picked = [];

  const sorted = items.slice().sort((a, b) => {
    const la = String(a?.league?.name || "");
    const lb = String(b?.league?.name || "");
    const ta = tierScore(la);
    const tb = tierScore(lb);
    if (tb !== ta) return tb - ta;
    return confidence(b) - confidence(a);
  });

  for (const it of sorted) {
    const league = String(it?.league?.name || "");
    const key = (it?.league?.id ?? league).toString().toLowerCase();

    if (isUEFA(league)) {
      if (uefaCnt >= UEFA_DAILY_CAP) continue;
    } else {
      const cur = countsByLeague.get(key) || 0;
      if (cur >= MAX_PER_LEAGUE) continue;
    }

    picked.push(it);
    if (isUEFA(league)) {
      uefaCnt += 1;
    } else {
      countsByLeague.set(key, (countsByLeague.get(key) || 0) + 1);
    }
    if (picked.length >= 15) break;
  }

  return { picks: picked.slice(0, 15), excludedByPattern: {} };
}

function resolveSlot(slotInput, referenceDate) {
  const raw = typeof slotInput === "string" ? slotInput.toLowerCase() : "";
  if (["late", "am", "pm"].includes(raw)) return raw;
  const d = referenceDate || now();
  const h = hourInTZ(d, TZ);
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}

export async function runFootballSelector({
  ymd,
  slot,
  wantDebug = false,
  storeMetrics = true,
} = {}) {
  const current = now();
  const resolvedYmd = sanitizeKeyPart(ymdInTZ(current, TZ), ymd);
  const resolvedSlot = resolveSlot(slot, current);

  const readMeta = wantDebug ? [] : null;
  const items = await loadItems({ ymd: resolvedYmd, slot: resolvedSlot, wantDebug, readMeta });
  const { picks, excludedByPattern } = selectFinalPicks(Array.isArray(items) ? items : []);

  const summary = summarizeTierMetrics({
    items,
    picks,
    excludedByPattern,
  });

  console.info("tier-metrics:selector", {
    ymd: resolvedYmd,
    slot: resolvedSlot,
    ...summary,
  });

  if (storeMetrics) {
    try {
      await storeTierMetrics({
        ymd: resolvedYmd,
        slot: resolvedSlot,
        ...summary,
      });
    } catch (err) {
      console.warn("tier-metrics:store-failed", String(err?.message || err));
    }
  }

  return {
    ok: true,
    ymd: resolvedYmd,
    slot: resolvedSlot,
    items,
    picks,
    summary,
    reads: readMeta,
  };
}

function sanitizeKeyPart(defaultValue, override) {
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }
  return defaultValue;
}

export default async function handler(req, res) {
  try {
    const wantDebug = String(req.query?.debug || "") === "1";
    let slot = String(req.query?.slot || "auto").toLowerCase();
    if (!["late", "am", "pm"].includes(slot)) slot = null;

    const result = await runFootballSelector({
      slot,
      wantDebug,
      storeMetrics: true,
    });

    return res.status(200).json({
      ok: true,
      ymd: result.ymd,
      slot: result.slot,
      items: result.picks,
      debug: { reads: wantDebug ? result.reads : null },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
