// FILE: pages/api/value-bets.js
//
// Dnevni TOP value betovi (fudbal) sa minimalnim brojem poziva.
// - SportMonks: fixtures za datum (1x/dan; keš 24h)
// - The Odds API: kvote (1x na ~2h; keš 2h; hard guard da ne pređe 12/dan)
// - Ako kvote nisu dostupne: "FALLBACK" predlozi (MODEL-only) bez rušenja.
//
// Kompatibilno sa components/FootballBets.jsx (očekivana polja).
//
// ENV varijable (Vercel > Settings > Environment Variables):
// - SPORTMONKS_KEY        (obavezno za fixtures)
// - ODDS_API_KEY          (opciono; ako nedostaje ili pukne, radimo FALLBACK)
// - ODDS_MAX_CALLS_PER_DAY= "12" (opciono; default 12)
// - TZ_DISPLAY            = "Europe/Belgrade" (opciono; default Europe/Belgrade)
//
// Napomena: The Odds endpoint ovde je pozvan "najbezbednije" i potpuno
// try/catch-ovano. Ako endpoint/ključ/limit nisu ok — API i dalje radi
// (samo bez "MODEL+ODDS" edge-a), da ne potrošimo deploy-e na greške.

export const config = {
  api: {
    bodyParser: false,
  },
};

const SPORTMONKS_KEY = process.env.SPORTMONKS_KEY || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_MAX_CALLS_PER_DAY = Number(process.env.ODDS_MAX_CALLS_PER_DAY || "12");
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";

// --- u-memorijski keš (serverless "warm" instanca) ---
let _fixturesCache = {
  date: null,          // "YYYY-MM-DD"
  data: null,          // SportMonks fixtures JSON
  fetchedAt: 0,
};

let _oddsCache = {
  dayKey: null,        // npr. "2025-08-08"
  data: null,          // poslednji odds snapshot (po meču)
  fetchedAt: 0,
  lastCallTimestamps: [], // UNIX ms lista poziva danas (radi limita 12/dan)
  previousData: null,  // prethodni snapshot radi movement-a
};

// --- utilities ---

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function toNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function pad2(n) { return String(n).padStart(2, '0'); }

function todayYMD(tz = "UTC") {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [{ value: y }, , { value: m }, , { value: d2 }] = fmt.formatToParts(d);
  return `${y}-${m}-${d2}`;
}

function formatBelgradeDateTime(isoUtc) {
  try {
    if (!isoUtc) return "";
    const d = new Date(isoUtc.endsWith("Z") ? isoUtc : isoUtc + "Z");
    const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_DISPLAY, year: 'numeric', month: '2-digit', day: '2-digit' });
    const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_DISPLAY, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const [{ value: y }, , { value: m }, , { value: da }] = fmtDate.formatToParts(d);
    const t = fmtTime.format(d);
    return `${y}-${m}-${da} ${t}`;
  } catch {
    return isoUtc;
  }
}

function normalizeTeamName(name = "") {
  return String(name || "")
    .toLowerCase()
    .replace(/football club|fc|cf|afc|cf|club|sc|ac|calcio|fk|kk|bk|u19|u21|women|ladies/gi, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function impliedFromBestOdds(best) {
  // best: { home, draw, away } decimal odds (brojevi)
  const invH = best.home ? 1 / best.home : 0;
  const invD = best.draw ? 1 / best.draw : 0;
  const invA = best.away ? 1 / best.away : 0;
  const s = invH + invD + invA;
  if (s <= 0) return { home: 0, draw: 0, away: 0, overround: 0 };
  return { home: invH / s, draw: invD / s, away: invA / s, overround: s };
}

function pickBestOddsForH2H(bookmakers = []) {
  // bookmakers: [{markets:[{key:'h2h', outcomes:[{name:'Team A', price:1.8}, ...]}]}]
  let best = { home: 0, draw: 0, away: 0 };
  let count = 0;
  for (const b of bookmakers || []) {
    const m = (b.markets || []).find(x => x.key === 'h2h');
    if (!m) continue;
    const out = m.outcomes || [];
    // pokušaj naći HOME/DRAW/AWAY po redosledu i/ili "name"
    // Ne oslanjamo se na imena timova (mapiramo po poziciji: 0=home,1=away; draw poseban).
    const home = out.find(o => o.name?.toLowerCase() === 'home') || out[0];
    const away = out.find(o => o.name?.toLowerCase() === 'away') || out[1];
    const draw = out.find(o => (o.name || '').toLowerCase() === 'draw') || out.find(o => (o.name || '').toLowerCase() === 'tie');
    if (home && typeof home.price === 'number') best.home = Math.max(best.home, home.price);
    if (away && typeof away.price === 'number') best.away = Math.max(best.away, away.price);
    if (draw && typeof draw.price === 'number') best.draw = Math.max(best.draw, draw.price);
    count++;
  }
  return { best, bookmakerCount: count };
}

function baseModel1X2Prob(fix) {
  // Grubi model iz pozicija (ako postoje) + home advantage (ligom-agnostički).
  // Ovo je "štedljiva" varijanta bez dodatnih poziva; u sledećem koraku
  // može se zameniti API-Football Poissonom za top-k.
  const posH = toNumber(fix?.standings?.localteam_position, 0);
  const posA = toNumber(fix?.standings?.visitorteam_position, 0);
  const homeAdv = 0.08; // 8% absolutni boost za home
  let posAdj = 0;

  if (posH > 0 && posA > 0) {
    // niža pozicija = jači tim; ograniči uticaj u +/-10pp na ravnoteži
    const diff = (posA - posH); // ako je home bolji, diff > 0
    posAdj = clamp(diff / 20, -0.10, 0.10);
  }

  let pHome = 0.33 + homeAdv + posAdj;
  let pAway = 0.33 - homeAdv - posAdj;
  let pDraw = 1 - (pHome + pAway);

  // osiguraj realne opsege i renormalizuj
  pHome = clamp(pHome, 0.10, 0.75);
  pAway = clamp(pAway, 0.10, 0.75);
  pDraw = clamp(pDraw, 0.10, 0.40);
  const s = pHome + pDraw + pAway;
  return { home: pHome / s, draw: pDraw / s, away: pAway / s };
}

function scoreFromEdge(edge, movement = 0, bookies = 0, hoursToKO = 24) {
  // edge u [−1, 1]; movement u [−1, 1] (pozitivno u našem smeru); bookies ~ [0..N]
  const edgePct = clamp(edge, -1, 1);
  const mov = clamp(movement, -1, 1);
  const bk = clamp(bookies / 10, 0, 1); // 10 bukija ~ max
  let t;
  if (hoursToKO >= 6) t = 0.6;
  else if (hoursToKO >= 3) t = 0.5;
  else t = 0.3;
  // ponderi
  const score = 0.55 * edgePct + 0.20 * mov + 0.15 * bk + 0.10 * (1 - Math.abs(t - 0.45));
  return clamp((score + 1) / 2 * 100, 0, 100); // u [0..100]
}

function hoursUntil(startIsoUTC) {
  try {
    const t = new Date(startIsoUTC.endsWith("Z") ? startIsoUTC : startIsoUTC + "Z").getTime();
    return (t - Date.now()) / 3600000;
  } catch { return 999; }
}

// Detekcija dnevnog ključa (za limitiranje The Odds poziva)
function currentDayKey() {
  // ključ po Srbiji (tvoj lokalni dan)
  return todayYMD(TZ_DISPLAY);
}

// --- fetcheri sa kešom i guardovima ---

async function fetchFixturesForDate(dateYMD) {
  try {
    if (_fixturesCache.date === dateYMD && _fixturesCache.data && Date.now() - _fixturesCache.fetchedAt < 6 * 3600_000) {
      return _fixturesCache.data;
    }

    const url = `https://soccer.sportmonks.com/api/v2.0/fixtures/date/${dateYMD}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(SPORTMONKS_KEY)}&tz=UTC`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`SportMonks HTTP ${res.status}`);
    const json = await res.json();

    _fixturesCache = { date: dateYMD, data: json, fetchedAt: Date.now() };
    return json;
  } catch (e) {
    console.error("SportMonks fetch error", e?.message || e);
    return { data: [] };
  }
}

// The Odds API: široki snapshot (h2h, btts, totals). Sve u try/catch.
// Ako bilo šta pođe po zlu, vraćamo null i NE rušimo API.
async function fetchOddsSnapshotGuarded() {
  const dayKey = currentDayKey();

  // dnevni limit poziva
  if (_oddsCache.dayKey !== dayKey) {
    _oddsCache.dayKey = dayKey;
    _oddsCache.lastCallTimestamps = [];
  }

  // Ako imamo svež snapshot (<2h), vrati ga
  if (_oddsCache.data && Date.now() - _oddsCache.fetchedAt < 2 * 3600_000) {
    return { data: _oddsCache.data, previous: _oddsCache.previousData };
  }

  // Ako smo već pogodili dnevni limit, vrati poslednji snapshot (možda null)
  if (_oddsCache.lastCallTimestamps.length >= ODDS_MAX_CALLS_PER_DAY) {
    return { data: _oddsCache.data, previous: _oddsCache.previousData };
  }

  if (!ODDS_API_KEY) {
    return { data: null, previous: _oddsCache.previousData };
  }

  try {
    // PAŽNJA: The Odds API ima više varijanti endpointa po ligi/sportu.
    // Ovde biramo "širok" pristup; ako endpoint ne odgovara tvom planu,
    // funkcija će se ponašati kao da kvote nema (fallback).
    //
    // region EU, markets h2h/btts/totals, decimal
    const params = new URLSearchParams({
      regions: "eu",
      markets: "h2h,btts,totals",
      oddsFormat: "decimal",
      apiKey: ODDS_API_KEY,
    });

    // Pokušaj "upcoming" soccer endpoint-a (v4).
    const url = `https://api.the-odds-api.com/v4/sports/soccer/odds?${params.toString()}`;

    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      // ako dobiješ 404/401/429 — ne rušimo: fallback
      console.warn("TheOdds HTTP", res.status);
      return { data: null, previous: _oddsCache.previousData };
    }
    const json = await res.json();

    _oddsCache.lastCallTimestamps.push(Date.now());
    _oddsCache.previousData = _oddsCache.data || null;
    _oddsCache.data = Array.isArray(json) ? json : null;
    _oddsCache.fetchedAt = Date.now();

    return { data: _oddsCache.data, previous: _oddsCache.previousData };
  } catch (e) {
    console.error("TheOdds fetch error", e?.message || e);
    return { data: null, previous: _oddsCache.previousData };
  }
}

// Izračun "movement"-a u poslednjem intervalu (ako imamo prethodni snapshot).
function computeMovementForMatch(key, currentOddsObj, previousOddsObj) {
  // Ovo je skroman prox: uporedi implied(home) iz bestOdds sada vs ranije.
  // Vraća broj u [-1..+1] (pozitivno ako ide u smer većeg edge-a kad biramo selekciju).
  try {
    if (!currentOddsObj || !previousOddsObj) return 0;
    const cur = impliedFromBestOdds(currentOddsObj.best);
    const prev = impliedFromBestOdds(previousOddsObj.best);
    if (!Number.isFinite(cur.home) || !Number.isFinite(prev.home)) return 0;
    // promene u procentnim poenima
    const dh = cur.home - prev.home;
    const dd = cur.draw - prev.draw;
    const da = cur.away - prev.away;
    // normalizuj u [-1..1] po max apsolutnoj promeni 0.1 (10pp)
    const norm = 0.1;
    const ch = clamp(dh / norm, -1, 1);
    const cd = clamp(dd / norm, -1, 1);
    const ca = clamp(da / norm, -1, 1);
    return { ch, cd, ca };
  } catch {
    return 0;
  }
}

// --- glavna obrada ---

export default async function handler(req, res) {
  try {
    // parametri
    const url = new URL(req.url, 'http://localhost');
    const date = url.searchParams.get('date') || todayYMD('UTC'); // fixtures tražimo u UTC danu
    const minEdge = toNumber(url.searchParams.get('min_edge'), 0.05); // 5%
    const minOdds = toNumber(url.searchParams.get('min_odds'), 1.3);
    const sportKey = url.searchParams.get('sport_key') || 'soccer';

    // 1) fixtures (SportMonks)
    const fixturesJson = await fetchFixturesForDate(date);
    const fixtures = Array.isArray(fixturesJson?.data) ? fixturesJson.data : [];

    // pripremi mapu mečeva po "normalized key"
    const fixtureRows = fixtures.map((f) => {
      const homeName = f?.localTeam?.data?.name || f?.localTeam?.data?.short_code || 'Home';
      const awayName = f?.visitorTeam?.data?.name || f?.visitorTeam?.data?.short_code || 'Away';
      const key = normalizeTeamName(homeName) + " vs " + normalizeTeamName(awayName);

      const utcStart = f?.time?.starting_at?.date_time?.replace(' ', 'T') + 'Z'; // "YYYY-MM-DDTHH:mm:ssZ"
      const beograd = formatBelgradeDateTime(f?.time?.starting_at?.date_time?.replace(' ', 'T'));

      return {
        fixture_id: f?.id,
        league_id: f?.league_id,
        key,
        utcStart,
        belgradeStart: beograd,
        homeName,
        awayName,
        standings: {
          localteam_position: f?.standings?.localteam_position,
          visitorteam_position: f?.standings?.visitorteam_position,
        },
        raw: f,
      };
    });

    // 2) odds (The Odds) — guarded + cache; ako nema, idemo fallback
    const { data: oddsData, previous: prevOddsData } = await fetchOddsSnapshotGuarded();

    // mapiraj odds po ključu
    const oddsMap = new Map();
    const prevOddsMap = new Map();

    function buildOddsKey(evt) {
      try {
        // v4 obično ima teams: ["Home Team","Away Team"] ili outcomes sa name.
        const t1 = normalizeTeamName(evt?.home_team || (evt?.teams && evt.teams[0]) || evt?.commence_time || "");
        const tA = normalizeTeamName(evt?.away_team || (evt?.teams && evt.teams[1]) || "");
        if (!t1 || !tA) return null;
        return normalizeTeamName(evt?.home_team || evt?.teams?.[0] || "") + " vs " +
               normalizeTeamName(evt?.away_team || evt?.teams?.[1] || "");
      } catch {
        return null;
      }
    }

    if (Array.isArray(oddsData)) {
      for (const evt of oddsData) {
        const key = buildOddsKey(evt);
        if (!key) continue;
        // uzmi best H2H i broj bukija
        const { best, bookmakerCount } = pickBestOddsForH2H(evt.bookmakers || []);
        oddsMap.set(key, { best, bookmakerCount, event: evt });
      }
    }
    if (Array.isArray(prevOddsData)) {
      for (const evt of prevOddsData) {
        const key = buildOddsKey(evt);
        if (!key) continue;
        const { best, bookmakerCount } = pickBestOddsForH2H(evt.bookmakers || []);
        prevOddsMap.set(key, { best, bookmakerCount, event: evt });
      }
    }

    // 3) evaluacija svih mečeva -> 1 predlog po meču (ako ispunjava uslove)
    const candidates = [];

    for (const row of fixtureRows) {
      // grubi model 1X2
      const model = baseModel1X2Prob({ standings: row.standings });

      // kvote (ako postoje)
      const oddsObj = oddsMap.get(row.key) || null;
      const prevOddsObj = prevOddsMap.get(row.key) || null;

      let type = "FALLBACK";
      let marketOdds = null;
      let implied = { home: 0, draw: 0, away: 0 };
      let bookies = 0;

      if (oddsObj && oddsObj.best && (oddsObj.best.home || oddsObj.best.draw || oddsObj.best.away)) {
        type = "MODEL+ODDS";
        marketOdds = oddsObj.best;
        implied = impliedFromBestOdds(oddsObj.best);
        bookies = toNumber(oddsObj.bookmakerCount, 0);
      }

      // Izaberi selekciju sa najvećim edge-om (1, X, 2)
      const edges = {
        home: model.home - implied.home,
        draw: model.draw - implied.draw,
        away: model.away - implied.away,
      };

      // Ako nemamo kvote → implied = 0 → favorizovaćemo high P model; zato kasnije filter edge/min_odds
      let sel = 'home';
      let selProb = model.home;
      let selOdds = marketOdds?.home || null;
      let selEdge = edges.home;

      if (edges.draw > selEdge) {
        sel = 'draw'; selProb = model.draw; selOdds = marketOdds?.draw || null; selEdge = edges.draw;
      }
      if (edges.away > selEdge) {
        sel = 'away'; selProb = model.away; selOdds = marketOdds?.away || null; selEdge = edges.away;
      }

      // validacija minimalnih uslova
      const hours = hoursUntil(row.utcStart);
      if (hours < 0.33) continue; // <20 min do starta, preskoči

      // ako imamo kvote → primeni pragove; ako nemamo → dozvoli samo kad je model baš ubedljiv
      const hasOdds = type === "MODEL+ODDS";
      const passEdge = hasOdds ? (selEdge >= minEdge) : (selProb >= 0.65); // fallback stroži
      const passOdds = hasOdds ? (toNumber(selOdds, 0) >= minOdds) : true;
      const passBookies = hasOdds ? (bookies >= 4) : true; // tražimo makar 4 bukija

      if (!passEdge || !passOdds || !passBookies) continue;

      // Movement signal (ako imamo prethodni snapshot)
      let movementScore = 0;
      if (hasOdds && prevOddsObj) {
        const mv = computeMovementForMatch(row.key, oddsObj, prevOddsObj);
        if (mv && typeof mv === 'object') {
          if (sel === 'home') movementScore = mv.ch || 0;
          else if (sel === 'draw') movementScore = mv.cd || 0;
          else movementScore = mv.ca || 0;
        }
      }

      const score = scoreFromEdge(selEdge, movementScore, bookies, hours);

      const selectionLabel = sel === 'home' ? '1' : sel === 'draw' ? 'X' : '2';

      candidates.push({
        fixture_id: row.fixture_id,
        market: "1X2",
        selection: selectionLabel,
        type, // "MODEL+ODDS"|"FALLBACK"
        model_prob: selProb,                 // 0..1
        market_odds: hasOdds ? selOdds : null,
        edge: hasOdds ? selEdge : null,      // null u fallbacku
        datetime_local: {
          starting_at: {
            date_time: row.belgradeStart,   // "YYYY-MM-DD HH:mm:ss" u Europe/Belgrade
          }
        },
        teams: {
          home: { name: row.homeName },
          away: { name: row.awayName },
        },
        meta: {
          bookies,
          implied_home: implied.home,
          implied_draw: implied.draw,
          implied_away: implied.away,
          hours_to_kickoff: hours,
          // debug: row.key
        },
        // skoring za sortiranje
        _score: score,
      });
    }

    // Sortiraj po score opa, uzmi top 10
    candidates.sort((a, b) => (toNumber(b._score, 0) - toNumber(a._score, 0)));
    const top = candidates.slice(0, 10).map(({ _score, meta, ...rest }) => rest);

    // Keš kontrola za CDN/Edge
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
    return res.status(200).json({ value_bets: top, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error("value-bets fatal", e?.message || e);
    // Nemoj rušiti UI — vrati prazan niz, sa napomenom
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    return res.status(200).json({ value_bets: [], note: 'error, returned empty' });
  }
}
