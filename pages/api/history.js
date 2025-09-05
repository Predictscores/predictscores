// pages/api/history.js
// NEW adapter: čita hist:<YMD> (primarno), pa hist:day:<YMD>, pa vb:day:<YMD>:last (fallback)
// i vraća `items` (flat) tako da HistoryPanel odmah radi bez izmene UI-a.

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
    // Prefer pipeline/get za doslednost, ali /get/<key> je brži za 1 ključ
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.result === "undefined") return null;
    return j.result;
  } catch {
    return null;
  }
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

function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function daysArray(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(ymd(d));
  }
  return out;
}

function coercePick(it) {
  // normalizuj polja da UI dobije home/away/market/pick/odds/result
  const home = it.home || it?.teams?.home || "";
  const away = it.away || it?.teams?.away || "";
  const market = it.market || it.market_label || "";
  const rawPick = it.pick ?? it.selection ?? it.selection_label ?? it.pick_code;
  const pick =
    typeof rawPick === "string"
      ? rawPick
      : it?.pick_code === "1"
      ? "Home"
      : it?.pick_code === "2"
      ? "Away"
      : it?.pick_code === "X"
      ? "Draw"
      : String(rawPick || "");
  const price = Number(it?.odds?.price);
  // prefer `outcome` (što sada pišemo iz apply-learning) pa `result`
  const result =
    (it.outcome && String(it.outcome).toUpperCase()) ||
    (it.result && String(it.result).toUpperCase()) ||
    "";

  return {
    ...it,
    home,
    away,
    market,
    pick,
    selection: pick,
    odds: Number.isFinite(price) ? { price } : it.odds || {},
    result, // "WIN" | "LOSE" | "VOID" | "PENDING" | ""
  };
}

function flattenHistoryObject(obj) {
  // hist:<YMD> format iz apply-learning: { ymd, items:[...], counts:{}, roi:{} }
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.map(coercePick);
  if (Array.isArray(obj.items)) return obj.items.map(coercePick);
  return [];
}

export default async function handler(req, res) {
  try {
    const days = Math.max(1, Math.min(60, Number(req.query.days || 14)));

    const ymds = daysArray(days);
    const flat = [];

    for (const d of ymds) {
      // 1) primarno čitaj hist:<YMD>
      let histObj = await kvGetJSON(`hist:${d}`);
      let items = flattenHistoryObject(histObj);

      // 2) fallback hist:day:<YMD>
      if (!items.length) {
        histObj = await kvGetJSON(`hist:day:${d}`);
        items = flattenHistoryObject(histObj);
      }

      // 3) fallback vb:day:<YMD>:last (lista predloga bez ishoda)
      if (!items.length) {
        const vb = await kvGetJSON(`vb:day:${d}:last`);
        if (Array.isArray(vb) && vb.length) {
          items = vb.map(coercePick);
        }
      }

      if (items.length) {
        // možes dodati d info svakoj stavci radi rendera
        for (const it of items) {
          flat.push({ ...it, _day: d });
        }
      }
    }

    // HistoryPanel gleda body.items ili body.history kao niz
    return res.status(200).json({
      ok: true,
      count: flat.length,
      items: flat,
    });
  } catch (e) {
    return res
      .status(200)
      .json({ ok: false, error: String(e?.message || e) });
  }
}
