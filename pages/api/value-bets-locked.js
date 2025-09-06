// pages/api/value-bets-locked.js

/**
 * Value-bets "locked" feed for Combined & Football (Kick-Off / Confidence).
 * Primary keys (preferred):
 *   - vbl_full:<YMD>:<slot>
 *   - vbl:<YMD>:<slot>
 * Fallback (added here, safe, non-breaking):
 *   - vb:day:<YMD>:<slot>
 *   - vb:day:<YMD>:last
 *   - vb:day:<YMD>:union
 *
 * This file does NOT add routes or new files and does NOT change response shape.
 * It only fills data when vbl* keys are missing, so History remains untouched.
 */

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
  // Upstash returns 200 with { result: "..."} even for missing keys (null)
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j) return null;
  // Common Upstash shape: { result: string|null }
  return typeof j.result === "string" ? j.result : null;
}

function toObj(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

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
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD as one part; to be safe join
  const parts = fmt.formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function hourInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(fmt.format(d), 10);
}

function deriveSlot(h) {
  // Keep it simple & non-breaking:
  // <12 → am, 12–17 → pm, >=18 → late
  if (h < 12) return "am";
  if (h < 18) return "pm";
  return "late";
}

/* ------------------------------- handler -------------------------------- */

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    // Params
    const q = req.query || {};
    const now = new Date();
    const ymd = (q.ymd && String(q.ymd).match(/^\d{4}-\d{2}-\d{2}$/)) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(q.slot)) ? q.slot : deriveSlot(hourInTZ(now, TZ));
    const cap = Math.max(1, Math.min( Number(q.n ?? q.limit ?? 50), 200 ));
    const wantDebug = String(q.debug ?? "") === "1";
    const preferFull = String(q.full ?? "") === "1"; // try vbl_full first if explicitly requested

    // Preferred keys (locked)
    const lockedKeys = preferFull
      ? [`vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`]
      : [`vbl:${ymd}:${slot}`, `vbl_full:${ymd}:${slot}`];

    let base = null;
    let picked = null;
    const attempted = [];

    // 1) Try locked keys
    for (const k of lockedKeys) {
      attempted.push(k);
      const raw = await kvGETraw(k);
      const obj = toObj(raw);
      const arr = arrFromAny(obj);
      if (arr && arr.length) { base = arr; picked = k; break; }
    }

    // 2) Fallback keys (safe, non-breaking)
    if (!Array.isArray(base) || base.length === 0) {
      const altKeys = [
        `vb:day:${ymd}:${slot}`,
        `vb:day:${ymd}:last`,
        `vb:day:${ymd}:union`,
      ];
      for (const k of altKeys) {
        attempted.push(k);
        const rawAlt = await kvGETraw(k);
        const objAlt = toObj(rawAlt);
        const arrAlt = arrFromAny(objAlt);
        if (arrAlt && arrAlt.length) { base = arrAlt; picked = `${k}→fallback`; break; }
      }
    }

    // 3) No data found → empty but with clear source tag (unchanged shape)
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

    // 4) Limit (policy cap) without mutating objects
    const items = base.slice(0, cap);
    const top3  = base.slice(0, Math.min(3, cap));

    // 5) Response shape stays identical to previous versions
    const out = {
      ok: true,
      slot,
      ymd,
      items,
      football: items, // keep legacy alias used by some clients
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
