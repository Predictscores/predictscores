// pages/api/value-bets.js
// Čita bazu iz KV (vbl_full/vbl) ili radi fallback rebuild(dry) preko self-base.
// Primena learning overlay/evmin. Dodaje bridge polja (home/away/selection_label) radi UI-a.

export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";

// Vercel KV
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
function oddsBand(price){ if(!price||price<=0) return "b0"; if(price<=1.8) return "b18"; if(price<=2.6) return "b26"; if(price<=4.0) return "b40"; return "bXX"; }

async function loadCalibration() {
  const calib = (await kvGet("vb:learn:calib:latest")) || {};
  const overlay = (await kvGet("learn:overlay:v1")) || {};
  const evmin = (await kvGet("learn:evmin:v1")) || {};
  return { calib, overlay, evmin };
}

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const SELF_BASE = `${proto}://${host}`;

    // 1) baza iz KV (prefer vbl_full, pa vbl)
    let base =
      (await kvGet(`vbl_full:${ymd}:${slot}`)) ||
      (await kvGet(`vbl:${ymd}:${slot}`));

    // fallback na rebuild(dry) ako nema
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

    // decorate: apply learning and add bridge fields if missing
    const out = base.map(it => {
      let conf = safeNumber(it?.confidence_pct ?? it?.confidence ?? 0);
      const price = Number(it?.odds?.price || 0) || null;
      const band = price ? oddsBand(price) : "b0";
      const m2k = it?.kickoff ? 999 : 999; // (nije nam bitno ovde)

      const market = (it?.market || it?.market_label || "UNK").toUpperCase();
      const tier = "UNK";
      const tko = "UNK";
      const key = `${market}:${tier}:${band}:${tko}`;

      if (typeof overlay[key] === "number") conf = Math.max(0, Math.min(100, conf + overlay[key]));

      // bridge fields
      const pick = typeof it.pick === "string" ? it.pick : (it.pick?.code || "");
      const selection_label = it.selection_label || (pick==="1"?"Home":pick==="2"?"Away":pick==="X"?"Draw":String(pick||""));

      return {
        ...it,
        confidence_pct: conf,
        home: it.home || it?.teams?.home || "",
        away: it.away || it?.teams?.away || "",
        league_name: it.league_name || it?.league?.name || "",
        league_country: it.league_country || it?.league?.country || "",
        selection_label
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
