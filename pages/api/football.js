// pages/api/football.js
// Football tab (response samo) — vraća 15 uz tier sort i cap-ove.
// Ne menja front.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

const TIER1_RE  = safeRegex(process.env.TIER1_RE || "(Premier League|La Liga|Serie A|Bundesliga|Ligue 1|Champions League|UEFA\\s*Champ)");
const TIER2_RE  = safeRegex(process.env.TIER2_RE || "(Championship|Eredivisie|Primeira|Liga Portugal|Super Lig|Pro League|EFL|Eredivisie|Jupiter|Bundesliga 2|Serie B|LaLiga 2|Ligue 2|Eerste Divisie|S\\.?Liga)");
const TIER1_CAP = intEnv(process.env.TIER1_CAP, 7, 0, 15);
const TIER2_CAP = intEnv(process.env.TIER2_CAP, 5, 0, 15);
const TIER3_CAP = intEnv(process.env.TIER3_CAP, 3, 0, 15);
const TIER1_BONUS = numEnv(process.env.TIER1_BONUS, 10);
const TIER2_BONUS = numEnv(process.env.TIER2_BONUS, 4);

const VB_MAX_PER_LEAGUE = intEnv(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10);
const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "1") === "1";
const BAN_DEFAULT =
  "(Women|Womens|Girls|Fem|U1[0-9]|U2[0-9]|U-?1[0-9]|U-?2[0-9]|Under-?\\d+|Reserve|Reserves|B Team|B-Team|II|Youth|Academy|Development|Premier League 2|PL2|Friendly|Friendlies|Club Friendly|Test|Trial)";

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd  || "") || ymdInTZ(new Date(), TZ));

    const ban          = encodeURIComponent(process.env.BAN_LEAGUES || BAN_DEFAULT);
    const trusted      = encodeURIComponent(TRUSTED_ONLY ? "1" : "0");
    const maxPerLeague = encodeURIComponent(VB_MAX_PER_LEAGUE);
    const markets      = encodeURIComponent("1X2,Match Winner");

    // Uzimamo širi skup pa kapiramo na 15 po tier cap-ovima
    const url = `${baseUrl(req)}/api/value-bets?slot=${slot}&ymd=${ymd}`
              + `&limit=60&max_per_league=${maxPerLeague}`
              + `&trusted=${trusted}&ban=${ban}&markets=${markets}`;

    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return res.status(200).json({ ok: false, slot, tz: TZ, football: [], source: "value-bets:error" });
    const j = await r.json().catch(() => null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

    const decorated = arr.map((t) => {
      const tier = tierOf(t?.league?.name, t?.league?.country);
      const baseConf = Number(t?.confidence_pct || 0);
      const bonus = tier === 1 ? TIER1_BONUS : tier === 2 ? TIER2_BONUS : 0;
      const score = baseConf + bonus;
      return { ...t, __tier: tier, __score: score };
    });

    decorated.sort((a, b) => {
      const s = (b.__score || 0) - (a.__score || 0);
      if (s !== 0) return s;
      const ta = Date.parse(a?.kickoff || a?.datetime_local?.date_time || "") || 0;
      const tb = Date.parse(b?.kickoff || b?.datetime_local?.date_time || "") || 0;
      return ta - tb;
    });

    const g1 = decorated.filter(x => x.__tier === 1);
    const g2 = decorated.filter(x => x.__tier === 2);
    const g3 = decorated.filter(x => x.__tier === 3);

    const pick1 = g1.slice(0, TIER1_CAP);
    const pick2 = g2.slice(0, TIER2_CAP);
    const pick3 = g3.slice(0, TIER3_CAP);

    let selected = [...pick1, ...pick2, ...pick3];
    if (selected.length < 15) {
      const left = decorated.filter(x => !selected.includes(x));
      selected = selected.concat(left.slice(0, 15 - selected.length));
    }
    selected = selected.slice(0, 15);

    return res.status(200).json({
      ok: true,
      slot,
      tz: TZ,
      football: selected.map(({ __tier, __score, ...rest }) => rest).slice(0, 15),
      tier_buckets: { tier1: g1.length, tier2: g2.length, tier3: g3.length },
      source: `${j?.source || "value-bets(named-only)"}+tiers`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e), football: [], slot: "pm", tz: TZ, source: "exception" });
  }
}

/* helpers */
function tierOf(leagueName = "", country = "") {
  const L = String(leagueName || "");
  const C = String(country || "");
  if (TIER1_RE && (TIER1_RE.test(L) || TIER1_RE.test(C))) return 1;
  if (TIER2_RE && (TIER2_RE.test(L) || TIER2_RE.test(C))) return 2;
  return 3;
}
function baseUrl(req) { const host = String(req.headers?.host || "").trim(); const proto = host.startsWith("localhost") ? "http" : "https"; return `${proto}://${host}`; }
function normalizeSlot(s) { const x = String(s || "").toLowerCase(); return ["am","pm","late"].includes(x) ? x : "pm"; }
function ymdInTZ(d = new Date(), tz = TZ) { const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); return (s.split(",")[0] || s).trim(); }
function normalizeYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ); }
function intEnv(v, defVal, min, max) { const n = Number(v); if (!Number.isFinite(n)) return defVal; return Math.max(min, Math.min(max, Math.floor(n))); }
function numEnv(v, defVal) { const n = Number(v); return Number.isFinite(n) ? n : defVal; }
function safeRegex(src) { try { if (!src) return null; return new RegExp(src, "i"); } catch { return null; } }
