// pages/api/cron/rebuild.js
// Rebuild job: izračuna value-bets za današnji slot (late/am/pm),
// upiše rezultate u KV (vbl:<YMD>:<slot> i vbl_full:<YMD>:<slot>),
// i vrati JSON kompatibilan sa postojećim UI-em.
//
// ❗ Ovaj fajl:
// - NE menja UI
// - Koristi samo tvoje ENV varijable (API_FOOTBALL*, KV_REST_API_*, TZ_DISPLAY, SLOT_* itd.)
// - Poštuje slot prozore i limete
//
// Napomena: Ovo je "best-effort" implementacija protiv API-Football v3 (api-sports).
// Ako koristiš drugi base URL/provajder, ostavljena je logika koja pokušava oba header formata.

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
    // samo radi formatiranja
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
function slotOfHour(h){
  // late = 00:00–09:59, am = 10:00–14:59, pm = 15:00–23:59
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}
function windowForSlot(slot){
  if (slot === "late") return { hmin:0,  hmax:9,  label:"late" };
  if (slot === "am")   return { hmin:10, hmax:14, label:"am"   };
  return { hmin:15, hmax:23, label:"pm" };
}
function isWeekend(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" });
    const wd = fmt.format(d).toLowerCase(); // sat, sun
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
const VB_LIMIT              = envNum("VB_LIMIT", 0); // 0 = no hard cap, oslanjamo se na slot limite

const PER_FIXTURE_ODDS_CAP  = envNum("ODDS_PER_FIXTURE_CAP", 1); // koliko od strane odds poziva po fixture-u maksimalno (agregacija je po tržištu)
const MIN_ODDS              = envNum("MIN_ODDS", 1.01);

const EXCLUDE_WOMEN         = envBool("EXCLUDE_WOMEN", true); // heuristika — ako želiš konzistentnije skupove

// ------------------------------ API-Football helpers ------------------------------
const API_BASE = process.env.API_FOOTBALL_BASE_URL || process.env.API_FOOTBALL || "https://v3.football.api-sports.io";
const API_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "";

function afHeaders(){
  const h = {};
  // api-sports v3
  h["x-apisports-key"] = API_KEY;
  // rapidapi fallback (ako koristiš RapidAPI proxy)
  h["x-rapidapi-key"] = API_KEY;
  return h;
}
async function getJSON(url){
  const r = await fetch(url, { headers: afHeaders() });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : JSON.parse(await r.text());
  return body;
}

// /fixtures?date=YYYY-MM-DD
async function fetchFixturesByDate(ymd){
  const url = `${API_BASE.replace(/\/+$/,"")}/fixtures?date=${encodeURIComponent(ymd)}`;
  const j = await getJSON(url).catch(()=>null);
  if (!j || (j.errors && Object.keys(j.errors).length)) return [];
  const arr = Array.isArray(j?.response) ? j.response : [];
  return arr;
}

// /odds?fixture=<id>
async function fetchOddsForFixture(fixtureId){
  const url = `${API_BASE.replace(/\/+$/,"")}/odds?fixture=${encodeURIComponent(fixtureId)}`;
  const j = await getJSON(url).catch(()=>null);
  if (!j || (j.errors && Object.keys(j.errors).length)) return [];
  const arr = Array.isArray(j?.response) ? j.response : [];
  return arr; // struktura: [ { bookmaker:{id,name}, bets:[{name,values:[{value,odd}]}] } ]
}

// /predictions?fixture=<id>
async function fetchPredictionForFixture(fixtureId){
  const url = `${API_BASE.replace(/\/+$/,"")}/predictions?fixture=${encodeURIComponent(fixtureId)}`;
  const j = await getJSON(url).catch(()=>null);
  if (!j || (j.errors && Object.keys(j.errors).length)) return null;
  const arr = Array.isArray(j?.response) ? j.response : [];
  return arr[0] || null;
}

// ------------------------------ obrada marketa 1X2 ------------------------------
function median(nums){
  const a = nums.filter(n => Number.isFinite(n)).sort((x,y)=>x-y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
}

function extract1X2FromOdds(oddsPayload){
  // Vrati: { priceBy:{'1':[], 'X':[], '2':[]}, books_count:{'1':n,'X':n,'2':n} }
  const priceBy = { "1":[], "X":[], "2":[] };
  const seenBook = { "1":new Set(), "X":new Set(), "2":new Set() };

  for (const row of oddsPayload){
    const bkm = row?.bookmaker?.name || row?.bookmaker?.id || "";
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets){
      const name = (bet?.name || "").toLowerCase();
      // Prepoznaj 1X2 tržište
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

// ------------------------------ KV ------------------------------
async function kvSetJSON(key, value, ttlSec = null) {
  const base  = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN nisu postavljeni");

  const encKey = encodeURIComponent(key);
  const encVal = encodeURIComponent(JSON.stringify(value));
  // Upstash: /set/{key}/{value}   ili /setex/{key}/{ttl}/{value}
  const url = ttlSec != null
    ? `${base.replace(/\/+$/,"")}/setex/${encKey}/${ttlSec}/${encVal}`
    : `${base.replace(/\/+$/,"")}/set/${encKey}/${encVal}`;

  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const txt = await r.text().catch(()=>String(r.status));
    throw new Error(`KV set failed ${r.status}: ${txt.slice(0,160)}`);
  }
  return true;
}

// ------------------------------ glavni handler ------------------------------
export default async function handler(req, res){
  try{
    // slot + datum
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const qSlot = (req.query.slot && String(req.query.slot)) || slotOfHour(toLocal(now, TZ).hour);
    const slotWin = windowForSlot(qSlot);

    // limit po slotu
    let slotLimit;
    if (qSlot === "late"){
      // radnim danom manji late limit
      slotLimit = isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : LIMIT_LATE_WEEKDAY;
    } else {
      slotLimit = isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : DEFAULT_LIMIT_WEEKDAY;
    }
    if (VB_LIMIT > 0) slotLimit = Math.min(slotLimit, VB_LIMIT);

    // 1) Dohvati sve današnje fixture-e pa filtriraj na slot prozor
    let fixtures = [];
    if (!API_KEY || !API_BASE) {
      // bez API ključa — nema eksterne obrade
      fixtures = [];
    } else {
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
    }

    // ograniči broj fixture-a po budžetu
    fixtures = fixtures.slice(0, Math.max(1, slotLimit, 1) * 3); // malo šire, selekcija kasnije
    const perFixtureCap = Math.max(1, PER_FIXTURE_ODDS_CAP);

    // 2) Za svaku utakmicu, pokupi 1X2 kvote (median) i eventualno prediction
    const recs = [];
    for (const fx of fixtures){
      try {
        // odds (1X2)
        let oddsPayload = [];
        if (API_KEY) {
          oddsPayload = await fetchOddsForFixture(fx.fixture_id);
        }
        // neka tržišta vraćaju po "bookmaker", pa uzmi samo prvi "league line" set do perFixtureCap
        const oddsRows = Array.isArray(oddsPayload) ? oddsPayload.slice(0, perFixtureCap) : [];

        const { med, books_count } = extract1X2FromOdds(oddsRows);
        // ako nemamo cene, preskoči
        if (!Number.isFinite(med["1"]) && !Number.isFinite(med["X"]) && !Number.isFinite(med["2"])) continue;

        // predictions
        let model = { "1": null, "X": null, "2": null };
        if (API_KEY) {
          const pred = await fetchPredictionForFixture(fx.fixture_id).catch(()=>null);
          // heuristika: izvući procente ako postoje
          // api-sports predictions često šalju percent_home/percent_draw/percent_away ili slično
          const comp = pred?.predictions || pred?.prediction || pred || {};
          const pHome = Number(String(comp?.percent?.home || comp?.home_percent || "").replace("%",""));
          const pDraw = Number(String(comp?.percent?.draw || comp?.draw_percent || "").replace("%",""));
          const pAway = Number(String(comp?.percent?.away || comp?.away_percent || "").replace("%",""));
          if (Number.isFinite(pHome)) model["1"] = pHome/100;
          if (Number.isFinite(pDraw)) model["X"] = pDraw/100;
          if (Number.isFinite(pAway)) model["2"] = pAway/100;
        }

        // fallback: ako nema predikcija, koristi bazne impl.prob iz kvota (uz normalizaciju)
        const probs = { "1": null, "X": null, "2": null };
        const implied = { "1": med["1"] ? 1/med["1"] : null, "X": med["X"] ? 1/med["X"] : null, "2": med["2"] ? 1/med["2"] : null };
        const sumImp = (implied["1"]||0) + (implied["X"]||0) + (implied["2"]||0);
        if (sumImp > 0) {
          for (const c of ["1","X","2"]) probs[c] = (implied[c] || 0) / sumImp;
        }
        const modelProb = {
          "1": Number.isFinite(model["1"]) ? model["1"] : probs["1"],
          "X": Number.isFinite(model["X"]) ? model["X"] : probs["X"],
          "2": Number.isFinite(model["2"]) ? model["2"] : probs["2"]
        };

        // očekivana vrednost za svaku opciju: EV = price * prob - 1
        const evBy = {
          "1": Number.isFinite(med["1"]) && Number.isFinite(modelProb["1"]) ? (med["1"] * modelProb["1"] - 1) : -Infinity,
          "X": Number.isFinite(med["X"]) && Number.isFinite(modelProb["X"]) ? (med["X"] * modelProb["X"] - 1) : -Infinity,
          "2": Number.isFinite(med["2"]) && Number.isFinite(modelProb["2"]) ? (med["2"] * modelProb["2"] - 1) : -Infinity,
        };

        // izaberi najbolji ishod
        let best = "1";
        if (evBy["X"] > evBy[best]) best = "X";
        if (evBy["2"] > evBy[best]) best = "2";

        const bestPrice = med[best];
        if (!Number.isFinite(bestPrice) || bestPrice < MIN_ODDS) continue;

        const mp = modelProb[best];
        if (!Number.isFinite(mp)) continue;

        // confidence: pragmatično — % modela, "omekšan"
        const confidence_pct = Math.round(Math.max(0, Math.min(100, mp <= 1 ? mp*100 : mp)));

        // build zapis
        const leagueName = fx.league?.name || "";
        const leagueCountry = fx.league?.country || "";

        const item = {
          fixture_id: fx.fixture_id,
          market: "1X2",
          pick: fromPickCodeToLabel(best),
          pick_code: best,
          selection_label: fromPickCodeToLabel(best),
          model_prob: Number(mp.toFixed(4)),
          confidence_pct,
          odds: { price: Number(bestPrice), books_count: books_count[best] || 0 },
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
          source_meta: { books_counts_raw: { "1": books_count["1"]||0, "X": books_count["X"]||0, "2": books_count["2"]||0 } }
        };

        recs.push(item);
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

    // 4) Upis u KV (ako nije zabranjeno kv parametrom)
    const useKV = String(req.query.kv ?? "1") !== "0";
    if (useKV) {
      const keySlim = `vbl:${ymd}:${qSlot}`;
      const keyFull = `vbl_full:${ymd}:${qSlot}`;
      const payloadSlim = { items: slimList, football: slimList, value_bets: slimList };
      const payloadFull = { items: fullList, football: fullList, value_bets: fullList };
      // TTL opcioni, možeš 72h (72*3600) ako želiš prolaznu keš politiku
      await kvSetJSON(keySlim, payloadSlim /*, 72*3600 */);
      await kvSetJSON(keyFull, payloadFull /*, 72*3600 */);
      // day-pointer radi fallback-a
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
