// pages/api/value-bets-locked.js
// Čita zaključani snapshot iz KV i pravi finalnu stabilnu listu za UI.
// Uklonjeni hard-capovi za OU/BTTS – sada se oslanjamo na trusted-consensus iz generatora.
// Filteri: prozor 72h, freeze 30min, league cap, min kvota, isključenja.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

const VB_LIMIT   = parseInt(process.env.VB_LIMIT || "25", 10);
const LEAGUE_CAP = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const WINDOW_HOURS      = parseInt(process.env.VB_WINDOW_HOURS || "72", 10);
const FREEZE_MIN_BEFORE = parseInt(process.env.VB_FREEZE_MIN || "30", 10);

const MIN_ODDS = parseFloat(process.env.MIN_ODDS || "1.5");

// opcioni fallback za nekoliko MODEL pickova bez kvote (default: off)
const ALLOW_MODEL_FALLBACK = Number(process.env.ALLOW_MODEL_FALLBACK || "0") === 1;
const MODEL_FALLBACK_CAP   = parseInt(process.env.MODEL_FALLBACK_CAP || "5", 10);

const isoNow = () => new Date().toISOString();
function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d);
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}

// ---------- KV helpers ----------
async function kvGETraw(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json().catch(()=>null);
    return (j && typeof j==="object" && "result" in j) ? j.result : j;
  }
  return await r.text().catch(()=>null);
}

function normalizeSnapshot(raw) {
  try {
    let v = raw;
    if (typeof v === "string") {
      try { const a = JSON.parse(v); if (Array.isArray(a)) return a; v = a; } catch {}
    }
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner === "string") {
          try { const a = JSON.parse(inner); if (Array.isArray(a)) return a; } catch {}
        }
        if (Array.isArray(inner)) return inner;
      }
    }
  } catch {}
  return [];
}

// ---------- domain ----------
function isExcludedLeagueOrTeam(p){
  const ln = `${p?.league?.name||""}`.toLowerCase();
  const th = `${p?.teams?.home?.name||p?.teams?.home||""}`.toLowerCase();
  const ta = `${p?.teams?.away?.name||p?.teams?.away||""}`.toLowerCase();
  return ln.includes("women") || ln.includes("u19") || ln.includes("reserve") || th.includes("women") || ta.includes("women");
}
const impliedFromOdds = o => (Number(o)>0 ? 1/Number(o) : null);
const edgePP = (mp,ip) => (!Number.isFinite(mp)||!Number.isFinite(ip)||ip<=0)?null:((mp/ip-1)*100);

// ---------- handler ----------
export default async function handler(req, res){
  try {
    const now = new Date();
    const dayCET = ymdInTZ(now, TZ);
    const dayUTC = ymdInTZ(now, "UTC");

    // 1) čitanje CET pa UTC
    let rawCET = await kvGETraw(`vb:day:${dayCET}:last`);
    let arr = normalizeSnapshot(rawCET);
    let source = "locked-cache";

    if (!arr.length) {
      const rawUTC = await kvGETraw(`vb:day:${dayUTC}:last`);
      arr = normalizeSnapshot(rawUTC);
      source = arr.length ? "locked-cache-utc" : "ensure-wait";
    }
    if (!arr.length) {
      return res.status(200).json({ value_bets: [], built_at: isoNow(), day: dayCET, source });
    }

    // 2) filtriranje
    const out = [];
    const byLeague = new Map();
    const nowMs = +now;
    const endMs = nowMs + WINDOW_HOURS*3600*1000;
    let modelFallbackUsed = 0;

    for (const p0 of arr) {
      try {
        const p = { ...p0 };

        // vreme
        const t = String(p?.datetime_local?.starting_at?.date_time || "").replace(" ","T");
        const ms = +new Date(t);
        if (!ms || ms > endMs) continue;
        const mins = Math.round((ms - nowMs)/60000);
        if (mins <= FREEZE_MIN_BEFORE) continue;

        // league cap & exclude
        if (isExcludedLeagueOrTeam(p)) continue;
        const lkey = `${p?.league?.id||""}`;
        const c = byLeague.get(lkey) || 0;
        if (c >= LEAGUE_CAP) continue;

        // kvota/logika
        let odds = Number(p?.market_odds);
        if (!Number.isFinite(odds)) {
          if (ALLOW_MODEL_FALLBACK && modelFallbackUsed < MODEL_FALLBACK_CAP) {
            modelFallbackUsed++;
          } else {
            continue;
          }
        } else if (odds < MIN_ODDS) {
          continue;
        }

        const ip = impliedFromOdds(odds);
        const ev = edgePP(Number(p?.model_prob||0), ip);

        // explain
        let line = p?.explain?.summary || null;
        if (!line) {
          const h = p?.teams?.home?.name || p?.teams?.home || "Home";
          const a = p?.teams?.away?.name || p?.teams?.away || "Away";
          const mrk = `${p?.market_label || p?.market || ""}`.toUpperCase();
          const sel = `${p?.selection || ""}`;
          line = `Duel: ${h} vs ${a}. Predlog: ${mrk} – ${sel}.`;
        }
        const explain = { ...(p.explain||{}), summary: line };

        out.push({
          ...p,
          market_odds: Number.isFinite(odds) ? Number(odds.toFixed(2)) : null,
          implied_prob: ip,
          edge_pp: ev,
          explain
        });

        byLeague.set(lkey, c+1);
        if (out.length >= VB_LIMIT) break;
      } catch { /* skip */ }
    }

    return res.status(200).json({
      value_bets: out,
      built_at: isoNow(),
      day: dayCET,
      source
    });
  } catch (e) {
    return res.status(200).json({
      value_bets: [],
      built_at: isoNow(),
      day: ymdInTZ(new Date(), TZ),
      source: "error",
      error: String(e?.message || e)
    });
  }
}
