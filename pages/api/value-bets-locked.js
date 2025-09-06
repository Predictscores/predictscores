// pages/api/value-bets-locked.js
// Feed za Combined & Football (Kick-Off / Confidence)
// 1) Primarno: vbl_full:<YMD>:<slot> / vbl:<YMD>:<slot>
// 2) Fallback:  vb:day:<YMD>:(slot|last|union)
// 3) Auto-warm: ako je sve prazno, pozovi /api/cron/rebuild?slot=… pa ponovi čitanje
export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ----------------------------- KV helpers ------------------------------ */
function pickKvEnv() {
  const aUrl = process.env.KV_REST_API_URL;
  const aTok = process.env.KV_REST_API_TOKEN;
  const bUrl = process.env.UPSTASH_REDIS_REST_URL;
  const bTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aUrl && aTok) return { url: aUrl, token: aTok, flavor: "kv" };
  if (bUrl && bTok) return { url: bUrl, token: bTok, flavor: "upstash" };
  return null;
}

async function kvGETraw(key) {
  const env = pickKvEnv();
  if (!env) return null;
  const u = `${env.url.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`;
  const r = await fetch(u, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.token}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null; // Upstash shape
}

function toObj(raw) { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
function arrFromAny(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.items)) return x.items;
  if (Array.isArray(x?.value_bets)) return x.value_bets;
  if (Array.isArray(x?.football)) return x.football;
  return null;
}

/* ----------------------------- time helpers ---------------------------- */
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function hourInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  return parseInt(fmt.format(d), 10);
}
function deriveSlot(h) { if (h < 12) return "am"; if (h < 18) return "pm"; return "late"; }

/* --------------------------- core load routine ------------------------- */
async function tryLoadAllKeys(ymd, slot, preferFull, attempted) {
  let base = null, picked = null;

  const locked = preferFull
    ? [`vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`]
    : [`vbl:${ymd}:${slot}`, `vbl_full:${ymd}:${slot}`];

  for (const k of locked) {
    attempted.push(k);
    const obj = toObj(await kvGETraw(k));
    const arr = arrFromAny(obj);
    if (arr && arr.length) { base = arr; picked = k; return { base, picked }; }
  }

  const alt = [`vb:day:${ymd}:${slot}`, `vb:day:${ymd}:last`, `vb:day:${ymd}:union`];
  for (const k of alt) {
    attempted.push(k);
    const obj = toObj(await kvGETraw(k));
    const arr = arrFromAny(obj);
    if (arr && arr.length) { base = arr; picked = `${k}→fallback`; return { base, picked }; }
  }

  return { base: null, picked: null };
}

function computeBaseUrl(req) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------- handler -------------------------------- */
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const q = req.query || {};
    const now = new Date();
    const ymd = (q.ymd && String(q.ymd).match(/^\d{4}-\d{2}-\d{2}$/)) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(q.slot)) ? q.slot : deriveSlot(hourInTZ(now, TZ));
    const cap = Math.max(1, Math.min(Number(q.n ?? q.limit ?? 50), 200));
    const wantDebug = String(q.debug ?? "") === "1";
    const preferFull = String(q.full ?? "") === "1";
    const allowWarm = String(q.autowarm ?? "1") !== "0"; // autowarm on by default

    const attempted = [];
    let { base, picked } = await tryLoadAllKeys(ymd, slot, preferFull, attempted);

    // Auto-warm: ako je sve prazno, okini rebuild pa probaj opet
    if ((!Array.isArray(base) || base.length === 0) && allowWarm) {
      try {
        const baseUrl = computeBaseUrl(req);
        // probaj rebuild za konkretni slot (ne dodajemo nove fajlove/rute)
        await fetch(`${baseUrl}/api/cron/rebuild?slot=${slot}`, { method: "GET", cache: "no-store" }).catch(() => {});
        await sleep(1500);
        ({ base, picked } = await tryLoadAllKeys(ymd, slot, preferFull, attempted));
      } catch {
        // swallow
      }
    }

    if (!Array.isArray(base) || base.length === 0) {
      return res.status(200).json({
        ok: true,
        slot,
        ymd,
        items: [],
        football: [],
        top3: [],
        source: `vb-locked:kv:miss·${picked ? picked : 'none'}${wantDebug ? ':no-data' : ''}`,
        policy_cap: cap,
        ...(wantDebug ? { debug: { attempted } } : {}),
      });
    }

    const items = base.slice(0, cap);
    const top3 = base.slice(0, Math.min(3, cap));

    const out = {
      ok: true,
      slot,
      ymd,
      items,
      football: items, // legacy alias
      top3,
      source: `vb-locked:kv:hit·${picked}`,
      policy_cap: cap,
    };
    if (wantDebug) out.debug = { attempted };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
      items: [],
      football: [],
      top3: [],
      source: "vb-locked:error",
    });
  }
}
