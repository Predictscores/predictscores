// pages/api/football.js
// Football tab: tačno 15, named-only (bez agregata), ban U/W/Youth/Reserves/PL2.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const BAN_DEFAULT =
  "(Women|Womens|Girls|Fem|U1[0-9]|U2[0-9]|U-?1[0-9]|U-?2[0-9]|Under-?\\d+|Reserve|Reserves|B Team|B-Team|II|Youth|Academy|Development|Premier League 2|PL2|Friendly|Friendlies|Club Friendly|Test|Trial)";

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd  || "") || ymdInTZ(new Date(), TZ));

    const ban           = encodeURIComponent(process.env.BAN_LEAGUES || BAN_DEFAULT);
    const trusted       = encodeURIComponent(String(process.env.ODDS_TRUSTED_ONLY || "1") === "1" ? "1" : "0");
    const maxPerLeague  = encodeURIComponent(clampInt(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10));
    const markets       = encodeURIComponent("1X2,Match Winner");

    const url = `${baseUrl(req)}/api/value-bets?slot=${slot}&ymd=${ymd}`
              + `&limit=15&max_per_league=${maxPerLeague}`
              + `&trusted=${trusted}&ban=${ban}&markets=${markets}`;

    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return res.status(200).json({ ok: false, slot, tz: TZ, football: [], source: "error" });
    const j = await r.json().catch(() => null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

    return res.status(200).json({ ok: true, slot, tz: TZ, football: arr.slice(0, 15), source: `${j?.source || "value-bets"}` });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e), football: [], slot: "pm", tz: TZ, source: "exception" });
  }
}

/* helpers */
function baseUrl(req) { const host = String(req.headers?.host || "").trim(); const proto = host.startsWith("localhost") ? "http" : "https"; return `${proto}://${host}`; }
function normalizeSlot(s) { const x = String(s || "").toLowerCase(); return ["am","pm","late"].includes(x) ? x : "pm"; }
function ymdInTZ(d = new Date(), tz = TZ) { const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); return (s.split(",")[0] || s).trim(); }
function normalizeYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ); }
function clampInt(v, defVal, min, max) { const n = Number(v); if (!Number.isFinite(n)) return defVal; return Math.max(min, Math.min(max, Math.floor(n))); }
