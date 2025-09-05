// pages/api/history.js
// History sada pokazuje SAMO Combined (Top 3 po danu):
// 1) čita hist:<YMD> (građeno iz combined u apply-learning)
// 2) fallback: vb:day:<YMD>:combined (ako hist još ne postoji)
// Vraća i `items` i `history` (isti niz), + `count`.

export const config = { runtime: "nodejs" };

function kvEnv() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_URL ||
    "";
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_READ_ONLY_TOKEN ||
    "";
  return { url, token };
}
async function kvGetRaw(key) {
  const { url, token } = kvEnv();
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.result === "undefined") return null;
    return j.result;
  } catch { return null; }
}
async function kvGetJSON(key) {
  const raw = await kvGetRaw(key);
  if (raw == null) return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try { return JSON.parse(s); } catch { return raw; }
    }
    return raw;
  }
  return raw;
}

function ymd(d = new Date()) { return d.toISOString().slice(0, 10); }
function daysArray(n) {
  const out = []; const today = new Date();
  for (let i = 0; i < n; i++) { const d = new Date(today); d.setDate(d.getDate() - i); out.push(ymd(d)); }
  return out;
}

function coercePick(it, d) {
  const home = it.home || it?.teams?.home || "";
  const away = it.away || it?.teams?.away || "";
  const market = it.market || it.market_label || "";
  const rawPick = it.pick ?? it.selection ?? it.selection_label ?? it.pick_code;
  const pick =
    typeof rawPick === "string" ? rawPick :
    it?.pick_code === "1" ? "Home" :
    it?.pick_code === "2" ? "Away" :
    it?.pick_code === "X" ? "Draw" : String(rawPick || "");
  const price = Number(it?.odds?.price);
  const result = (it.outcome || it.result || "").toString().toUpperCase();
  return {
    ...it,
    home, away, market,
    pick, selection: pick,
    odds: Number.isFinite(price) ? { price } : it.odds || {},
    result,
    _day: it._day || d,
    _source: it._source || "combined",
  };
}
function flattenHistObj(obj, d) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.map((x) => coercePick(x, d));
  if (Array.isArray(obj.items)) return obj.items.map((x) => coercePick(x, d));
  return [];
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const days = Math.max(1, Math.min(60, Number(req.query.days || 14)));
    const ymds = daysArray(days);

    const flat = [];

    for (const d of ymds) {
      // 1) primarno hist:<YMD> (već settled iz combined)
      let hist = await kvGetJSON(`hist:${d}`);
      let items = flattenHistObj(hist, d);

      // 2) fallback: vb:day:<YMD>:combined (ako još nije pisano u hist)
      if (!items.length) {
        const combined = await kvGetJSON(`vb:day:${d}:combined`);
        if (Array.isArray(combined) && combined.length) {
          items = combined.map((x) => coercePick(x, d));
        }
      }

      // 3) (opciono) poslednji fallback može biti union — ali ga PRESKAČEMO
      // jer History želimo samo iz Combined.

      for (const it of items) flat.push(it);
    }

    return res.status(200).json({
      ok: true,
      days,
      count: flat.length,
      items: flat,
      history: flat, // kompatibilnost sa UI koji čita .history
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
      items: [],
      history: [],
      count: 0,
    });
  }
}
