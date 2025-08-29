// pages/api/value-bets-locked.js
// READ/WRITE "locked" feed (vbl:<YMD>:<slot>) iz KV / Upstash.
// - GET  /api/value-bets-locked?slot=am|pm|late[&ymd=YYYY-MM-DD]
//     -> { ok, ymd, slot, items, source:"hit"|"miss" }
// - _internalSetLocked(key, arr) za interno pisanje iz rebuild-a

export const config = { api: { bodyParser: false } };

// Timezone & storage
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Primary storage (KV)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Optional Upstash fallback (isti DB u tvojoj postavci)
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const slot = normalizeSlot(String(req.query?.slot || "am"));
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
      items,                               // <--- ključno: UI očekuje "items"
      source: items.length ? "hit" : "miss",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ============ Internal setter for rebuild ============ */
// Pozovi iz rebuild-a kao:  await _internalSetLocked(`vbl:${ymd}:${slot}`, arr)
export async function _internalSetLocked(key, arr) {
  const value = Array.isArray(arr) ? arr : [];

  // 1) upiši KV (primary) — čuvamo top-level niz kao JSON string
  if (KV_URL && KV_TOKEN) {
    try {
      await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: JSON.stringify(value) }),
      });
    } catch {}
  }

  // 2) dual-write u Upstash (opciono)
  if (UP_URL && UP_TOKEN) {
    try {
      await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UP_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: JSON.stringify(value) }),
      });
    } catch {}
  }

  return true;
}

/* ================= Helpers ================= */

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
        // Upstash KV REST vraća { result: <value|null> }
        if (j && "result" in j) return j.result;
      }
    } catch {}
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
        if (j && "result" in j) return j.result;
      }
    } catch {}
  }

  return null;
}

function ensureArray(v) {
  // Prihvati:
  // - top-level niz
  // - JSON string (niz)
  // - wrapper-e tipa { value:[...] } ili { value:"[...]" } ili { data:[...] }...
  try {
    if (v == null) return [];
    if (Array.isArray(v)) return v;

    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return [];
      return ensureArray(JSON.parse(s));
    }

    if (typeof v === "object") {
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.items)) return v.items;       // tolerancija na starije upise
      if (Array.isArray(v.arr))   return v.arr;
      if (Array.isArray(v.data))  return v.data;

      if (typeof v.value === "string") {
        try {
          const p = JSON.parse(v.value);
          if (Array.isArray(p)) return p;
        } catch {}
      }
      return [];
    }

    return [];
  } catch {
    return [];
  }
}

function normalizeSlot(s) {
  const x = String(s || "").toLowerCase();
  return ["am", "pm", "late"].includes(x) ? x : "am";
}

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
  // Očekuje YYYY-MM-DD; fallback na danas u TZ ako je loš format
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}
