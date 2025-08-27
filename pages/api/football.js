// pages/api/football.js
//
// Vraća listu mečeva u narednih `hours` sati (default 24),
// sa ujednačenim poljima i (opciono) kvotama iz trusted bookies.
// Dodato: in-memory CACHE (TTL 120s) da smanjimo API pozive.
//
// ENV (po želji):
// - NEXT_PUBLIC_API_FOOTBALL_KEY ili API_FOOTBALL_KEY  → API-FOOTBALL fixtures
// - ODDS_API_KEY                                       → The Odds API (opciono; za kvote)
// - TRUSTED_BOOKIES                                    → CSV lista dozvoljenih bookija

const BAN_REGEX =
  /(U-?\d{1,2}\b|\bU\d{1,2}\b|Under\s?\d{1,2}|Reserve|Reserves|B Team|B-Team|\bB$|\bII\b|Youth|Women|Girls|Development|Academy)/i;

const TZ = "Europe/Belgrade";

// ---------- simple in-memory cache ----------
const _cache = {
  // key: JSON.stringify({ hours, tb: process.env.TRUSTED_BOOKIES })
  // value: { ts: number(ms), data: any }
};
const TTL_MS = 120 * 1000; // 120s

function cacheGet(key) {
  const e = _cache[key];
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) return null;
  return e.data;
}
function cacheSet(key, data) {
  _cache[key] = { ts: Date.now(), data };
}

// ---------- helpers ----------
function parseTrusted() {
  const list = (process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}
function toDecimal(x) {
  if (x === null || x === undefined) return null;
  let s = String(x).trim();
  s = s.replace(",", ".").replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function normalizeOdds(o) {
  const n = toDecimal(o);
  if (!Number.isFinite(n)) return null;
  if (n < 1.5 || n > 20) return null; // MIN 1.50, MAX 20
  return n;
}
function ymd(date) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}
function addHours(date, h) {
  return new Date(date.getTime() + h * 3600 * 1000);
}
function safeGet(obj, path, def = undefined) {
  try {
    return path.split(".").reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj) ?? def;
  } catch {
    return def;
  }
}
function isoFromAPIFootball(fix) {
  const t = fix?.fixture?.date;
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const MM = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}

// ---------- upstream: API-FOOTBALL fixtures ----------
async function fetchFixtures(hours = 24) {
  const key = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return [];

  const now = new Date();
  const until = addHours(now, Math.max(1, Math.min(72, Number(hours) || 24)));
  const from = ymd(now);
  const to = ymd(until);

  const url = `https://v3.football.api-sports.io/fixtures?from=${from}&to=${to}&timezone=${encodeURIComponent(
    TZ
  )}`;

  const r = await fetch(url, {
    headers: { "x-apisports-key": key },
  });
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

// ---------- upstream: The Odds API (opciono) ----------
async function fetchOddsForFixtures(fixtures, trusted) {
  const key = process.env.ODDS_API_KEY;
  if (!key || !Array.isArray(fixtures) || fixtures.length === 0) return fixtures;

  // Jedan poziv — bez per-fixture lupanja
  const url = `https://api.the-odds-api.com/v4/sports/soccer/odds?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(
    key
  )}`;

  let odds = [];
  try {
    const r = await fetch(url);
    if (r.ok) {
      const arr = await r.json();
      odds = Array.isArray(arr) ? arr : [];
    }
  } catch {
    return fixtures;
  }

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  const out = fixtures.map((fx) => {
    const home = norm(fx?.teams?.home?.name);
    const away = norm(fx?.teams?.away?.name);

    let candidates = [];
    for (const ev of odds) {
      const comps = Array.isArray(ev?.bookmakers) ? ev.bookmakers : [];
      const okBooks = comps.filter((b) => trusted.size === 0 || trusted.has(String(b?.key || "").toLowerCase()));
      if (okBooks.length === 0) continue;

      let matched = false;
      for (const b of okBooks) {
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

  return out;
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const hours = Math.max(1, Math.min(72, Number(req.query.hours) || 24));
    const trusted = parseTrusted();

    // CACHE KEY (hours + trusted lista utiče na rezultat)
    const ckey = JSON.stringify({ hours, tb: process.env.TRUSTED_BOOKIES || "" });
    const cached = cacheGet(ckey);
    if (cached) {
      return res.status(200).json({ ok: true, hours, football: cached, cached: true });
    }

    let fixtures = await fetchFixtures(hours);
    fixtures = await fetchOddsForFixtures(fixtures, trusted);

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

        return {
          ...m,
          market_odds: odds,
          market_odds_decimal: odds,
          books_used: onlyTrusted,
        };
      });

    cacheSet(ckey, final);
    res.status(200).json({ ok: true, hours, football: final, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
