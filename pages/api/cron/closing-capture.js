// pages/api/cron/closing-capture.js
// Per-fixture closing: gleda KO u prozoru [-15min, +5min], max 10 po run-u.
// Zove /odds?fixture=<id> samo za te mečeve (jeftino).

export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";
const AF_BASE = "https://v3.football.api-sports.io";
const AF_KEY = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO;

async function kvGet(key) {
  if (!KV_URL || (!KV_TOKEN && !KV_TOKEN_RO)) return null;
  const token = KV_TOKEN_RO || KV_TOKEN;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.result === "undefined") return null;
    try { return JSON.parse(j.result); } catch { return j.result; }
  } catch { return null; }
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

async function af(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${AF_BASE}${path}?${qs}`;
  const r = await fetch(url, { headers: { "x-apisports-key": AF_KEY }, cache: "no-store" });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error(`AF error: ${JSON.stringify(j.errors)}`);
  return j;
}

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();

    const full = await kvGet(`vbl_full:${ymd}:${slot}`);
    const list = Array.isArray(full) ? full : [];

    const now = Date.now();
    const inWindow = list.filter(x => {
      const t = Date.parse(x.kickoff_utc || x.kickoff);
      if (!Number.isFinite(t)) return false;
      const dt = t - now;
      return dt >= -15 * 60 * 1000 && dt <= 5 * 60 * 1000; // KO [-15min, +5min]
    });

    const MAX_PER_RUN = 10;
    const target = inWindow.slice(0, MAX_PER_RUN);

    let closed = 0;
    for (const it of target) {
      await af("/odds", { fixture: it.fixture_id }).catch(() => null);
      closed++;
    }

    return res.status(200).json({
      ok: true,
      ymd, slot,
      targeted: target.length,
      closed,
      source: "closing-capture:per-fixture",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
