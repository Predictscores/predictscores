// pages/api/value-bets.js
// LIVE lista + primena learning kalibracije (overlay/evmin) i blagi guardovi.
// Zadržava postojeći shape: { ok, slot, value_bets: [...], source }

export const config = { runtime: "nodejs" };

const TZ = process.env.APP_TZ || "Europe/Belgrade";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || ""; // ako je prazan, koristimo relativni fetch
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// -------- Redis helpers (REST) --------
async function kvGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || typeof j.result === "undefined") return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}
async function kvSet(key, value, ttlSec = 0) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  const body = new URLSearchParams();
  body.set("value", typeof value === "string" ? value : JSON.stringify(value));
  if (ttlSec > 0) body.set("ex", String(ttlSec));
  const r = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body,
  });
  return r.ok;
}

// -------- time & slot helpers --------
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d); // YYYY-MM-DD
}
function hourInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  return Number(fmt.formatToParts(d).find(p => p.type === "hour").value);
}
function autoSlot(tz = TZ) {
  const h = hourInTZ(new Date(), tz);
  if (h < 10) return "late"; // 00–09
  if (h < 15) return "am";   // 10–14
  return "pm";               // 15–23
}

// -------- domain helpers --------
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
function koISO(item) {
  return (
    item?.datetime_local?.starting_at?.date_time ||
    item?.datetime_local?.date_time ||
    item?.time?.starting_at?.date_time ||
    item?.kickoff || null
  );
}
function minsToKO(iso, tz = TZ) {
  if (!iso) return 9999;
  const now = new Date();
  const ko = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z")); // tolerate "YYYY-MM-DD HH:mm"
  return Math.round((ko.getTime() - now.getTime()) / 60000);
}
function safeNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function getPrice(item) {
  // pokušaj raznih polja; ako nema – vrati null i preskoči EV pravila
  const p = item?.odds?.price ?? item?.odds?.best ?? item?.price ?? item?.best_price ?? null;
  return p ? Number(p) : null;
}
function probToFairOdds(p) {
  p = Math.max(1e-6, Math.min(0.999999, p));
  return 1 / p;
}
function evPercent(modelProb, price) {
  if (!modelProb || !price) return null;
  const fair = probToFairOdds(modelProb);
  // jednostavan EV: (fair - price) / price → u %
  return (fair - price) / price;
}

// -------- learning fetch --------
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
  const tko = m2k <= 90 ? "KO90" : m2k <= 360 ? "KO360" : "KO FAR";
  return `${market}:${tier}:${band}:${tko}`;
}

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();
    const sourceNotes = [];

    // 1) Učitaj bazu kandidata (ne diramo kako ih praviš) — prvo probaj Redis, pa fallback na rebuild?dry
    let base =
      (await kvGet(`vb:base:${ymd}:${slot}`)) ||
      (await kvGet(`vb:${ymd}:${slot}`)) ||
      (await kvGet(`vbl_full:${ymd}:${slot}`));

    if (!Array.isArray(base)) {
      // fallback: pozovi rebuild (dry ako postoji; ako ne, koristi realan ali on NE menja lock)
      const url = `${BASE_URL}/api/cron/rebuild?slot=${slot}&dry=1`;
      const r = await fetch(url, { cache: "no-store" }).catch(() => null);
      const j = r && (await r.json().catch(() => null));
      base = Array.isArray(j?.football) ? j.football : [];
      sourceNotes.push(j?.source || "rebuild(dry)");
    } else {
      sourceNotes.push("redis");
    }

    // 2) Learning kalibracija
    const { overlay, evmin } = await loadCalibration();

    // 3) ENV pragovi (fleksibilno, bez tvrdog “4 bookija” uslova)
    const EV_MIN_T1 = safeNumber(process.env.EV_MIN_T1 ?? 0.03);
    const EV_MIN_T2 = safeNumber(process.env.EV_MIN_T2 ?? 0.04);
    const EV_MIN_T3 = safeNumber(process.env.EV_MIN_T3 ?? 0.05);
    const EV_KO_EARLY_BONUS = safeNumber(process.env.EV_KO_EARLY_BONUS ?? 0.00); // + za blizu KO
    const EV_KO_EARLY_MINUTES = safeNumber(process.env.EV_KO_EARLY_MINUTES ?? 90);
    const EV_BAND_18 = safeNumber(process.env.EV_BAND_18 ?? 0.02);
    const EV_BAND_26 = safeNumber(process.env.EV_BAND_26 ?? 0.03);
    const EV_BAND_40 = safeNumber(process.env.EV_BAND_40 ?? 0.05);
    const EV_BAND_XX = safeNumber(process.env.EV_BAND_XX ?? 0.07);
    const APPLY_LEARNING = (process.env.APPLY_LEARNING ?? "1") === "1";
    const MAX_ONE_MARKET_PER_MATCH = (process.env.MAX_ONE_MARKET_PER_MATCH ?? "1") === "1";

    // 4) Obrada kandidata
    const seenFixture = new Map(); // market anti-corr: po meču dozvoli max 1 market
    const out = [];

    for (const it of base) {
      // izračun EV ako moguće
      const p = getPrice(it);
      const ev = evPercent(it?.model_prob, p);
      const tier = leagueTier(it?.league);
      const key = bucketKey(it);

      // EV pragovi bazni (tier) + banda + blizu KO bonus
      let evMin =
        tier === "T1" ? EV_MIN_T1 :
        tier === "T2" ? EV_MIN_T2 : EV_MIN_T3;

      if (p) {
        const band = oddsBand(p);
        if (band === "b18") evMin = Math.max(evMin, EV_BAND_18);
        else if (band === "b26") evMin = Math.max(evMin, EV_BAND_26);
        else if (band === "b40") evMin = Math.max(evMin, EV_BAND_40);
        else evMin = Math.max(evMin, EV_BAND_XX);
      }
      const m2k = minsToKO(koISO(it));
      if (m2k <= EV_KO_EARLY_MINUTES) evMin = Math.max(evMin, EV_KO_EARLY_BONUS + evMin);

      // Per-bucket evmin iz learninga (ako postoji) ima prioritet
      if (APPLY_LEARNING && evmin && typeof evmin[key] === "number") {
        evMin = Math.max(evMin, evmin[key]);
      }

      // Filter na EV (ako imamo dovoljno podataka)
      if (ev !== null && ev < evMin) continue;

      // Primena overlay-a na confidence
      let conf = safeNumber(it?.confidence_pct ?? it?.confidence ?? 0);
      if (APPLY_LEARNING && overlay && typeof overlay[key] === "number") {
        conf = Math.max(0, Math.min(100, conf + overlay[key]));
      }
      // Mala nagrada za više bukija ako postoji info
      const booksN = safeNumber(it?.odds?.books_count ?? it?.books_count ?? 0);
      if (booksN >= 4) conf = Math.min(100, conf + 1);
      if (booksN >= 6) conf = Math.min(100, conf + 2);

      // Anti-correlation: max 1 market po meču
      const fid = String(it?.fixture_id ?? it?.fixture?.id ?? it?.id ?? "");
      if (MAX_ONE_MARKET_PER_MATCH) {
        if (seenFixture.has(fid)) continue;
        seenFixture.set(fid, true);
      }

      out.push({ ...it, confidence_pct: conf, _ev: ev, _evMin: evMin, _bucket: key });
    }

    // Cache short response (opciono)
    await kvSet(`vb:decorated:${ymd}:${slot}`, { ts: Date.now(), count: out.length }, 120);

    return res.status(200).json({
      ok: true,
      slot,
      value_bets: out,
      source: `base:${sourceNotes.join("+")}·learning:${APPLY_LEARNING ? "on" : "off"}`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
