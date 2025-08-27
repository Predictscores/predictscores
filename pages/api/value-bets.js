// FILE: pages/api/value-bets.js
// Seed za rebuild: fixtures (API-Football) + opcioni odds (API-Football /odds)
// KORISTI "date=" (ne from/to) da bi API-Football vraćao stabilno podatke.
// Ne diramo ENV nazive — koristi se samo API_FOOTBALL_KEY (server-side).

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const AF_BASE = "https://v3.football.api-sports.io";
const MAX_ODDS_REQUESTS = Number(process.env.MAX_ODDS_REQUESTS || 40); // koliko fixture-a maksimalno tražimo /odds
const ODDS_CONCURRENCY = Number(process.env.ODDS_CONCURRENCY || 6);   // paralelni zahtevi ka /odds

// BAN U-lige, Women, Reserves, Youth… (primena na name + round + stage)
const BAN_REGEX =
  /(?:^|[^A-Za-z0-9])U\s*-?\s*\d{1,2}s?(?:[^A-Za-z0-9]|$)|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

export default async function handler(req, res) {
  try {
    if (!API_FOOTBALL_KEY) {
      return res.status(200).json({ ok: false, error: "API_FOOTBALL_KEY missing" });
    }

    const slot = String(req.query?.slot || "am").toLowerCase();
    if (!["am", "pm", "late"].includes(slot)) {
      return res.status(200).json({ ok: false, error: "invalid slot" });
    }

    const todayYMD = ymdInTZ(new Date(), TZ);

    // 1) Fixtures ZA DANAS preko "date=" (stabilno na API-Football)
    const fixtures = await fetchFixturesByDate(todayYMD, TZ);
    if (!fixtures.length) {
      return res.status(200).json({
        ok: true,
        disabled: false,
        slot,
        value_bets: [],
        source: "fixtures-only", // nema podataka već na korenu
      });
    }

    // 2) Slot + BAN filter pre nego što trošimo pozive za kvote
    const candidates = fixtures.filter((fx) => {
      // BAN na više polja (league.name + round + stage)
      const leagueName = str(fx?.league?.name) || str(fx?.league_name);
      const round = str(fx?.league?.round) || str(fx?.round);
      const stage = str(fx?.league?.stage) || str(fx?.stage);
      if (BAN_REGEX.test(`${leagueName} ${round} ${stage}`)) return false;

      // slot window (danas + satnica)
      const iso = fx?.fixture?.date || fx?.date || null;
      return inSlotWindow(iso, TZ, slot);
    });

    if (!candidates.length) {
      return res.status(200).json({
        ok: true,
        disabled: false,
        slot,
        value_bets: [],
        source: "fixtures-only(slot)", // fixtures postoje, ali ne upadaju u slot posle BAN-a
      });
    }

    // 3) Pokušaj da za ograničen broj kandidata povučeš /odds (API-Football)
    const withOdds = await enrichWithOdds(candidates, {
      limit: MAX_ODDS_REQUESTS,
      concurrency: ODDS_CONCURRENCY,
    });

    // 4) Map u format koji ostatak sistema očekuje
    const value_bets = withOdds.map(toSeedRecord);
    const hadAnyOdds = withOdds.some((x) => x.__odds && x.__odds.best);

    return res.status(200).json({
      ok: true,
      disabled: false,
      slot,
      value_bets,
      source: hadAnyOdds ? "fixtures+odds" : "fixtures-only(seed)",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ====================== API-Football helpers ====================== */

async function fetchFixturesByDate(ymd, tz) {
  const url = `${AF_BASE}/fixtures?date=${ymd}&timezone=${encodeURIComponent(tz)}`;
  const r = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY, "cache-control": "no-store" },
  });

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const j = ct.includes("application/json") ? await r.json().catch(() => null) : null;
  const arr = Array.isArray(j?.response) ? j.response : [];

  // Zadrži samo mečeve koji nisu završeni/otkazani
  return arr.filter((x) => {
    const st = str(x?.fixture?.status?.short || x?.fixture?.status?.long || "");
    // isključi završeno i nevalidno (zadržavamo NS, 1H, HT, 2H, LIVE, ET…)
    return !/^FT$|^AET$|^PEN$|^CANC$|^WO$|^ABD$|^INT$|^SUSP$|^PST$/i.test(st);
  });
}

async function fetchOddsForFixture(fixtureId) {
  const url = `${AF_BASE}/odds?fixture=${fixtureId}&timezone=${encodeURIComponent(TZ)}`;
  const r = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY, "cache-control": "no-store" },
  });

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return null;

  const j = await r.json().catch(() => null);
  const rows = Array.isArray(j?.response) ? j.response : [];
  if (!rows.length) return null;

  // Kombinuj knjige → 1X2 / Match Winner best
  let home = null, draw = null, away = null;

  for (const row of rows) {
    const books = Array.isArray(row?.bookmakers) ? row.bookmakers : [];
    for (const bk of books) {
      const bets = Array.isArray(bk?.bets) ? bk.bets : [];
      for (const bet of bets) {
        const name = String(bet?.name || "").toLowerCase();
        if (!/match\s*winner|^1x2$|^winner$/.test(name)) continue;

        const vals = Array.isArray(bet?.values) ? bet.values : [];
        for (const v of vals) {
          const lbl = String(v?.value || v?.label || "").toLowerCase();
          const odd = num(v?.odd);
          if (!odd) continue;
          if (/(^|\b)(home|1)(\b|$)/.test(lbl)) home = max(home, odd);
          else if (/(^|\b)(draw|x)(\b|$)/.test(lbl)) draw = max(draw, odd);
          else if (/(^|\b)(away|2)(\b|$)/.test(lbl)) away = max(away, odd);
        }
      }
    }
  }

  const best = max(max(home, draw), away);
  const fav =
    best === null ? null : best === home ? "HOME" : best === draw ? "DRAW" : "AWAY";

  return { match_winner: { home, draw, away }, best, fav };
}

async function enrichWithOdds(items, { limit = 40, concurrency = 6 } = {}) {
  const out = [];
  const queue = items.slice(0, Math.max(1, limit));
  let idx = 0;

  async function worker() {
    while (idx < queue.length) {
      const i = idx++;
      const fx = queue[i];
      let odds = null;
      try {
        odds = await fetchOddsForFixture(fx?.fixture?.id);
      } catch {
        odds = null;
      }
      out[i] = { ...fx, __odds: odds };
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    worker
  );
  await Promise.all(workers);

  // dodaj i ostatak (bez kvota), ako je presečeno limitom
  return out.concat(items.slice(queue.length));
}

/* ====================== Mapping & Utils ====================== */

function toSeedRecord(row) {
  const fx = row?.fixture || {};
  const lg = row?.league || {};
  const tm = row?.teams || {};
  const isoUTC = fx?.date ? String(fx.date).replace(" ", "T") : null;
  const local = isoUTC ? toLocalDateTime(isoUTC, TZ) : null;

  const homeName = str(tm?.home?.name);
  const awayName = str(tm?.away?.name);

  // odds polja koja "rebuild" ume da pročita (best, market_odds, itd.)
  const odds = row?.__odds || null;
  const best = num(odds?.best);
  const marketOdds = num(best);

  return {
    fixture_id: fx?.id ?? null,
    league: {
      id: lg?.id ?? null,
      name: lg?.name || null,
      country: lg?.country || null,
      round: lg?.round || null,
      stage: lg?.stage || null,
    },
    teams: {
      home: { id: tm?.home?.id ?? null, name: homeName || null },
      away: { id: tm?.away?.id ?? null, name: awayName || null },
    },
    datetime_local: local ? { starting_at: { date_time: local } } : null,

    // Minimalna meta (ostatak sistema očekuje ova polja)
    market: "1X2",
    market_label: "1X2",
    selection: odds?.fav || null,

    // kanali za čitanje kvote (rebuild.bestOdds proverava više polja)
    market_odds: marketOdds ?? null,
    market_odds_decimal: marketOdds ?? null,
    odds: {
      best: best ?? null,
      match_winner: {
        home: num(odds?.match_winner?.home),
        draw: num(odds?.match_winner?.draw),
        away: num(odds?.match_winner?.away),
      },
    },

    // Osnovni “confidence” (learning ga posle boostuje)
    confidence_pct: 50,
  };
}

/* ----- time/slot helpers ----- */

function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (s.split(",")[0] || s).trim();
}
function toLocalDateTime(iso, tz = TZ) {
  const d = new Date(iso);
  const y = d
    .toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .split(",")[0];
  const t = d
    .toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${y} ${t}`;
}
function inSlotWindow(iso, tz, slot) {
  if (!iso) return false;
  const d = new Date(iso);

  // isti dan (danas u lokalnom TZ)
  const ymd = ymdInTZ(d, tz);
  const today = ymdInTZ(new Date(), tz);
  if (ymd !== today) return false;

  const hourStr = d.toLocaleString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const h = Number(String(hourStr).split(":")[0]);

  if (slot === "late") return h >= 0 && h < 10;
  if (slot === "am") return h >= 10 && h < 15;
  if (slot === "pm") return h >= 15 && h < 24;
  return true;
}

/* ----- small utils ----- */

function str(x) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function max(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return a > b ? a : b;
}
