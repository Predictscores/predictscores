// pages/api/value-bets.js
// Seed = fixtures (API_FOOTBALL_KEY) + KV keš kvota (od refresh-odds).
// U seed ulaze SAMO mečevi sa kvotom >= MIN_ODDS i bez U/Women/Reserves liga.

export const config = { api: { bodyParser: false } };

const TZ   = process.env.TZ_DISPLAY || "Europe/Belgrade";
const BASE = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";
const FIX_KEY = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL;

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const MIN_ODDS = Number(process.env.MIN_ODDS || 1.5);

// BAN: U-lige, Women, Reserves, Youth, Academy, Development
const BAN_REGEX = /\bU\s*-?\s*\d{1,2}\b|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

export default async function handler(req, res){
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    if (!["am","pm","late"].includes(slot)) return res.status(200).json({ ok:false, error:"invalid slot", value_bets: [] });

    if (!FIX_KEY) return res.status(200).json({ ok:false, error:"API_FOOTBALL_KEY missing", value_bets: [] });

    const ymd = ymdInTZ(new Date(), TZ);

    // fixtures
    const fj = await httpJSON(`${BASE}/fixtures?date=${ymd}&timezone=${encodeURIComponent(TZ)}`, FIX_KEY);
    const fixtures = Array.isArray(fj?.response) ? fj.response : [];

    // filtriraj po slotu + BAN
    const list = fixtures.filter(fx => {
      const name  = String(fx?.league?.name || "");
      const round = String(fx?.league?.round || "");
      const stage = String(fx?.league?.stage || "");
      if (BAN_REGEX.test(`${name} ${round} ${stage}`)) return false;
      return inSlotWindow(fx?.fixture?.date, TZ, slot);
    });

    const out = [];
    for (const row of list) {
      const fid = row?.fixture?.id;
      if (!fid) continue;

      const odds = await kvGet(`odds:fixture:${ymd}:${fid}`);
      const best = Number(odds?.best) || null;
      if (!(Number.isFinite(best) && best >= MIN_ODDS)) continue;

      const iso = row?.fixture?.date ? String(row.fixture.date).replace(" ","T") : null;
      const dt  = iso ? toLocalDateTime(iso, TZ) : null;

      out.push({
        fixture_id: fid,
        league: {
          id: row?.league?.id ?? null,
          name: row?.league?.name || null,
          country: row?.league?.country || null,
          round: row?.league?.round || null,
          stage: row?.league?.stage || null,
        },
        teams: {
          home: { id: row?.teams?.home?.id ?? null, name: String(row?.teams?.home?.name || "") || null },
          away: { id: row?.teams?.away?.id ?? null, name: String(row?.teams?.away?.name || "") || null },
        },
        datetime_local: dt ? { starting_at: { date_time: dt } } : null,

        market: "1X2",
        market_label: "1X2",
        selection: odds?.fav || null,

        market_odds: best,
        market_odds_decimal: best,
        odds: { best, match_winner: odds?.match_winner || { home:null, draw:null, away:null } },

        confidence_pct: 50,
      });
    }

    const source = out.length ? "fixtures+odds(cache)" : "fixtures-only(no-odds>=min)";
    return res.status(200).json({ ok:true, disabled:false, slot, value_bets: out, source });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e), value_bets: [] });
  }
}

/* helpers */

async function httpJSON(url, key){
  const r = await fetch(url, { headers: { "x-apisports-key": key, "cache-control":"no-store" } });
  const ct = (r.headers.get("content-type")||"").toLowerCase();
  if (!ct.includes("application/json")) throw new Error(`Bad content-type for ${url}`);
  return r.json();
}
function ymdInTZ(d=new Date(), tz=TZ){
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

// KV primarno, Upstash fallback
async function kvGet(key){
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${KV_TOKEN}` }, cache:"no-store" });
      if (r.ok) {
        const j = await r.json().catch(()=>null);
        const raw = j?.result ?? null;
        try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
      }
    } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${UP_TOKEN}` }, cache:"no-store" });
      if (r.ok) {
        const j = await r.json().catch(()=>null);
        const raw = j?.result ?? null;
        try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
      }
    } catch {}
  }
  return null;
}
