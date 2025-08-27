// pages/api/value-bets-locked.js
// Slot-aware locked storage: vbl:${YMD}:${slot}  (slot ∈ am|pm|late)

const TZ = process.env.TZ || "Europe/Belgrade";

// --- Upstash REST helpers (optional) ---
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvGet(key) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      cache: "no-store",
    });
    const j = await r.json().catch(() => null);
    if (j && j.result) {
      try { return JSON.parse(j.result); } catch { return j.result; }
    }
    return null;
  }
  // process-global fallback (best effort)
  globalThis.__LOCKED ||= Object.create(null);
  return globalThis.__LOCKED[key] ?? null;
}

async function kvSet(key, value, ttlSeconds = 60 * 60 * 24 * 2) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    const body = JSON.stringify({ value, ttl: ttlSeconds });
    const r = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "content-type": "application/json",
      },
      body,
    });
    await r.text().catch(() => {});
    return true;
  }
  globalThis.__LOCKED ||= Object.create(null);
  globalThis.__LOCKED[key] = value;
  return true;
}

// --- utils ---
function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return s.split(",")[0] || s; // YYYY-MM-DD
}
function okJson(res, obj) { return res.status(200).json(obj); }

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase(); // am|pm|late
    if (!["am", "pm", "late"].includes(slot)) {
      return okJson(res, { ok: true, ymd: ymdInTZ(), slot, items: [], source: "invalid-slot" });
    }

    const ymd = ymdInTZ();
    const key = `vbl:${ymd}:${slot}`;
    const data = await kvGet(key);

    if (Array.isArray(data) && data.length) {
      return okJson(res, { ok: true, ymd, slot, items: data, source: "hit" });
    }

    // fallback: probaj druge slotove istog dana (ne menja se 'slot' u odgovoru!)
    const order = ["late", "am", "pm"].filter((s) => s !== slot);
    for (const s of order) {
      const alt = await kvGet(`vbl:${ymd}:${s}`);
      if (Array.isArray(alt) && alt.length) {
        return okJson(res, { ok: true, ymd, slot, items: alt, source: `fallback:${s}` });
      }
    }

    return okJson(res, { ok: true, ymd, slot, items: [], source: "miss" });
  } catch (e) {
    return okJson(res, { ok: false, error: String(e?.message || e) });
  }
}

// Expose a setter (optional) for internal calls from rebuild
export const _internalSetLocked = kvSet;
