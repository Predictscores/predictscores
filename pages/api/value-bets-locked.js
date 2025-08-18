// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/** ========= ENV / KONFIG ========= **/
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

const VB_LIMIT   = parseInt(process.env.VB_LIMIT || "25", 10);
const LEAGUE_CAP = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);

const MIN_ODDS       = 1.50;
const OU_MAX_ODDS    = 2.60;
const BTTS_MAX_ODDS  = 2.80;

const WINDOW_HOURS      = parseInt(process.env.VB_WINDOW_HOURS || "72", 10);
const FREEZE_MIN_BEFORE = parseInt(process.env.VB_FREEZE_MIN || "30", 10);

const OUTLIER_MULT = 1.25;

const TRUSTED_BOOKIES = (process.env.TRUSTED_BOOKIES ||
  "pinnacle,bet365,betfair,unibet,bwin,william hill,marathonbet,1xbet,888sport,ladbrokes,betway,betsson,10bet,sportingbet"
).split(",").map(s => s.trim().toLowerCase());

const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "1") === "1";
const TRUSTED_FALLBACK_MIN = parseInt(process.env.ODDS_TRUSTED_FALLBACK_MIN || "1", 10);

// Privremena sigurnosna mreža da UI ne ostaje prazan
const LOCKED_FALLBACK_TO_LIVE = String(process.env.LOCKED_FALLBACK_TO_LIVE || "0") === "1";

// API-FOOTBALL key (za konsenzus/“re-check” oddsa)
const AF_KEY = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

/** ========= UTIL ========= **/
const isoNow = () => new Date().toISOString();

function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d); // YYYY-MM-DD
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function hmInTZ(d=new Date(), tz=TZ) {
  try {
    const p = new Intl.DateTimeFormat("en-GB",{ timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false })
      .formatToParts(d).reduce((a,x)=>((a[x.type]=x.value),a),{});
    return { h:+p.hour, m:+p.minute };
  } catch { return { h:d.getHours(), m:d.getMinutes() }; }
}

async function kvGET(key){
  const url = `${KV_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json().catch(()=>null);
    const val = (j && typeof j === "object" && "result" in j) ? j.result : j;
    try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return val; }
  }
  const t = await r.text().catch(()=>null);
  try { return JSON.parse(t); } catch { return t; }
}

// AF helpers
async function afGET(path){
  if (!AF_KEY) return null;
  const base = "https://v3.football.api-sports.io";
  const r = await fetch(`${base}${path}`, { headers: { "x-apisports-key": AF_KEY } });
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  return j?.response || null;
}

/** ========= ODDS KONSENZUS ========= **/
const median = a => { const x=[...a].sort((p,q)=>p-q); const n=x.length; return n&1 ? x[(n-1)>>1] : (x[n/2-1]+x[n/2])/2; };
const isTrusted = name => TRUSTED_BOOKIES.some(b => String(name||"").toLowerCase().includes(b));

function normalizeMarketName(name="") {
  const s = name.toLowerCase();
  if (s.includes("match winner") || s.includes("1x2")) return "1X2";
  if (s.includes("both teams to score")) return "BTTS";
  if (s.includes("over/under") || s.includes("goals over/under")) return "OU";
  if (s.includes("half time/full time") || s.includes("ht/ft")) return "HTFT";
  return name;
}
function mapHTFTValue(vRaw) {
  const s = String(vRaw||"").toUpperCase().replace(/\s+/g,"");
  const r = s.replace(/^HOME/,"H").replace(/\/HOME/,"/H")
            .replace(/^AWAY/,"A").replace(/\/AWAY/,"/A")
            .replace(/^DRAW/,"D").replace(/\/DRAW/,"/D")
            .replace(/^1/,"H").replace(/\/1/,"/H")
            .replace(/^2/,"A").replace(/\/2/,"/A")
            .replace(/^X/,"D").replace(/\/X/,"/D");
  const OK = ["H/H","H/D","H/A","D/H","D/D","D/A","A/H","A/D","A/A"];
  return OK.includes(r) ? r : null;
}
function consensusFrom(arr){
  const N = arr.length;
  if (N >= 3) return median(arr);
  if (N === 2) {
    const ratio = Math.max(arr[0],arr[1]) / Math.min(arr[0],arr[1]);
    return ratio <= 1.15 ? (arr[0]+arr[1])/2 : Math.min(arr[0],arr[1]);
  }
  return arr[0] ?? null;
}
function readConsensusOdds(oddsResponse) {
  const slot = () => ({ arr:[], count:0, odds:null });
  const out = {
    "1X2": { H:slot(), D:slot(), A:slot() },
    "BTTS": { YES:slot(), NO:slot() },
    "OU": { OVER25:slot(), UNDER25:slot() },
    "HTFT": { "H/H":slot(),"H/D":slot(),"H/A":slot(),"D/H":slot(),"D/D":slot(),"D/A":slot(),"A/H":slot(),"A/D":slot(),"A/A":slot() }
  };
  let usedTrusted = TRUSTED_ONLY;

  for (const pass of [0,1]) {
    for (const book of (oddsResponse || [])) {
      for (const bm of (book?.bookmakers || [])) {
        if (usedTrusted && !isTrusted(bm?.name)) continue;
        for (const bet of (bm?.bets || [])) {
          const m = normalizeMarketName(bet?.name || "");
          for (const v of (bet?.values || [])) {
            const val = String(v?.value || v?.label || "").toLowerCase();
            const odd = Number(v?.odd || v?.odds || v?.price);
            if (!Number.isFinite(odd) || odd <= 1.0) continue;

            if (m === "1X2") {
              const u = val.includes("home") || val==="1" ? "H" : val.includes("draw") || val==="x" ? "D" : val.includes("away") || val==="2" ? "A" : null;
              if (u) out["1X2"][u].arr.push(odd);
            } else if (m === "BTTS") {
              const u = val.includes("yes") ? "YES" : val.includes("no") ? "NO" : null;
              if (u) out["BTTS"][u].arr.push(odd);
            } else if (m === "OU") {
              const is25 = val.includes("over 2.5") || val.includes("under 2.5") || (val === "2.5" && (v?.handicap==2.5 || v?.line==2.5));
              if (!is25) continue;
              if (val.includes("over")) out["OU"].OVER25.arr.push(odd);
              else out["OU"].UNDER25.arr.push(odd);
            } else if (m === "HTFT") {
              const key = mapHTFTValue(v?.value || v?.label);
              if (key) out["HTFT"][key].arr.push(odd);
            }
          }
        }
      }
    }
    const totalCells =
      out["1X2"].H.arr.length + out["1X2"].D.arr.length + out["1X2"].A.arr.length +
      out["BTTS"].YES.arr.length + out["BTTS"].NO.arr.length +
      out["OU"].OVER25.arr.length + out["OU"].UNDER25.arr.length;
    if (usedTrusted && totalCells < TRUSTED_FALLBACK_MIN) {
      for (const grp of Object.values(out)) for (const k of Object.values(grp)) k.arr = [];
      usedTrusted = false; continue;
    }
    break;
  }

  for (const grpName of Object.keys(out)) {
    for (const k of Object.keys(out[grpName])) {
      const arr = out[grpName][k].arr;
      out[grpName][k].count = Array.isArray(arr) ? arr.length : 0;
      out[grpName][k].odds  = out[grpName][k].count ? consensusFrom(arr) : null;
      delete out[grpName][k].arr;
    }
  }
  return out;
}

/** ========= MODEL / FORMAT ========= **/
const impliedFromOdds = odds => (Number(odds) > 0) ? (1/Number(odds)) : null;
const edgePP = (modelProb, impliedProb) => {
  if (!Number.isFinite(modelProb) || !Number.isFinite(impliedProb) || impliedProb<=0) return null;
  return (modelProb / impliedProb - 1) * 100;
};
function plausibleOddsRange(prob){
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
  const fair = 1/prob;
  return [fair * 0.80, fair * OUTLIER_MULT];
}
function isExcludedLeagueOrTeam(p){
  const ln = `${p?.league?.name||""}`.toLowerCase();
  const tnH = `${p?.teams?.home||p?.home||""}`.toLowerCase();
  const tnA = `${p?.teams?.away||p?.away||""}`.toLowerCase();
  if (ln.includes("women") || ln.includes("u19") || ln.includes("reserve")) return true;
  if (tnH.includes("women") || tnA.includes("women")) return true;
  return false;
}
function adjustedConfidence(p){
  const base = Number(p?.confidence_pct || 0);
  const books = Number(p?.bookmakers_count || 0);
  const tweak = Math.max(-3, Math.min(3, (books-5)*0.3));
  return Math.round(Math.max(0, Math.min(100, base + tweak)));
}

/** ========= LOCKED HANDLER ========= **/
async function readLockedSnapshot() {
  const now = new Date();
  const keysToTry = [
    `vb:day:${ymdInTZ(now, TZ)}:last`,        // CET/Belgrade
    `vb:day:${ymdInTZ(now, "UTC")}:last`,     // UTC fallback
  ];
  for (const key of keysToTry) {
    const val = await kvGET(key);
    if (Array.isArray(val) && val.length) {
      return { arr: val, fromKey: key };
    }
  }
  return { arr: [], fromKey: keysToTry.join(" | ") };
}

export default async function handler(req, res){
  const debug = { triedKeys: [], step: [] };
  try {
    const now = new Date();
    const nowMs = +now;
    const endMs = nowMs + WINDOW_HOURS*3600*1000;

    // 1) Probaj snapshot (CET pa UTC)
    let { arr, fromKey } = await readLockedSnapshot();
    debug.triedKeys.push(fromKey);
    let source = "locked-cache";

    // 2) Ako nema → probaj rebuild + kratak retry
    if (!Array.isArray(arr) || !arr.length) {
      source = "ensure-wait";
      debug.step.push("rebuild");
      try { await fetch(`${req.headers["x-forwarded-proto"]||"https"}://${req.headers.host}/api/cron/rebuild`); } catch {}
      await new Promise(r => setTimeout(r, 350));
      ({ arr, fromKey } = await readLockedSnapshot());
      debug.triedKeys.push(fromKey);
    }

    // 3) Ako i dalje nema i dozvoljen fallback → uzmi live generator
    if ((!Array.isArray(arr) || !arr.length) && LOCKED_FALLBACK_TO_LIVE) {
      debug.step.push("live-fallback");
      try {
        const r = await fetch(`${req.headers["x-forwarded-proto"]||"https"}://${req.headers.host}/api/value-bets`);
        if (r.ok) {
          const j = await r.json().catch(()=>null);
          if (j?.value_bets?.length) {
            arr = j.value_bets;
            source = "live-fallback";
          }
        }
      } catch {}
    }

    // 4) Ako i dalje nema — vrati prazno
    if (!Array.isArray(arr) || !arr.length) {
      return res.status(200).json({ value_bets: [], built_at: isoNow(), day: ymdInTZ(now, TZ), source, debug });
    }

    // 5) Priprema listе + zaštite na kvotama + “Zašto”
    const byLeague = new Map();
    const prepared = [];
    for (const p0 of arr) {
      try {
        const p = { ...p0 };
        const dt = new Date((p?.datetime_local?.starting_at?.date_time || "").replace(" ","T"));
        const ms = +dt || 0;
        if (!ms || ms > endMs) continue;
        const minsToKick = Math.round((ms - nowMs)/60000);
        if (minsToKick <= FREEZE_MIN_BEFORE) continue;

        if (isExcludedLeagueOrTeam(p)) continue;
        const lkey = `${p?.league?.id||""}`; const c = byLeague.get(lkey)||0;
        if (c >= LEAGUE_CAP) continue;

        // korekcija kvote ako “štrči”
        let odds = Number(p?.market_odds || 0);
        const market = String(p?.market || "").toUpperCase();
        const cat    = String(p?.market_label || "").toUpperCase();

        let needsFix = !Number.isFinite(odds) || odds <= 1.0;
        const prob = Number(p?.model_prob || 0);
        const window = plausibleOddsRange(prob);
        if (!needsFix && window && (odds < window[0] || odds > window[1])) needsFix = true;
        if (!needsFix && cat === "OU"   && odds > OU_MAX_ODDS)   needsFix = true;
        if (!needsFix && cat === "BTTS" && odds > BTTS_MAX_ODDS) needsFix = true;

        if (needsFix && AF_KEY && p.fixture_id) {
          const resp = await afGET(`/odds?fixture=${p.fixture_id}`);
          const cons = readConsensusOdds(resp);
          if (cat === "1X2") {
            const pick = p.selection === "1" ? "H" : p.selection === "X" ? "D" : p.selection === "2" ? "A" : null;
            const cell = pick ? cons["1X2"][pick] : null;
            if (cell?.odds) { odds = cell.odds; p.bookmakers_count = cell.count; }
          } else if (cat === "OU") {
            const cell = p.selection?.toUpperCase() === "OVER" ? cons["OU"].OVER25 : cons["OU"].UNDER25;
            if (cell?.odds) { odds = cell.odds; p.bookmakers_count = cell.count; }
          } else if (cat === "BTTS") {
            const cell = p.selection?.toUpperCase() === "YES" ? cons["BTTS"].YES : cons["BTTS"].NO;
            if (cell?.odds) { odds = cell.odds; p.bookmakers_count = cell.count; }
          }
        }

        if (!Number.isFinite(odds) || odds < MIN_ODDS) continue;
        if (cat === "OU"   && odds > OU_MAX_ODDS) continue;
        if (cat === "BTTS" && odds > BTTS_MAX_ODDS) continue;

        const implied = impliedFromOdds(odds);
        const evpp = edgePP(Number(p?.model_prob||0), implied);
        p.market_odds  = Number(odds.toFixed(2));
        p.implied_prob = implied;
        p.edge_pp      = evpp;

        let explain = p.explain || {};
        const insight = await kvGET(`vb:insight:${p.fixture_id}`).catch(()=>null);
        if (insight?.line) explain = { ...explain, summary: insight.line };

        const conf = adjustedConfidence(p);

        prepared.push({ ...p, explain, confidence_pct: conf });
        byLeague.set(lkey, (byLeague.get(lkey)||0) + 1);
        if (prepared.length >= VB_LIMIT) break;
      } catch { /* pojedinačni meč preskačemo */ }
    }

    return res.status(200).json({
      value_bets: prepared,
      built_at: isoNow(),
      day: ymdInTZ(now, TZ),
      source,
      debug
    });
  } catch (e) {
    return res.status(200).json({
      value_bets: [],
      built_at: isoNow(),
      day: ymdInTZ(new Date(), TZ),
      source: "error",
      error: String(e?.message||e)
    });
  }
}
