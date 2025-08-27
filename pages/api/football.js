// pages/api/football.js
// Izvor za Top predloge po slotu (late/am/pm) sa robustnim fallback-om:
// 1) locked po slotu -> 2) value-bets po slotu -> 3) rebuild po slotu.
// Zatim: BAN (Uxx/Under, Women/Girls, Reserves, Youth/Academy/Development; NE ban "B Team"/"II"),
// min kvota 1.50, per-league cap (UEFA=6, ostale=2) po ključu "country:leagueName",
// Tier prioritet (T1/T2/T3), weekday/weekend shortlist cap (15 radni dan, 25 vikend).
// Learning NE diramo — ako postoji learnScore u ulazu, koristi se kao plus.

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();

    // ENV i domen
    const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
    const WEEKDAY_CAP = numFromEnv(process.env.WEEKDAY_CAP, process.env.SLOT_WEEKDAY_CAP, 15);
    const WEEKEND_CAP = numFromEnv(process.env.WEEKEND_CAP, process.env.SLOT_WEEKEND_CAP, 25);
    const origin =
      process.env.NEXT_PUBLIC_BASE_URL ||
      (req.headers?.host ? `https://${req.headers.host}` : "");

    // BAN regex (NE ban "B Team"/"II")
    const BAN_REGEX =
      /\bU\s*-?\s*\d{1,2}\b|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

    // Tier mape (Serbia: SuperLiga je T1; Prva Liga je T3)
    const TIER1 = makeSet([
      // UEFA
      "UEFA Champions League","UEFA Europa League","UEFA Europa Conference League",
      "UEFA Champions League Qualification","UEFA Europa League Qualification",
      "UEFA Europa Conference League Qualification",
      // Top 5
      "Premier League","LaLiga","Serie A","Bundesliga","Ligue 1",
      // jaki EU top nivoi
      "Eredivisie","Primeira Liga","Pro League","Süper Lig","Super Lig","Premiership",
      "Austrian Bundesliga","Swiss Super League","Russian Premier League",
      // specijalno
      "SuperLiga","Serbian SuperLiga"
    ]);
    const TIER2 = makeSet([
      "Super League","Superleague", // Greece varijante
      "Danish Superliga","Superligaen","Fortuna Liga","HNL","Ekstraklasa",
      "Eliteserien","Allsvenskan","Ukrainian Premier League","Liga I","NB I",
      "Championship","LaLiga2","Serie B","2. Bundesliga","Ligue 2",
      "Scottish Championship","Czech Liga","Romania Liga I","Poland Ekstraklasa",
      "Croatia HNL","Norway Eliteserien","Sweden Allsvenskan",
      // van Evrope po želji
      "MLS","Argentina Liga Profesional","Brazil Serie A"
    ]);
    const SERBIA_PRVA_KEYS = makeSet(["Prva Liga","Serbian Prva Liga","Prva liga Srbije"]);

    // weekday/weekend cap po lokalnom TZ
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
    const isWeekend = [0,6].includes(local.getDay()); // ned=0, sub=6
    const SLOT_LIST_CAP = isWeekend ? (WEEKEND_CAP || 25) : (WEEKDAY_CAP || 15);

    // Fallback lanac po slotu
    const urls = [];
    if (origin) urls.push(`${origin}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`);
    if (origin) urls.push(`${origin}/api/value-bets?slot=${encodeURIComponent(slot)}`);
    if (origin) urls.push(`${origin}/api/cron/rebuild?slot=${encodeURIComponent(slot)}`);

    let base = [];
    let source = "cache";
    for (let i = 0; i < urls.length; i++) {
      const r = await safeJson(urls[i]);
      let arr =
        (Array.isArray(r?.items) && r?.slot ? r.items : null) ||
        (Array.isArray(r?.value_bets) ? r.value_bets : null) ||
        (Array.isArray(r?.football) ? r.football : null) ||
        (Array.isArray(r?.list) ? r.list : null);

      // Locked: ako response.slot != traženi slot, ignoriši (sprečava "late" za ?slot=am)
      if (i === 0) {
        const respSlot = String(r?.slot || "").toLowerCase();
        if (arr && respSlot && respSlot !== slot) arr = null;
      }
      if (arr && arr.length) {
        base = arr;
        source = i === 0 ? "locked" : i === 1 ? "value-bets" : "rebuild";
        break;
      }
    }

    if (!base.length) {
      return res.status(200).json({ ok: true, slot, tz: TZ, football: [], source });
    }

    // Normalizacija + BAN + min kvota + bodovanje
    const cleaned = [];
    for (const x of base) {
      const rawLeague = String(x?.league?.name || x?.league_name || "").trim();
      const leagueName = rawLeague;
      if (!leagueName) continue;
      if (BAN_REGEX.test(leagueName)) continue;

      const country = String(x?.league?.country || x?.country || "").trim();
      const odds = bestOdds(x);
      if (odds !== null && odds < 1.5) continue; // min kvota 1.50

      const home =
        str(x?.teams?.home?.name) || str(x?.home) || str(x?.home_name) || str(x?.homeTeam);
      const away =
        str(x?.teams?.away?.name) || str(x?.away) || str(x?.away_name) || str(x?.awayTeam);

      let tier = 3;
      if (TIER1.has(leagueName)) tier = 1;
      else if (TIER2.has(leagueName)) tier = 2;
      else if (SERBIA_PRVA_KEYS.has(leagueName)) tier = 3;

      const isUEFA = /Champions League|Europa League|Conference League/i.test(leagueName);

      const baseScore = num(x?.score || x?._score || x?.model_prob || x?.model || 0);
      const learnBoost = num(x?.learnScore || x?.learn_boost || 0);
      const tierBoost = tier === 1 ? 0.10 : tier === 2 ? 0.05 : 0;
      const oddsBoost = odds !== null ? clamp((odds - 1.6) * 0.03, -0.05, 0.08) : 0;
      const score = baseScore + tierBoost + oddsBoost + learnBoost;

      cleaned.push({
        ...x,
        league: x.league || { name: leagueName, country },
        league_name: leagueName,
        teams: x.teams || { home: { name: home }, away: { name: away } },
        home_name: home,
        away_name: away,
        tier,
        isUEFA,
        __score: score,
        __odds: odds,
        __leagueKey: `${country}:${leagueName}` // za per-league cap
      });
    }

    if (!cleaned.length) {
      return res.status(200).json({ ok: true, slot, tz: TZ, football: [], source });
    }

    // Per-league cap: UEFA=6, ostalo=2, po ključu "country:leagueName"
    const perLeagueCount = Object.create(null);
    const out = [];
    for (const x of cleaned.sort((a, b) => b.__score - a.__score)) {
      const lid = (x.__leagueKey || x.league_name || "").toString();
      const cap = x.isUEFA ? 6 : 2;
      const cnt = perLeagueCount[lid] || 0;
      if (cnt >= cap) continue;
      perLeagueCount[lid] = cnt + 1;
      out.push(x);
      if (out.length >= SLOT_LIST_CAP) break; // 15 radni dan, 25 vikend
    }

    return res.status(200).json({
      ok: true,
      slot,
      tz: TZ,
      football: out,
      source
    });

  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}

/* ---------------- helpers ---------------- */

async function safeJson(url) {
  try {
    const r = await fetch(url, { headers: { "cache-control": "no-store" } });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try { return JSON.parse(t); } catch { return null; }
  } catch {
    return null;
  }
}
function numFromEnv(...xs) {
  for (const x of xs) {
    if (x == null) continue;
    const v = parseInt(String(x), 10);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  return null;
}
function makeSet(arr) { return new Set(arr.map((s) => (s || "").toString().trim())); }
function str(s) { return s == null ? "" : String(s); }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

// "best odds" tolerantno iz više polja
function bestOdds(x) {
  const cands = [
    x?.odds?.best, x?.best_odds, x?.market?.best, x?.oddsBest,
    x?.odds?.home?.win, x?.odds?.match_winner?.best,
    x?.book?.best, x?.price, x?.odd, x?.odds_value
  ];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 1.0 && n < 100) return n;
  }
  return null;
}
