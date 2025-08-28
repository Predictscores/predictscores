// pages/api/cron/rebuild.js
// Zaključavanje "value bets" u ključ vbl:<YMD>:<slot> da UI čita stabilan feed.
// Radi tako što pozove /api/value-bets i snimi rezultat u KV/Upstash.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "am"));
    const ymd = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));
    const key = `vbl:${ymd}:${slot}`;

    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
    const proto = (req.headers["x-forwarded-proto"] || "https").toString();
    const url = `${proto}://${host}/api/value-bets?slot=${encodeURIComponent(slot)}&ymd=${encodeURIComponent(ymd)}`;

    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: `value-bets failed: ${r.status}` });
    }
    const j = await r.json().catch(() => ({}));
    const items = Array.isArray(j?.value_bets) ? j.value_bets : [];

    await setLocked(key, items);

    return res.status(200).json({
      ok: true,
      slot,
      count: items.length,
      football: items,
      source: items.length ? "seed:set" : "seed:empty",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ============== helpers ============== */

async function setLocked(key, arr) {
  const value = Array.isArray(arr) ? arr : [];
  if (KV_URL && KV_TOKEN) {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    }).catch(() => {});
  }
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
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}
