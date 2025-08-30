// pages/api/value-bets.js
export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";

// ---- Vercel KV (REST) ----
const KV_URL = process.env.KV_REST_API_URL;                // REQUIRED
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN; // optional (prefer for GET)
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO; // write or fallback read

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN_RO && !KV_TOKEN) return null;
  const token = KV_TOKEN_RO || KV_TOKEN;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
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
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body,
  }).catch(() => null);
  return !!(r && r.ok);
}

// ---- helpers ----
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
function leagueTier(league = {}) {
  const name = (league?.name || "").toLowerCase();
  const country = (league?.country || "").toLowerCase();
  if (/uefa|champions|europa|conference/.test(name)) return "T1";
  if (["england","spain","italy","germany","france"].some(x => country.includes(x))) return "T1";
  if (["netherlands","portugal","belgium","turkey","scotland","austria","switzerland","serbia","croatia","denmark","norway","sweden"].some(x => country.includes(x))) return "T2";
  return "T3";
}
function oddsBand(price) {
  if (!price || price <= 0) return "b0";
  if (price <= 1.8) return "b18";
  if (price <= 2.6) return "b26";
  if (price <= 4.0) return "b40";
  return "bXX";
}
function koISO(x) {
  return (
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff || null
  );
}
function minsToKO(iso) {
  if (!iso) return 9999;
  const now = new Date();
  const ko = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"));
  return Math.round((ko.getTime() - now.getTime()) / 60000);
}
function safeNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function getPrice(item) {
  const p = item?.odds?.price ?? item?.odds?.best ?? item?.price ?? item?.best_price ?? null;
  return Number.isFinite(Number(p)) ? Number(p) : null;
}
function probToFairOdds(p) { p = Math.max(1e-6, Math.min(0.999999, p)); return 1 / p; }
function evPercent(modelProb, price) {
  if (!modelProb || !price) return null;
  return (probToFairOdds(modelProb) - price) / price;
}

// ---- learning ----
async function loadCalibration() {
  const calib = (await kvGet("vb:learn:calib:latest")) || {};
  const overlay = (await kvGet("learn:overlay:v1")) || {};
  const evmin = (await kvGet("learn:evmin:v1")) || {};
  return { calib, overlay, evmin };
}
function bucketKey(item) {
  const tier = leagueTier(item?.league);
  const market = (item?.market || item?.market_label || "UNK").toUpperCase();
  const price = getPrice(item);
  const band = oddsBand(price);
  const m2k = minsToKO(koISO(item));
  const tko = m2k <= 90 ? "KO90" : m2k <= 360 ? "KO360" : "KOFAR";
  return `${market}:${tier}:${band}:${tko}`;
}

// ---- konstante (bez dodatnih ENV) ----
const APPLY_LEARNING = true;
const MAX_ONE_MARKET_PER_MATCH = true;
const EV_MIN_T1 = 0.03, EV_MIN_T2 = 0.04, EV_MIN_T3 = 0.05;
const EV_BAND_18 = 0.02, EV_BAND_26 = 0.03, EV_BAND_40 = 0.05, EV_BAND_XX = 0.07;
const EV_KO_EARLY_MINUTES = 90;

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();
    const src = [];

    // 0) self-base (radi i na Vercel-u)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const SELF_BASE = `${proto}://${host}`;

    // 1) pokupi bazu kandidata iz KV; ako nema → fallback rebuild(dry)
    let base =
      (await kvGet(`vb:base:${ymd}:${slot}`)) ||
      (await kvGet(`vb:${ymd}:${slot}`)) ||
      (await kvGet(`vbl_full:${ymd}:${slot}`));

    if (!Array.isArray(base)) {
      const r = await fetch(`${SELF_BASE}/api/cron/rebuild?slot=${slot}&dry=1`, { cache: "no-store" }).catch(() => null);
      const j = r && (await r.json().catch(() => null));
      base = Array.isArray(j?.football) ? j.football : [];
      src.push(j?.source || "rebuild(dry)");
    } else {
      src.push("kv");
    }

    const { overlay, evmin } = await loadCalibration();

    const seenFixture = new Map();
    const out = [];

    for (const it of base) {
      const price = getPrice(it);
      const ev = evPercent(it?.model_prob, price);
      const tier = leagueTier(it?.league);
      const key = bucketKey(it);

      let evMin = tier === "T1" ? EV_MIN_T1 : tier === "T2" ? EV_MIN_T2 : EV_MIN_T3;

      if (price) {
        const band = oddsBand(price);
        if (band === "b18") evMin = Math.max(evMin, EV_BAND_18);
        else if (band === "b26") evMin = Math.max(evMin, EV_BAND_26);
        else if (band === "b40") evMin = Math.max(evMin, EV_BAND_40);
        else evMin = Math.max(evMin, EV_BAND_XX);
      }

      const m2k = minsToKO(koISO(it));
      if (m2k <= EV_KO_EARLY_MINUTES) {
        evMin = Math.max(evMin, evMin); // bez promene – zadržano za moguće tweak-ove
      }

      if (APPLY_LEARNING && evmin && typeof evmin[key] === "number") {
        evMin = Math.max(evMin, evmin[key]);
      }

      if (ev !== null && ev < evMin) continue;

      let conf = safeNumber(it?.confidence_pct ?? it?.confidence ?? 0);
      if (APPLY_LEARNING && overlay && typeof overlay[key] === "number") {
        conf = Math.max(0, Math.min(100, conf + overlay[key]));
      }

      const booksN = safeNumber(it?.odds?.books_count ?? it?.books_count ?? 0);
      if (booksN >= 4) conf = Math.min(100, conf + 1);
      if (booksN >= 6) conf = Math.min(100, conf + 2);

      const fid = String(it?.fixture_id ?? it?.fixture?.id ?? it?.id ?? "");
      if (MAX_ONE_MARKET_PER_MATCH) {
        if (seenFixture.has(fid)) continue;
        seenFixture.set(fid, true);
      }

      out.push({ ...it, confidence_pct: conf, _ev: ev, _evMin: evMin, _bucket: key });
    }

    await kvSet(`vb:decorated:${ymd}:${slot}`, { ts: Date.now(), count: out.length }, 120);

    return res.status(200).json({
      ok: true,
      slot,
      value_bets: out,
      source: `base:${src.join("+")}·learning:${APPLY_LEARNING ? "on" : "off"}`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
