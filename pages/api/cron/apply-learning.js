// pages/api/cron/apply-learning.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

/* ---------- KV helpers (REST wrapper) ---------- */
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const raw = j && typeof j.result !== "undefined" ? j.result : null;
  if (raw == null) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
  return r.ok;
}

/* ---------- time / slot helpers ---------- */
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d); // YYYY-MM-DD
}
function hhmmInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(d); // HH:MM
}
// Novi prozori: 00:00–10:00 (late), 10:00–15:00 (am), 15:00–24:00 (pm)
function slotForNow(d = new Date(), tz = TZ) {
  const t = hhmmInTZ(d, tz);
  if (t >= "00:00" && t < "10:00") return "late";
  if (t >= "10:00" && t < "15:00") return "am";
  return "pm";
}

/* ---------- learning weights ---------- */
function applyWeights(items, weights) {
  if (!Array.isArray(items)) return [];
  if (!weights) return items;
  return items.map((p) => {
    let adj = 0;
    const mk = p?.market_label || p?.market || "";
    if (weights?.markets && typeof weights.markets[mk] === "number") adj += weights.markets[mk];
    if (typeof weights?.global === "number") adj += weights.global;
    const base = p?.confidence_pct ?? p?.confidence ?? 0;
    const conf = Math.max(0, Math.min(100, base + adj));
    return { ...p, confidence_pct: conf };
  });
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const now  = new Date();
    const ymd  = ymdInTZ(now);
    const slot = slotForNow(now);

    // ČITAJ SAMO AKTIVNI SLOT (ne union)
    const slotKey = `vb:day:${ymd}:${slot}`;
    const items   = (await kvGet(slotKey)) || [];

    // Learning weights (opciono)
    const weights = await kvGet(`vb:learn:weights`);

    // Boost + sort by confidence
    const boosted = applyWeights(items, weights)
      .slice()
      .sort((a, b) => (Number(b?.confidence_pct || 0) - Number(a?.confidence_pct || 0)));

    // PIŠI :last + :last_meta
    await kvSet(`vb:day:${ymd}:last`, boosted);
    await kvSet(`vb:meta:${ymd}:last_meta`, {
      ymd,
      slot,                        // "am" | "pm" | "late"
      built_at: new Date().toISOString(),
      count: boosted.length,
      source: `slot:${slot}`,
    });

    res.status(200).json({ ok: true, ymd, slot, count: boosted.length });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
                          }
