// pages/api/cron/rebuild.js
// Rebuild job: izračuna value-bets za današnji slot (late/am/pm),
// upiše rezultate u KV (vbl:<YMD>:<slot> i vbl_full:<YMD>:<slot>),
// i vrati JSON kompatibilan sa postojećim UI-em.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ------------------------------ vremenski helpers ------------------------------
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
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    const parts = fmt.formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
    return {
      ymd: `${parts.year}-${parts.month}-${parts.day}`,
      hm: `${parts.hour}:${parts.minute}`,
      hour: Number(parts.hour),
      local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
    };
  } catch {
    return { ymd: ymdInTZ(new Date(), tz), hm:"00:00", hour:0, local:"" };
  }
}
function slotOfHour(h){ return h < 10 ? "late" : h < 15 ? "am" : "pm"; } // late 00–09, am 10–14, pm 15–23
function windowForSlot(slot){
  if (slot === "late") return { hmin:0,  hmax:9,  label:"late" };
  if (slot === "am")   return { hmin:10, hmax:14, label:"am"   };
  return { hmin:15, hmax:23, label:"pm" };
}
function isWeekend(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" });
    const wd = fmt.format(d).toLowerCase();
    return wd.startsWith("sat") || wd.startsWith("sun");
  } catch {
    const wd = d.getUTCDay();
    return wd === 0 || wd === 6;
  }
}

// ------------------------------ ENV / limiti ------------------------------
function envBool(name, def=false){
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function envNum(name, def){
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

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
  h["x-apisports-key"] = API_KEY;  // api-sports v3
  h["x-rapidapi-key"]  = API_KEY;  // rapidapi fallback
  return h;
}
async function getJSON(url){
  const r = await fetch(url, { headers: afHeaders() });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : JSON.parse(await r.text());
  return body;
}
async function fetchFixturesByDate(ymd){
  if (!API_KEY) return [];
  const url = `${API_BASE.replace(/\/+$/,"")}/fixtures?date=${encodeURIComponent(ymd)}`;
  const j = await getJSON(url).catch(()=>null);
  if (!j || (j.errors && Object.keys(j.errors).length)) return [];
  return Array.isArray(j?.response) ? j.response : [];
}
async function fetchOddsForFixture(fixtureId){
  if (!API_KEY) return [];
  const url = `${API_BASE.replace(/\/+$/,"")}/odds?fixture=${encodeURIComponent(fixtureId)}`;
  const j = await getJSON(url).catch(()=>null);
  if (!j || (j.errors && Object.keys(j.errors).length)) return [];
  return Array.isArray(j?.response) ? j.response : [];
}
async function fetchPredictionForFixture(fixtureId){
  if (!API_KEY) return null;
  const url = `${API_BASE.replace(/\/+$/,"")}/predictions?fixture=${encodeURIComponent(fixtureId)}`;
  const j = await getJSON(url).catch(()=>null);
  if (!j || (j.errors && Object.keys(j.errors).length)) return null;
  const arr = Array.isArray(j?.response) ? j.response : [];
  return arr[0] || null;
}

// ------------------------------ obrada 1X2 ------------------------------
function median(nums){
  const a = nums.filter(n => Number.isFinite(n)).sort((x,y)=>x-y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
}
function extract1X2FromOdds(oddsPayload){
  const priceBy = { "1":[], "X":[], "2":[] };
  const seenBook = { "1":new Set(), "X":new Set(), "2":new Set() };
  for (const row of oddsPayload){
    const bkm = row?.bookmaker?.name || row?.bookmaker?.id || "";
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets){
      const name = (bet?.name || "").toLowerCase();
      if (!/match\s*winner|1x2|winner/i.test(name)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals){
        const labelRaw = (v?.value || v?.label || "").toString();
        let code = null;
        const low = labelRaw.toLowerCase();
        if (/^home/.test(low) || low === "1" || low === "1 (home)") code = "1";
        else if (/^draw/.test(low) || low === "x") code = "X";
        else if (/^away/.test(low) || low === "2" || low === "2 (away)") code = "2";
        if (!code) continue;
        const price = Number(v?.odd ?? v?.price ?? v?.odds);
        if (!Number.isFinite(price) || price < MIN_ODDS) continue;
        priceBy[code].push(price);
        if (bkm) seenBook[code].add(bkm);
      }
    }
  }
  const med = {
    "1": median(priceBy["1"]),
    "X": median(priceBy["X"]),
    "2": median(priceBy["2"])
  };
  const books_count = {
    "1": seenBook["1"].size,
    "X": seenBook["X"].size,
    "2": seenBook["2"].size
  };
  return { med, books_count };
}
function fromPickCodeToLabel(code){
  if (code === "1") return "Home";
  if (code === "2") return "Away";
  if (code === "X") return "Draw";
  return String(code || "");
}
function normalizeTeams(t){
  const home = t?.home?.name || t?.home || t?.homeTeam || "";
  const away = t?.away?.name || t?.away || t?.awayTeam || "";
  return { home, away };
}
function isWomensLeague(leagueName="", teams={home:"",away:""}){
  const n = (leagueName || "").toLowerCase();
  const h = (teams.home || "").toLowerCase();
  const a = (teams.away || "").toLowerCase();
  const pat = /(women|femenina|feminine|feminin|femminile|dam|kvinn|女子|여자|f|w$|\bw\b)/i;
  return pat.test(n) || pat.test(h) || pat.test(a);
}

// ------------------------------ KV (Upstash REST: POST body za JSON!) ------------------------------
async function kvSetJSON(key, value, ttlSec = null) {
  const base  = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN nisu postavljeni");

  const url = ttlSec != null
    ? `${base.replace(/\/+$/,"")}/setex/${encodeURIComponent(key)}/${ttlSec}`
    : `${base.replace(/\/+$/,"")}/set/${encodeURIComponent(key)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain;charset=UTF-8"
    },
    body: JSON.stringify(value)
  });

  const ct = r.headers.get("content-type") || "";
  const resp = ct.includes("application/json") ? await r.json().catch(()=>null) : null;
  if (!r.ok || (resp && resp.error)) {
    const msg = resp?.error || (await r.text().catch(()=>String(r.status)));
    throw new Error(`KV set failed ${r.status}: ${String(msg).slice(0,200)}`);
  }
  return true;
}

// ------------------------------ glavni handler ------------------------------
export default async function handler(req, res){
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const qSlot = (req.query.slot && String(req.query.slot)) || slotOfHour(toLocal(now, TZ).hour);
    const slotWin = windowForSlot(qSlot);

    // limit po slotu
    let slotLimit;
    if (qSlot === "late"){
      slotLimit = isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : LIMIT_LATE_WEEKDAY;
    } else {
      slotLimit = isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : DEFAULT_LIMIT_WEEKDAY;
    }
    if (VB_LIMIT > 0) slotLimit = Math.min(slotLimit, VB_LIMIT);

    // 1) Fixtures za danas → filtriraj po slotu i heuristički isključi ženske lige
    let fixtures = [];
    const raw = await fetchFixturesByDate(ymd);
    fixtures = raw
      .map((r) => {
        const fx = r?.fixture || {};
        const lg = r?.league || {};
        const tm = r?.teams || {};
        const dateIso = fx?.date; // UTC ISO
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
      .filter(fx => fx.fixture_id && fx.date_utc != null)
      .filter(fx => fx.local_hour >= slotWin.hmin && fx.local_hour <= slotWin.hmax)
      .filter(fx => EXCLUDE_WOMEN ? !isWomensLeague(fx.league?.name, {home:fx.teams.home, away:fx.teams.away}) : true);

    // ograniči broj fixture-a (malo šire, pa preseci posle rangiranja)
    fixtures = fixtures.slice(0, Math.max(1, slotLimit, 1) * 3);
    const perFixtureCap = Math.max(1, PER_FIXTURE_ODDS_CAP);

    // 2) Za svaku utakmicu: median 1X2 kvote + predikcije → EV
    const recs = [];
    for (const fx of fixtures){
      try {
        const oddsPayload = await fetchOddsForFixture(fx.fixture_id);
        const oddsRows = Array.isArray(oddsPayload) ? oddsPayload.slice(0, perFixtureCap) : [];

        // PRVA ekstrakcija (ograničeni set) → medijane i books count (slice)
        const { med, books_count: booksCountSlice } = extract1X2FromOdds(oddsRows);
        if (!Number.isFinite(med["1"]) && !Number.isFinite(med["X"]) && !Number.isFinite(med["2"])) continue;

        // predictions
        let model = { "1": null, "X": null, "2": null };
        const pred = await fetchPredictionForFixture(fx.fixture_id).catch(()=>null);
        const comp = pred?.predictions || pred?.prediction || pred || {};
        const pHome = Number(String(comp?.percent?.home || comp?.home_percent || "").replace("%",""));
        const pDraw = Number(String(comp?.percent?.draw || comp?.draw_percent || "").replace("%",""));
        const pAway = Number(String(comp?.percent?.away || comp?.away_percent || "").replace("%",""));
        if (Number.isFinite(pHome)) model["1"] = pHome/100;
        if (Number.isFinite(pDraw)) model["X"] = pDraw/100;
        if (Number.isFinite(pAway)) model["2"] = pAway/100;

        // fallback na impl.prob iz kvota
        const implied = { "1": med["1"] ? 1/med["1"] : null, "X": med["X"] ? 1/med["X"] : null, "2": med["2"] ? 1/med["2"] : null };
        const sumImp = (implied["1"]||0) + (implied["X"]||0) + (implied["2"]||0);
        const probs = sumImp > 0 ? {
          "1": (implied["1"] || 0) / sumImp,
          "X": (implied["X"] || 0) / sumImp,
          "2": (implied["2"] || 0) / sumImp
        } : { "1":null,"X":null,"2":null };

        const modelProb = {
          "1": Number.isFinite(model["1"]) ? model["1"] : probs["1"],
          "X": Number.isFinite(model["X"]) ? model["X"] : probs["X"],
          "2": Number.isFinite(model["2"]) ? model["2"] : probs["2"]
        };

        const evBy = {
          "1": Number.isFinite(med["1"]) && Number.isFinite(modelProb["1"]) ? (med["1"] * modelProb["1"] - 1) : -Infinity,
          "X": Number.isFinite(med["X"]) && Number.isFinite(modelProb["X"]) ? (med["X"] * modelProb["X"] - 1) : -Infinity,
          "2": Number.isFinite(med["2"]) && Number.isFinite(modelProb["2"]) ? (med["2"] * modelProb["2"] - 1) : -Infinity,
        };
        let best = "1";
        if (evBy["X"] > evBy[best]) best = "X";
        if (evBy["2"] > evBy[best]) best = "2";

        const bestPrice = med[best];
        if (!Number.isFinite(bestPrice) || bestPrice < MIN_ODDS) continue;

        const mp = modelProb[best];
        if (!Number.isFinite(mp)) continue;

        const confidence_pct = Math.round(Math.max(0, Math.min(100, mp <= 1 ? mp*100 : mp)));
        const leagueName = fx.league?.name || "";
        const leagueCountry = fx.league?.country || "";

        // inicijalni zapis (books_count dopunjujemo ispod kompletnim proračunom)
        recs.push({
          fixture_id: fx.fixture_id,
          market: "1X2",
          pick: fromPickCodeToLabel(best),
          pick_code: best,
          selection_label: fromPickCodeToLabel(best),
          model_prob: Number(mp.toFixed(4)),
          confidence_pct,
          odds: { price: Number(bestPrice), books_count: 0 },
          league: { id: fx.league?.id, name: leagueName, country: leagueCountry },
          league_name: leagueName,
          league_country: leagueCountry,
          teams: { home: fx.teams.home, away: fx.teams.away },
          home: fx.teams.home,
          away: fx.teams.away,
          kickoff: fx.local_str,
          kickoff_utc: fx.date_utc,
          _implied: Number((1/Number(bestPrice)).toFixed(4)),
          _ev: Number((bestPrice * mp - 1).toFixed(12)),
          source_meta: { books_counts_raw: {} }
        });

        // DRUGA ekstrakcija (na celom oddsPayload) → precizniji books_count
        const last = recs[recs.length - 1];
        const { books_count: booksCountAll } = extract1X2FromOdds(Array.isArray(oddsPayload) ? oddsPayload : []);
        last.odds.books_count = (booksCountAll[best] || booksCountSlice[best] || 0);
        last.source_meta.books_counts_raw = {
          "1": (booksCountAll["1"] ?? booksCountSlice["1"] ?? 0),
          "X": (booksCountAll["X"] ?? booksCountSlice["X"] ?? 0),
          "2": (booksCountAll["2"] ?? booksCountSlice["2"] ?? 0)
        };

      } catch {
        // ignoriši fixture na grešku
      }
    }

    // 3) Rangiranje i preseci: "full" i "slim"
    const byEV = [...recs].sort((a,b)=> (b._ev - a._ev) || (b.confidence_pct - a.confidence_pct));
    const fullCount = Math.max(slotLimit, Math.min(byEV.length, 100));
    const slimCount = Math.min(slotLimit, byEV.length);
    const fullList = byEV.slice(0, fullCount);
    const slimList = byEV.slice(0, slimCount);

    // 4) Upis u KV (POST body za JSON!)
    const useKV = String(req.query.kv ?? "1") !== "0";
    if (useKV) {
      const keySlim = `vbl:${ymd}:${qSlot}`;
      const keyFull = `vbl_full:${ymd}:${qSlot}`;
      const payloadSlim = { items: slimList, football: slimList, value_bets: slimList };
      const payloadFull = { items: fullList, football: fullList, value_bets: fullList };
      await kvSetJSON(keySlim, payloadSlim /*, 72*3600 */);
      await kvSetJSON(keyFull, payloadFull /*, 72*3600 */);
      await kvSetJSON(`vb:day:${ymd}:last`, { key: keySlim });
    }

    // 5) Odgovor
    return res.status(200).json({
      ok: true,
      slot: qSlot,
      ymd,
      count: slimList.length,
      count_full: fullList.length,
      football: slimList
    });

  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
