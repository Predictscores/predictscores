// pages/api/football.js
//
// Fixtures za narednih `hours` (default 24) + (opciono) kvote iz The Odds API.
// BAN: youth/Uxx/Reserves/B-Team/II-Team/Women/Girls/Development/Academy
// (NE dira “Serie B”, “Primera B”, “Liga II”).
// Min kvota 1.50. TRUSTED_BOOKIES poštovan.
// Cache: fixtures+odds 10 min, The Odds API 10 min.
//
// ENV: NEXT_PUBLIC_API_FOOTBALL_KEY ili API_FOOTBALL_KEY, ODDS_API_KEY, TRUSTED_BOOKIES

const BAN_REGEX =
  /(U-?\d{1,2}\b|\bU\d{1,2}\b|Under\s?\d{1,2}|Reserves?|B\s*-?\s*Team|II\s*-?\s*Team|Youth|Women|Girls|Development|Academy)/i;

const TZ = "Europe/Belgrade";

// ---- cache (jednostavno) ----
const FIX_CACHE_TTL = 10 * 60 * 1000;
const ODDS_CACHE_TTL = 10 * 60 * 1000;
const _fixCache = {};
const _oddsCache = {};
const cget = (m, k, ttl) => (m[k] && Date.now() - m[k].ts <= ttl ? m[k].data : null);
const cset = (m, k, data) => (m[k] = { ts: Date.now(), data });

function parseTrusted() {
  return new Set(
    (process.env.TRUSTED_BOOKIES || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
function toDecimal(x) {
  if (x == null) return null;
  let s = String(x).trim().replace(",", ".").replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function normalizeOdds(o) {
  const n = toDecimal(o);
  if (!Number.isFinite(n)) return null;
  if (n < 1.5 || n > 20) return null;
  return n;
}
function ymd(d) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
function addHours(d, h) {
  return new Date(d.getTime() + h * 3600 * 1000);
}
function safeGet(obj, path, def = undefined) {
  try {
    return path.split(".").reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj) ?? def;
  } catch {
    return def;
  }
}
function isoFromAPIFootball(fx) {
  const t = fx?.fixture?.date;
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ---- fixtures (API-Football) ----
async function fetchFixtures(hours = 24) {
  const key = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return [];
  const now = new Date();
  const until = addHours(now, Math.max(1, Math.min(72, Number(hours) || 24)));
  const url = `https://v3.football.api-sports.io/fixtures?from=${ymd(now)}&to=${ymd(
    until
  )}&timezone=${encodeURIComponent(TZ)}`;
  const r = await fetch(url, { headers: { "x-apisports-key": key } });
  if (!r.ok) return [];
  const data = await r.json();
  const list = Array.isArray(data?.response) ? data.response : [];
  const mapped = list.map((fx) => {
    const leagueName = safeGet(fx, "league.name", "");
    const leagueId = safeGet(fx, "league.id", null);
    const homeName = safeGet(fx, "teams.home.name", "");
    const awayName = safeGet(fx, "teams.away.name", "");
    const fixtureId = safeGet(fx, "fixture.id", null);
    const dt = isoFromAPIFootball(fx);
    return {
      fixture_id: fixtureId,
      league: { id: leagueId, name: leagueName },
      teams: { home: { name: homeName }, away: { name: awayName } },
      datetime_local: { starting_at: { date_time: dt }, date_time: dt },
      market_odds: null,
      market_odds_decimal: null,
      closing_odds_decimal: null,
      books_used: [],
      market: null,
      market_label: null,
      selection: null,
    };
  });
  return mapped.filter((m) => !BAN_REGEX.test(m?.league?.name || ""));
}

// ---- The Odds API (1 poziv + cache) ----
async function fetchOddsEU(trusted) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return [];
  const CK = "odds_v4_soccer_eu_h2h";
  const cached = cget(_oddsCache, CK, ODDS_CACHE_TTL);
  if (cached) return cached;

  const url = `https://api.the-odds-api.com/v4/sports/soccer/odds?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(
    key
  )}`;
  let arr = [];
  try {
    const r = await fetch(url);
    if (r.ok) {
      const json = await r.json();
      arr = Array.isArray(json) ? json : [];
    }
  } catch {
    arr = [];
  }

  const tset = trusted || new Set();
  const filtered = arr.map((ev) => {
    const books = Array.isArray(ev?.bookmakers) ? ev.bookmakers : [];
    const okBooks = books.filter((b) => tset.size === 0 || tset.has(String(b?.key || "").toLowerCase()));
    return { ...ev, bookmakers: okBooks };
  });

  cset(_oddsCache, CK, filtered);
  return filtered;
}

function matchAndPrice(fixtures, oddsArr, trusted) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  return fixtures.map((fx) => {
    const home = norm(fx?.teams?.home?.name);
    const away = norm(fx?.teams?.away?.name);

    const candidates = [];
    for (const ev of oddsArr) {
      const books = Array.isArray(ev?.bookmakers) ? ev.bookmakers : [];
      let matched = false;
      for (const b of books) {
        for (const mkt of b?.markets || []) {
          const outs = Array.isArray(mkt?.outcomes) ? mkt.outcomes : [];
          const names = outs.map((o) => norm(o?.name));
          if (names.some((n) => n.includes(home)) && names.some((n) => n.includes(away))) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (matched) candidates.push(ev);
    }

    if (candidates.length === 0) return fx;

    const used = new Set();
    const prices = [];
    for (const ev of candidates) {
      for (const b of ev.bookmakers || []) {
        const key = String(b?.key || "").toLowerCase();
        if (trusted.size > 0 && !trusted.has(key)) continue;
        used.add(key);
        for (const mkt of b.markets || []) {
          for (const o of mkt.outcomes || []) {
            const price = normalizeOdds(o?.price);
            if (price) prices.push(price);
          }
        }
      }
    }
    if (prices.length === 0) return fx;

    prices.sort((a, b) => a - b);
    const mid = prices[Math.floor(prices.length / 2)];

    return {
      ...fx,
      market: "h2h",
      market_label: "Match Winner",
      market_odds: mid,
      market_odds_decimal: mid,
      books_used: Array.from(used),
    };
  });
}

// ---- handler ----
export default async function handler(req, res) {
  try {
    const hours = Math.max(1, Math.min(72, Number(req.query.hours) || 24));
    const trusted = parseTrusted();

    const cacheKey = JSON.stringify({ hours, tb: process.env.TRUSTED_BOOKIES || "" });
    const cached = cget(_fixCache, cacheKey, FIX_CACHE_TTL);
    if (cached) return res.status(200).json({ ok: true, hours, football: cached, source: "cache" });

    let fixtures = await fetchFixtures(hours);
    const oddsArr = await fetchOddsEU(trusted); // 1 poziv, keširan 10min
    if (Array.isArray(oddsArr) && oddsArr.length > 0) {
      fixtures = matchAndPrice(fixtures, oddsArr, trusted);
    }

    const final = fixtures
      .filter((m) => !BAN_REGEX.test(m?.league?.name || ""))
      .map((m) => {
        const odds =
          normalizeOdds(m?.closing_odds_decimal) ??
          normalizeOdds(m?.market_odds_decimal) ??
          normalizeOdds(m?.market_odds) ??
          null;

        const books = Array.isArray(m?.books_used) ? m.books_used.map((b) => String(b).toLowerCase()) : [];
        const onlyTrusted = books.filter((b) => trusted.size === 0 || trusted.has(b));

        return { ...m, market_odds: odds, market_odds_decimal: odds, books_used: onlyTrusted };
      });

    cset(_fixCache, cacheKey, final);
    res.status(200).json({ ok: true, hours, football: final, source: "live" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
