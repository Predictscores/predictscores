// pages/api/cron/rebuild.js
// Rebuild job: računa value-bets za današnji slot (late/am/pm),
// upisuje ih u KV (vbl:<YMD>:<slot> i vbl_full:<YMD>:<slot>)
// i vraća JSON kompatibilan sa postojećim UI-em – ali
// ➜ NIKAD ne briše postojeće KV ako danas nema rezultata (count=0).

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ------------------------------ vreme ------------------------------
function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = fmt.formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function toLocal(dateIso, tz = TZ) {
  try {
    const d = new Date(dateIso);
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    const parts = fmt.formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
    return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour), local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` };
  } catch {
    return { ymd: ymdInTZ(new Date(), tz), hm:"00:00", hour:0, local:"" };
  }
}
function slotOfHour(h){ return h < 10 ? "late" : h < 15 ? "am" : "pm"; }
function windowForSlot(slot){ if (slot==="late") return {hmin:0,hmax:9,label:"late"}; if (slot==="am") return {hmin:10,hmax:14,label:"am"}; return {hmin:15,hmax:23,label:"pm"}; }
function isWeekend(d=new Date(), tz = TZ){
  try { const wd=new Intl.DateTimeFormat("en-GB",{timeZone:tz,weekday:"short"}).format(d).toLowerCase(); return wd.startsWith("sat")||wd.startsWith("sun"); }
  catch { const wd=d.getUTCDay(); return wd===0||wd===6; }
}

// ------------------------------ ENV ------------------------------
function envBool(name, def=false){ const v = process.env[name]; if (v==null) return def; return /^(1|true|yes|on)$/i.test(String(v).trim()); }
function envNum(name, def){ const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }

const DEFAULT_LIMIT_WEEKDAY = envNum("SLOT_WEEKDAY_LIMIT", 15);
const DEFAULT_LIMIT_WEEKEND = envNum("SLOT_WEEKEND_LIMIT", 25);
const LIMIT_LATE_WEEKDAY    = envNum("SLOT_LATE_WEEKDAY_LIMIT", DEFAULT_LIMIT_WEEKDAY);
const VB_LIMIT              = envNum("VB_LIMIT", 0); // 0 = no cap

const PER_FIXTURE_ODDS_CAP  = envNum("ODDS_PER_FIXTURE_CAP", 1);
const MIN_ODDS              = envNum("MIN_ODDS", 1.01);
const EXCLUDE_WOMEN         = envBool("EXCLUDE_WOMEN", true);

// ------------------------------ API-Football ------------------------------
const API_BASE = process.env.API_FOOTBALL_BASE_URL || process.env.API_FOOTBALL || "https://v3.football.api-sports.io";
const API_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "";

function afHeaders(){
  const h = {};
  if (API_KEY) {
    h["x-apisports-key"] = API_KEY; // api-sports v3
    h["x-rapidapi-key"]  = API_KEY; // rapidapi fallback
  }
  return h;
}
async function getJSON(url){
  const r = await fetch(url, { headers: afHeaders() });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) throw new Error(`AF ${r.status} ${await r.text().catch(()=>r.statusText)}`);
  return ct.includes("application/json") ? await r.json() : JSON.parse(await r.text());
}
async function fetchFixturesByDate(ymd){
  if (!API_KEY) return [];
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/,"")}/fixtures?date=${encodeURIComponent(ymd)}`);
    if (!j || (j.errors && Object.keys(j.errors).length)) return [];
    return Array.isArray(j?.response) ? j.response : [];
  } catch { return []; }
}
async function fetchOddsForFixture(fixtureId){
  if (!API_KEY) return [];
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/,"")}/odds?fixture=${encodeURIComponent(fixtureId)}`);
    if (!j || (j.errors && Object.keys(j.errors).length)) return [];
    return Array.isArray(j?.response) ? j.response : [];
  } catch { return []; }
}
async function fetchPredictionForFixture(fixtureId){
  if (!API_KEY) return null;
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/,"")}/predictions?fixture=${encodeURIComponent(fixtureId)}`);
    if (!j || (j.errors && Object.keys(j.errors).length)) return null;
    const arr = Array.isArray(j?.response) ? j.response : [];
    return arr[0] || null;
  } catch { return null; }
}

// ------------------------------ 1X2 obrada ------------------------------
function median(nums){ const a = nums.filter(Number.isFinite).sort((x,y)=>x-y); if (!a.length) return NaN; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function extract1X2FromOdds(oddsPayload){
  const priceBy = { "1":[], "X":[], "2":[] };
  const seenBook = { "1":new Set(), "X":new Set(), "2":new Set() };
  for (const row of (Array.isArray(oddsPayload)?oddsPayload:[])){
    const bkm = row?.bookmaker?.name || row?.bookmaker?.id || "";
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets){
      const name = (bet?.name || "").toLowerCase();
      if (!/match\s*winner|1x2|winner/i.test(name)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals){
        const labelRaw = (v?.value || v?.label || "").toString().toLowerCase();
        let code = null;
        if (/^home/.test(labelRaw) || labelRaw === "1" || labelRaw === "1 (home)") code = "1";
        else if (/^draw/.test(labelRaw) || labelRaw === "x") code = "X";
        else if (/^away/.test(labelRaw) || labelRaw === "2" || labelRaw === "2 (away)") code = "2";
        if (!code) continue;
        const price = Number(v?.odd ?? v?.price ?? v?.odds);
        if (!Number.isFinite(price) || price < MIN_ODDS) continue;
        priceBy[code].push(price);
        if (bkm) seenBook[code].add(bkm);
      }
    }
  }
  const med = { "1": median(priceBy["1"]), "X": median(priceBy["X"]), "2": median(priceBy["2"]) };
  const books_count = { "1": seenBook["1"].size, "X": seenBook["X"].size, "2": seenBook["2"].size };
  return { med, books_count };
}
function fromPickCodeToLabel(code){ if (code==="1") return "Home"; if (code==="2") return "Away"; if (code==="X") return "Draw"; return String(code||""); }
function normalizeTeams(t){ const home = t?.home?.name || t?.home || t?.homeTeam || ""; const away = t?.away?.name || t?.away || t?.awayTeam || ""; return { home, away }; }

// ✅ Heuristika za ženske lige/timove (bez lažnih pogodaka na “FF/IF/F”)
function isWomenString(s=""){
  // eksplicitni markeri
  if (/\b(women|women's|ladies)\b/i.test(s)) return true;
  if (/\b(femenina|feminine|feminin|femminile)\b/i.test(s)) return true;
  if (/\b(dames|dam|kvinner|kvinn|kvinnor)\b/i.test(s)) return true;
  if (/\(w\)/i.test(s)) return true;
  if (/\sW$/i.test(s)) return true; // npr. "Chelsea W"
  if (/女子|여자/.test(s)) return true;
  return false;
}
function isWomensLeague(leagueName="", teams={home:"",away:""}){ return isWomenString(leagueName)||isWomenString(teams.home)||isWomenString(teams.away); }

// ------------------------------ KV (Upstash) ------------------------------
async function kvSetJSON_safe(key, value, ttlSec = null) {
  const base  = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN nisu postavljeni");

  // 1) Pokušaj preporučeni način: POST body
  const urlPOST = ttlSec!=null
    ? `${base.replace(/\/+$/,"")}/setex/${encodeURIComponent(key)}/${ttlSec}`
    : `${base.replace(/\/+$/,"")}/set/${encodeURIComponent(key)}`;

  let r = await fetch(urlPOST, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(value)
  }).catch(()=>null);

  if (r && r.ok) return true;

  // 2) Fallback na path varijantu (nekim setapima radi samo ovako)
  const urlPATH = ttlSec!=null
    ? `${base.replace(/\/+$/,"")}/setex/${encodeURIComponent(key)}/${ttlSec}/${encodeURIComponent(JSON.stringify(value))}`
    : `${base.replace(/\/+$/,"")}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;

  r = await fetch(urlPATH, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(()=>null);
  if (r && r.ok) return true;

  // 3) Ako i to ne uspe, baci jasan error
  const msg = r ? await r.text().catch(()=>String(r.status)) : "network-error";
  throw new Error(`KV set failed: ${msg.slice(0,200)}`);
}

// ------------------------------ handler ------------------------------
export default async function handler(req, res){
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const qSlot = (req.query.slot && String(req.query.slot)) || slotOfHour(toLocal(now, TZ).hour);
    const slotWin = windowForSlot(qSlot);
    const wantDebug = String(req.query.debug||"") === "1";

    // limiti
    let slotLimit = qSlot==="late"
      ? (isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : LIMIT_LATE_WEEKDAY)
      : (isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : DEFAULT_LIMIT_WEEKDAY);
    if (VB_LIMIT > 0) slotLimit = Math.min(slotLimit, VB_LIMIT);

    const debug = { ymd, slot:qSlot };

    // 1) fixtures → slot → ženske out
    const raw = await fetchFixturesByDate(ymd);
    debug.fixtures_total = Array.isArray(raw) ? raw.length : 0;

    let fixtures = (Array.isArray(raw)?raw:[])
      .map((r) => {
        const fx = r?.fixture || {};
        const lg = r?.league || {};
        const tm = r?.teams || {};
        const dateIso = fx?.date;
        const loc = toLocal(dateIso, TZ);
        const tms = normalizeTeams({ home: tm?.home?.name, away: tm?.away?.name });
        return {
          fixture_id: fx?.id,
          date_utc: dateIso,
          local_hour: loc.hour,
          local_str: `${loc.ymd} ${loc.hm}`,
          league: { id: lg?.id, name: lg?.name, country: lg?.country },
          teams: { home: tms.home, away: tms.away }
        };
      })
      .filter(fx => fx.fixture_id && fx.date_utc != null);

    debug.after_basic = fixtures.length;

    fixtures = fixtures.filter(fx => fx.local_hour >= slotWin.hmin && fx.local_hour <= slotWin.hmax);
    debug.after_slot = fixtures.length;

    fixtures = fixtures.filter(fx => EXCLUDE_WOMEN ? !isWomensLeague(fx.league?.name, {home:fx.teams.home, away:fx.teams.away}) : true);
    debug.after_gender_filter = fixtures.length;

    fixtures = fixtures.slice(0, Math.max(1, slotLimit, 1) * 3);
    debug.considered = fixtures.length;

    // 2) odds/predictions → EV
    const perFixtureCap = Math.max(1, PER_FIXTURE_ODDS_CAP);
    const recs = [];
    for (const fx of fixtures){
      try {
        const oddsPayload = await fetchOddsForFixture(fx.fixture_id);
        const oddsRows = Array.isArray(oddsPayload) ? oddsPayload.slice(0, perFixtureCap) : [];
        const { med, books_count: booksCountSlice } = extract1X2FromOdds(oddsRows);
        if (!Number.isFinite(med["1"]) && !Number.isFinite(med["X"]) && !Number.isFinite(med["2"])) continue;

        let model = { "1": null, "X": null, "2": null };
        const pred = await fetchPredictionForFixture(fx.fixture_id).catch(()=>null);
        const comp = pred?.predictions || pred?.prediction || pred || {};
        const pHome = Number(String(comp?.percent?.home || comp?.home_percent || "").replace("%",""));
        const pDraw = Number(String(comp?.percent?.draw || comp?.draw_percent || "").replace("%",""));
        const pAway = Number(String(comp?.percent?.away || comp?.away_percent || "").replace("%",""));
        if (Number.isFinite(pHome)) model["1"] = pHome/100;
        if (Number.isFinite(pDraw)) model["X"] = pDraw/100;
        if (Number.isFinite(pAway)) model["2"] = pAway/100;

        const implied = { "1": med["1"] ? 1/med["1"] : null, "X": med["X"] ? 1/med["X"] : null, "2": med["2"] ? 1/med["2"] : null };
        const sumImp = (implied["1"]||0) + (implied["X"]||0) + (implied["2"]||0);
        const probs = sumImp > 0 ? { "1": (implied["1"]||0)/sumImp, "X": (implied["X"]||0)/sumImp, "2": (implied["2"]||0)/sumImp } : { "1":null,"X":null,"2":null };
        const modelProb = { "1": Number.isFinite(model["1"])?model["1"]:probs["1"], "X": Number.isFinite(model["X"])?model["X"]:probs["X"], "2": Number.isFinite(model["2"])?model["2"]:probs["2"] };

        const evBy = {
          "1": Number.isFinite(med["1"]) && Number.isFinite(modelProb["1"]) ? (med["1"] * modelProb["1"] - 1) : -Infinity,
          "X": Number.isFinite(med["X"]) && Number.isFinite(modelProb["X"]) ? (med["X"] * modelProb["X"] - 1) : -Infinity,
          "2": Number.isFinite(med["2"]) && Number.isFinite(modelProb["2"]) ? (med["2"] * modelProb["2"] - 1) : -Infinity,
        };
        let best = "1"; if (evBy["X"] > evBy[best]) best = "X"; if (evBy["2"] > evBy[best]) best = "2";

        const bestPrice = med[best]; if (!Number.isFinite(bestPrice) || bestPrice < MIN_ODDS) continue;
        const mp = modelProb[best]; if (!Number.isFinite(mp)) continue;

        const confidence_pct = Math.round(Math.max(0, Math.min(100, mp <= 1 ? mp*100 : mp)));
        const leagueName = fx.league?.name || ""; const leagueCountry = fx.league?.country || "";

        const rec = {
          fixture_id: fx.fixture_id,
          market: "1X2",
          pick: fromPickCodeToLabel(best),
          pick_code: best,
          selection_label: fromPickCodeToLabel(best),
          model_prob: Number(mp.toFixed(4)),
          confidence_pct,
          odds: { price: Number(bestPrice), books_count: 0 },
          league: { id: fx.league?.id, name: leagueName, country: leagueCountry },
          league_name: leagueName, league_country: leagueCountry,
          teams: { home: fx.teams.home, away: fx.teams.away },
          home: fx.teams.home, away: fx.teams.away,
          kickoff: fx.local_str, kickoff_utc: fx.date_utc,
          _implied: Number((1/Number(bestPrice)).toFixed(4)),
          _ev: Number((bestPrice * mp - 1).toFixed(12)),
          source_meta: { books_counts_raw: {} }
        };

        // precizniji books_count na celom payloadu
        const { books_count: booksCountAll } = extract1X2FromOdds(Array.isArray(oddsPayload) ? oddsPayload : []);
        rec.odds.books_count = (booksCountAll[best] || booksCountSlice[best] || 0);
        rec.source_meta.books_counts_raw = {
          "1": (booksCountAll["1"] ?? booksCountSlice["1"] ?? 0),
          "X": (booksCountAll["X"] ?? booksCountSlice["X"] ?? 0),
          "2": (booksCountAll["2"] ?? booksCountSlice["2"] ?? 0)
        };

        recs.push(rec);
      } catch { /* skip fixture on error */ }
    }

    debug.recs = recs.length;

    // 3) Rangiranje i preseci: "full" i "slim"
    const byEV = [...recs].sort((a,b)=> (b._ev - a._ev) || (b.confidence_pct - a.confidence_pct));
    const fullCount = Math.max(slotLimit, Math.min(byEV.length, 100));
    const slimCount = Math.min(slotLimit, byEV.length);
    const fullList = byEV.slice(0, fullCount);
    const slimList = byEV.slice(0, slimCount);

    // 4) Upis u KV – SAMO ako imamo bar nešto (ne praznimo KV kad je 0!)
    let wrote = false;
    if (slimList.length > 0 || fullList.length > 0) {
      const keySlim = `vbl:${ymd}:${qSlot}`;
      const keyFull = `vbl_full:${ymd}:${qSlot}`;
      const payloadSlim = { items: slimList, football: slimList, value_bets: slimList };
      const payloadFull = { items: fullList, football: fullList, value_bets: fullList };
      await kvSetJSON_safe(keySlim, payloadSlim /*, 72*3600 */);
      await kvSetJSON_safe(keyFull, payloadFull /*, 72*3600 */);
      await kvSetJSON_safe(`vb:day:${ymd}:last`, { key: keySlim });
      wrote = true;
    }

    // 5) Odgovor
    return res.status(200).json({
      ok: true,
      slot: qSlot,
      ymd,
      count: slimList.length,
      count_full: fullList.length,
      wrote, // da znaš da li je KV zaista ažuriran
      football: slimList,
      ...(wantDebug ? { debug } : {})
    });

  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
