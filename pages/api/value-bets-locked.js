// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

function ymdToday(tz = "Europe/Belgrade") {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d); // YYYY-MM-DD
}

async function kvGetRaw(key) {
  const { KV_REST_API_URL, KV_REST_API_TOKEN } = process.env;
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    throw new Error("KV env missing");
  }
  const url = `${KV_REST_API_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) {
    throw new Error(`KV get ${key} -> ${r.status}`);
  }
  const j = await r.json();
  return j?.result ?? null;
}

function parseMaybeJSON(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const ymd = (req.query.ymd && String(req.query.ymd)) || ymdToday();

    const keyLast = `vb:day:${ymd}:last`;
    const raw = await kvGetRaw(keyLast);
    const payload = parseMaybeJSON(raw);

    const items =
      Array.isArray(payload?.items) ? payload.items :
      Array.isArray(payload) ? payload :
      [];

    let builtAt = null, slot = null;
    const metaRaw = await kvGetRaw(`vb:meta:${ymd}:last_meta`).catch(()=>null);
    const meta = parseMaybeJSON(metaRaw);
    if (meta) {
      builtAt = meta.built_at || meta.builtAt || null;
      slot = meta.slot || null;
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      ymd,
      source: "last",
      built_at: builtAt,
      slot,
      items,
    }));
  } catch (e) {
    res.status(200).end(JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      ymd: null,
      source: "last",
      built_at: null,
      slot: null,
      items: [],
    }));
  }
}
