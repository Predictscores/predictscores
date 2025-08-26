// pages/api/football.js
// Slojevito filtriranje i rangiranje TOP predloga po slotu (late/am/pm) sa Tier prioritetom,
// ban Uxx/Women/Reserves/Youth/Academy/Development (ali NE "B Team"/"II"),
// per-league cap (UEFA=6, ostale=2), min kvota 1.50, i weekday/weekend shortlist cap.
// Ne diramo learning – ako u ulaznim podacima postoji learnScore, koristi se kao plus.

export default async function handler(req, res) {
  try {
    const { slot = (req.query.slot || "").toString().toLowerCase(), hours } = req.query;

    // --- ENV (postoji već na Vercelu; koristimo više mogućih naziva + podrazumevane vrednosti)
    const WEEKDAY_CAP = numFromEnv(process.env.WEEKDAY_CAP, process.env.SLOT_WEEKDAY_CAP, 15);
    const WEEKEND_CAP = numFromEnv(process.env.WEEKEND_CAP, process.env.SLOT_WEEKEND_CAP, 25);
    const TZ = process.env.TZ || "Europe/Belgrade";
    // host za internu petlju (čita postojeći zaključani feed u tvojoj aplikaciji)
    const origin =
      process.env.NEXT_PUBLIC_BASE_URL ||
      (req.headers && req.headers.host ? `https://${req.headers.host}` : "");

    // --- BAN: Under/Uxx + Women/Girls + Reserves + Youth/Academy/Development (B Team/II dozvoljeni)
    const BAN_REGEX =
      /\bU\s*-?\s*\d{1,2}\b|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

    // --- Tiers
    const TIER1 = makeSet([
      // UEFA takmičenja
      "UEFA Champions League", "UEFA Europa League", "UEFA Europa Conference League",
      "UEFA Champions League Qualification", "UEFA Europa League Qualification",
      "UEFA Europa Conference League Qualification",

      // Top 5
      "Premier League", "LaLiga", "Serie A", "Bundesliga", "Ligue 1",

      // jaki EU top nivoi
      "Eredivisie", "Primeira Liga", "Pro League", "Süper Lig", "Super Lig", "Premiership",
      "Austrian Bundesliga", "Bundesliga (Austria)", "Swiss Super League",
      "Russian Premier League",

      // specijalno
      "SuperLiga", "Serbian SuperLiga", // Srbija – samo Super liga
    ]);

    const TIER2 = makeSet([
      "Super League", "Superleague", // Greece varijante
      "Danish Superliga", "Superligaen", "Fortuna Liga", "HNL", "Ekstraklasa",
      "Eliteserien", "Allsvenskan", "Ukrainian Premier League", "Liga I", "NB I",
      "Championship", "LaLiga2", "Serie B", "2. Bundesliga", "Ligue 2", "Scottish Championship",
      "Czech Liga", "Romania Liga I", "Poland Ekstraklasa", "Croatia HNL",
      "Norway Eliteserien", "Sweden Allsvenskan",
      // van Evrope (zadrži u T2 po želji)
      "MLS", "Argentina Liga Profesional", "Brazil Serie A"
    ]);

    // TIER3 = sve ostalo + Srbija Prva Liga + B/II seniorske
    const SERBIA_PRVA_KEYS = makeSet(["Prva Liga", "Serbian Prva Liga", "Prva liga Srbije"]);

    // --- Slot cap po danu
    const now = new Date();
    const isWeekend = [0, 6].includes(now.getUTCDay() /* ned=0, sub=6 u ISO? */) // zaštita: koristimo lokalno kasnije
      ? true
      : false;
    const SLOT_LIST_CAP = isWeekend ? WEEKEND_CAP : WEEKDAY_CAP;

    // --- Uzmi postojeći zaključani feed (ne menjamo learning pipeline)
    // Pokušaj prvo /api/value-bets-locked, pa fallback /api/value-bets, pa /api/cron/rebuild
    const urlCandidates = [
      origin && `${origin}/api/value-bets-locked${slot ? `?slot=${slot}` : ""}`,
      origin && `${origin}/api/value-bets${slot ? `?slot=${slot}` : ""}`,
      origin && `${origin}/api/cron/rebuild${slot ? `?slot=${slot}` : ""}`
    ].filter(Boolean);

    let base = [];
    for (const u of urlCandidates) {
      try {
        const r = await fetch(u, { method: "GET", headers: { "cache-control": "no-store" } });
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        const json = ct.includes("application/json") ? await r.json() : null;
        const arr = toArray(json && (json.football || json.value_bets || json.items || json.list));
        if (arr.length) { base = arr; break; }
      } catch (_) { /* ignore and try next */ }
    }

    // Ako ništa nismo našli, vrati prazan odgovor (bez greške)
    if (!base.length) {
      return res.status(200).json({ ok: true, slot, football: [] });
    }

    // --- Normalizacija + BAN + min kvota
    const cleaned = [];
    for (const x of base) {
      const leagueName = str(x?.league?.name || x?.league_name);
      if (!leagueName) continue;
      if (BAN_REGEX.test(leagueName)) continue; // BAN

      const country = str(x?.league?.country || x?.country);
      // Min kvota 1.50
      const odds = bestOdds(x);
      if (odds !== null && odds < 1.5) continue;

      // Normalizuj imena timova
      const home =
        str(x?.teams?.home?.name) || str(x?.home) || str(x?.home_name) || str(x?.homeTeam);
      const away =
        str(x?.teams?.away?.name) || str(x?.away) || str(x?.away_name) || str(x?.awayTeam);

      // Tier detekcija
      let tier = 3;
      if (TIER1.has(leagueName)) tier = 1;
      else if (TIER2.has(leagueName)) tier = 2;
      else if (SERBIA_PRVA_KEYS.has(leagueName)) tier = 3; // eksplicitno T3

      // UEFA cap grupisanje – koristi naziv lige
      const isUEFA = /Champions League|Europa League|Conference League/i.test(leagueName);

      // Score iz izvora + blagi tier boost + blagi oddsBoost + learning ako postoji
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
        home_name: home, away_name: away,
        tier, isUEFA, __score: score, __odds: odds
      });
    }

    if (!cleaned.length) {
      return res.status(200).json({ ok: true, slot, football: [] });
    }

    // --- Per-league cap (UEFA=6, ostale=2) + ukupni slot cap (weekday/weekend)
    const perLeagueCount = Object.create(null);
    const pick = [];
    for (const x of cleaned.sort((a, b) => b.__score - a.__score)) {
      const lid = (x.league?.id ?? x.league_id ?? x.league_name ?? "").toString();
      const cap = x.isUEFA ? 6 : 2;
      const cnt = perLeagueCount[lid] || 0;
      if (cnt >= cap) continue;
      perLeagueCount[lid] = cnt + 1;
      pick.push(x);
      if (pick.length >= SLOT_LIST_CAP) break;
    }

    // --- Vraćamo sve (UI uzima Top 3 po slotu)
    return res.status(200).json({
      ok: true,
      slot,
      tz: TZ,
      football: pick
    });

  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}

// --------------- helpers -----------------

function numFromEnv(...xs) {
  for (const x of xs) {
    if (x == null) continue;
    const v = parseInt(String(x), 10);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  return null;
}
function makeSet(arr) {
  return new Set(arr.map((s) => (s || "").toString().trim()));
}
function str(s) {
  return (s == null) ? "" : String(s);
}
function toArray(v) {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// Pokušaj izvući "best odds" iz raznih mogućih struktura bez lomljenja postojećeg oblika
function bestOdds(x) {
  // Najčešći oblici
  const cands = [
    x?.odds?.best, x?.best_odds, x?.market?.best, x?.oddsBest,
    x?.odds?.home?.win, x?.odds?.match_winner?.best,
    x?.book?.best, x?.price, x?.odd, x?.odds_value
  ];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 1.0 && n < 100) return n;
  }
  return null; // nemamo kvotu – ne primenjuj min 1.50 filter u tom slučaju
        }
