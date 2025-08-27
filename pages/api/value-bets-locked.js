// pages/api/value-bets-locked.js
// READ/WRITE "locked" feed (vbl:<YMD>:<slot>) from KV / Upstash.
// - GET:  /api/value-bets-locked?slot=am|pm|late  -> { ok, ymd, slot, items, source }
// - Internal setter: _internalSetLocked(key, arr)

export const config = { api: { bodyParser: false } };

// Timezone & storage
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Primary storage (what apply-learning/history already use)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Optional dual-write/read to Upstash (same DB in your setup)
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    if (!["am", "pm", "late"].includes(slot)) {
      return res.status(200).json({ ok: false, error: "invalid slot" });
    }

    const ymd = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));
    const key = `vbl:${ymd}:${slot}`;

    const raw = await kvGet(key);
    const items = ensureArray(raw);

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      items,
      source: items.length ? "hit" : "miss",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ============ Internal setter for rebuild ============ */
export async function _internalSetLocked(key, arr) {
  const value = Array.isArray(arr) ? arr : [];
  // Write to KV (primary)
  if (KV_URL && KV_TOKEN) {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "content-type": "application/json",
      },
      // IMPORTANT: store top-level array as JSON string (no { value: [...] } wrapper)
      body: JSON.stringify({ value: JSON.stringify(value) }),
    }).catch(() => {});
  }
  // Dual-write to Upstash (optional, same DB in your env)
  if (UP_URL && UP_TOKEN) {
    await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    }).catch(() => {});
  }
  return true;
}

/* ================= Helpers ================= */

function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (s.split(",")[0] || s).trim();
}
function normalizeYMD(s) {
  // Expect YYYY-MM-DD; fallback to today in TZ if malformed
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}

function ensureArray(v) {
  // Accept either top-level array, or common wrappers we may encounter
  try {
    if (v == null) return [];
    if (Array.isArray(v)) return v;

    if (typeof v === "string") {
      const maybe = v.trim();
      if (!maybe) return [];
      const parsed = JSON.parse(maybe);
      return ensureArray(parsed);
    }
    if (typeof v === "object") {
      // Common bad-writes seen in DB: { value: [...] }, { value_bets: [...] }, { arr: [...] }, { data: [...] }
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;

      // Sometimes value is a JSON string of an array
      if (typeof v.value === "string") {
        try {
          const p = JSON.parse(v.value);
          if (Array.isArray(p)) return p;
        } catch { /* ignore */ }
      }
      // Fallback: nothing usable
      return [];
    }
    return [];
  } catch {
    return [];
  }
}

async function kvGet(key) {
  // 1) KV_REST_* (primary)
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        return j?.result ?? null;
      }
    } catch { /* ignore */ }
  }
  // 2) Upstash fallback
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UP_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        return j?.result ?? null;
      }
    } catch { /* ignore */ }
  }
  return null;
}
