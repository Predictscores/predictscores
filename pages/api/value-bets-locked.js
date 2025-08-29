// pages/api/value-bets-locked.js
// Combined vs Football bez menjanja fronta:
// - Default (Combined): vrati TOP 3 iz vbl:<YMD>:<slot>
// - Football (preko Referer koji sadrži "/football") ili ?full=1: vrati FULL 15 iz vbl_full:<YMD>:<slot>

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));

    // Minimalna detekcija taba:
    const wantFullByQuery = String(req.query?.full || "") === "1";
    const ref = String(req.headers?.referer || "");
    const wantFullByRef = /\/football(\b|\/|$)/i.test(ref);
    const wantFull = wantFullByQuery || wantFullByRef;

    const keyTop3 = `vbl:${ymd}:${slot}`;
    const keyFull = `vbl_full:${ymd}:${slot}`;

    const [rawTop3, rawFull] = await Promise.all([kvGet(keyTop3), kvGet(keyFull)]);
    const top3 = ensureArray(rawTop3);
    const full = ensureArray(rawFull);

    let items, source;
    if (wantFull && full.length) {
      items = full.slice(0, 15);
      source = `vbl_full:${ymd}:${slot}`;
    } else if (top3.length) {
      items = top3.slice(0, 3);
      source = `vbl:${ymd}:${slot}`;
    } else if (wantFull && !full.length && top3.length) {
      items = top3.slice(0, 3);
      source = `fallback->vbl:${ymd}:${slot}`;
    } else {
      items = [];
      source = "miss";
    }

    return res.status(200).json({ ok: true, ymd, slot, items, source });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ===== Helpers ===== */
function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return (s.split(",")[0] || s).trim();
}
function normalizeYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ); }
function normalizeSlot(s) { const x = String(s || "").toLowerCase(); return ["am","pm","late"].includes(x) ? x : "pm"; }

function ensureArray(v) {
  try {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return ensureArray(JSON.parse(v));
    if (typeof v === "object") {
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.data)) return v.data;
      if (typeof v.value === "string") {
        try { const p = JSON.parse(v.value); if (Array.isArray(p)) return p; } catch {}
      }
    }
    return [];
  } catch { return []; }
}

async function kvGet(key) {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: "no-store",
      });
      if (r.ok) { const j = await r.json().catch(() => null); return j?.result ?? null; }
    } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UP_TOKEN}` }, cache: "no-store",
      });
      if (r.ok) { const j = await r.json().catch(() => null); return j?.result ?? null; }
    } catch {}
  }
  return null;
}
