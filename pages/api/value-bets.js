// pages/api/value-bets.js
export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO;

async function kvGet(key) {
  if (!KV_URL || (!KV_TOKEN && !KV_TOKEN_RO)) return null;
  const token = KV_TOKEN_RO || KV_TOKEN;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || typeof j.result === "undefined") return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}
async function kvSet(key, value, ttlSec = 0) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = new URLSearchParams();
  body.set("value", typeof value === "string" ? value : JSON.stringify(value));
  if (ttlSec > 0) body.set("ex", String(ttlSec));
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` }, body,
  }).catch(() => null);
  return !!(r && r.ok);
}
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function hourInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  return Number(fmt.formatToParts(d).find(p => p.type === "hour").value);
}
function autoSlot(tz = TZ) {
  const h = hourInTZ(new Date(), tz);
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}
function safeNumber(x, d=0){ const n = Number(x); return Number.isFinite(n)?n:d; }

async function loadCalibration() {
  const calib = (await kvGet("vb:learn:calib:latest")) || {};
  const overlay = (await kvGet("learn:overlay:v1")) || {};
  const evmin = (await kvGet("learn:evmin:v1")) || {};
  return { calib, overlay, evmin };
}
function labelForPick(k){ return k==="1"?"Home":k==="2"?"Away":k==="X"?"Draw":String(k||""); }

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const SELF_BASE = `${proto}://${host}`;

    let base =
      (await kvGet(`vbl_full:${ymd}:${slot}`)) ||
      (await kvGet(`vbl:${ymd}:${slot}`));

    const src = [];
    if (!Array.isArray(base)) {
      const r = await fetch(`${SELF_BASE}/api/cron/rebuild?slot=${slot}&dry=1`, { cache: "no-store" }).catch(() => null);
      const j = r && (await r.json().catch(() => null));
      base = Array.isArray(j?.football) ? j.football : [];
      src.push(j?.source || "rebuild(dry)");
    } else {
      src.push("kv");
    }

    const { overlay, evmin } = await loadCalibration();

    const out = base.map(it => {
      // pick normalizacija za UI:
      const code = it.pick_code || (typeof it.pick === "string" && ["1","X","2"].includes(it.pick) ? it.pick : "");
      const pickLabel = it.selection_label || (typeof it.pick === "string" && !["1","X","2"].includes(it.pick) ? it.pick : labelForPick(code));
      let conf = safeNumber(it?.confidence_pct ?? it?.confidence ?? 0);

      // per-bucket overlay/evmin — jednostavno: ako postoji ključ “1X2:*”, primeni ga
      const market = (it?.market || "UNK").toUpperCase();
      const bucketKey = `${market}:*`;
      if (typeof overlay[bucketKey] === "number") conf = Math.max(0, Math.min(100, conf + overlay[bucketKey]));

      return {
        ...it,
        pick: pickLabel,      // <<< string koji UI lepo prikaže
        pick_code: code,      // originalni kod ako ti treba
        home: it.home || it?.teams?.home || "",
        away: it.away || it?.teams?.away || "",
        league_name: it.league_name || it?.league?.name || "",
        league_country: it.league_country || it?.league?.country || "",
      };
    });

    await kvSet(`vb:decorated:${ymd}:${slot}`, { ts: Date.now(), count: out.length }, 120);

    return res.status(200).json({
      ok: true,
      slot,
      value_bets: out,
      source: `base:${src.join("+")}·learning:on`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
