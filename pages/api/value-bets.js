// pages/api/value-bets.js
// Seed za rebuild: fixtures + (ako postoje) keširane kvote iz KV/Upstash.
// BAN (U/Women/Res/Youth...), slot prozor, datum = danas.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_BASE = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL;

// primarni KV (isto kao apply-learning/history)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// fallback: Upstash
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const BAN_REGEX =
  /\bU\s*-?\s*\d{1,2}\b|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

export default async function handler(req, res) {
  try {
    if (!AF_KEY) return res.status(200).json({ ok:false, error:"API_FOOTBALL_KEY missing", value_bets: [] });

    const slot = String(req.query?.slot || "am").toLowerCase();
    if (!["am","pm","late"].includes(slot)) return res.status(200).json({ ok:false, error:"invalid slot", value_bets: [] });

    const ymd = ymdInTZ(new Date(), TZ);

    // 1) fixtures za danas
    const fj = await httpJSON(`${AF_BASE}/fixtures?date=${ymd}&timezone=${encodeURIComponent(TZ)}`);
    const fixtures = Array.isArray(fj?.response) ? fj.response : [];

    // 2) filtriraj BAN + slot
    const filtered = fixtures.filter(fx => {
      const name  = String(fx?.league?.name || "");
      const round = String(fx?.league?.round || "");
      const stage = String(fx?.league?.stage || "");
      if (BAN_REGEX.test(`${name} ${round} ${stage}`)) return false;
      return inSlotWindow(fx?.fixture?.date, TZ, slot);
    });

    // 3) mapiraj + pokušaj učitati kvote iz KV/Upstash keša
    const bets = [];
    for (const row of filtered) {
      const fx = row?.fixture || {};
      const lg = row?.league || {};
      const tm = row?.teams  || {};
      const fid = fx?.id;

      const iso = fx?.date ? String(fx.date).replace(" ","T") : null;
      const dt  = iso ? toLocalDateTime(iso, TZ) : null;

      let odds = null;
      if (fid) {
        const key = `odds:fixture:${ymd}:${fid}`;
        odds = await kvGet(key); // KV, pa Upstash fallback
      }

      const best = Number(odds?.best) || null;
      const mw   = odds?.match_winner || { home:null, draw:null, away:null };
      const fav  = odds?.fav || null;

      bets.push({
        fixture_id: fx?.id ?? null,
        league: {
          id: lg?.id ?? null,
          name: lg?.name || null,
          country: lg?.country || null,
          round: lg?.round || null,
          stage: lg?.stage || null,
        },
        teams: {
          home: { id: tm?.home?.id ?? null, name: String(tm?.home?.name || "") || null },
          away: { id: tm?.away?.id ?? null, name: String(tm?.away?.name || "") || null },
        },
        datetime_local: dt ? { starting_at: { date_time: dt } } : null,

        market: "1X2",
        market_label: "1X2",
        selection: fav,

        market_odds: best,
        market_odds_decimal: best,
        odds: { best, match_winner: mw },

        confidence_pct: 50,
      });
    }

    const src = bets.some(b => Number(b?.market_odds) >= 1.01) ? "fixtures+odds(cache)" : "fixtures-only(seed)";
    return res.status(200).json({ ok:true, disabled:false, slot, value_bets: bets, source: src });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e), value_bets: [] });
  }
}

/* ------- helpers ------- */

async function httpJSON(url){
  const r = await fetch(url, { headers: { "x-apisports-key": AF_KEY, "cache-control":"no-store" } });
  const ct = (r.headers.get("content-type")||"").toLowerCase();
  if (!ct.includes("application/json")) throw new Error(`Bad content-type for ${url}`);
  return r.json();
}

function ymdInTZ(d = new Date(), tz = TZ){
  const s = d.toLocaleString("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s).trim();
}
function toLocalDateTime(iso, tz){
  const d = new Date(iso);
  const y = d.toLocaleString("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" }).split(",")[0];
  const t = d.toLocaleString("en-GB",{ timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false });
  return `${y} ${t}`;
}
function inSlotWindow(iso, tz, slot){
  if (!iso) return false;
  const d = new Date(iso);
  const ymd = ymdInTZ(new Date(d), tz);
  const today = ymdInTZ(new Date(), tz);
  if (ymd !== today) return false;
  const h = Number(d.toLocaleString("en-GB",{ timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false }).split(":")[0]);
  if (slot === "late") return h >= 0 && h < 10;
  if (slot === "am")   return h >= 10 && h < 15;
  if (slot === "pm")   return h >= 15 && h < 24;
  return true;
}

/* KV/Upstash GET (bez novih fajlova) */
async function kvGet(key){
  // 1) KV_REST_* (primarno – kompatibilno sa apply-learning/history)
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache:"no-store" });
      if (!r.ok) throw 0;
      const j = await r.json().catch(()=>null);
      const raw = j?.result ?? null;
      try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
    } catch {}
  }
  // 2) Upstash fallback
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, cache:"no-store" });
      if (!r.ok) throw 0;
      const j = await r.json().catch(()=>null);
      const raw = j?.result ?? null;
      try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
    } catch {}
  }
  return null;
}
