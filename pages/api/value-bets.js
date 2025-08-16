// FILE: pages/api/value-bets.js
/**
 * Generator value-bets predloga zasnovan na API-Football:
 * - fixtures (danas)
 * - predictions po meču (model verovatnoće)
 * - odds po meču (kvote & implied)
 *
 * Vraća picks u formatu koji koristi ostatak sistema (MODEL+ODDS).
 * Endpoint je NAMERNO zatvoren za javnost (guard na vrhu) – poziva ga /api/cron/rebuild.
 */

export const config = { api: { bodyParser: false } };

// ---------- GUARD: dozvoli samo cron/internal pozive ----------
function isAllowed(req) {
  const h = req.headers || {};
  return (
    String(h["x-vercel-cron"] || "") === "1" ||
    String(h["x-internal"] || "") === "1"
  );
}

// ---------- ENV & helpers ----------
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

const CFG = {
  BUDGET_DAILY: num(process.env.AF_BUDGET_DAILY, 5000), // "meki" dnevni budžet, interno brojimo
  RUN_HARDCAP: num(process.env.AF_RUN_MAX_CALLS, 220),  // tvrdi cap za jednu rundu
  PASS1_CAP: num(process.env.AF_PASS1_CAP, 60),         // koliko kandidata maksimalno obrađujemo
  VB_MIN_BOOKIES: num(process.env.VB_MIN_BOOKIES, 3),   // minimum različitih kladionica za tržište
  MIN_ODDS: 1.30,                                       // filter kvota
};

const EXCLUDE_RE = new RegExp(
  process.env.VB_EXCLUDE_REGEX ||
    "(friendlies|friendly|club\\s*friendlies|\\bu\\s?23\\b|\\bu\\s?21\\b|\\bu\\s?20\\b|\\bu\\s?19\\b|reserves?|\\bii\\b|b\\s*team|youth|academy|trial|test|indoor|futsal|beach)",
  "i"
);

// Cache broja poziva (grubo) tokom jednog procesa
const RUNTIME = (global.__VBGEN__ = global.__VBGEN__ || {
  day: null,
  usedToday: 0,
  runCalls: 0,
});

function todayYMD() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll(".", "-");
}
function resetBudgetIfNewDay() {
  const d = todayYMD();
  if (RUNTIME.day !== d) {
    RUNTIME.day = d;
    RUNTIME.usedToday = 0;
  }
}
function tryChargeDaily(qty = 1) {
  resetBudgetIfNewDay();
  if (RUNTIME.usedToday + qty > CFG.BUDGET_DAILY) return false;
  RUNTIME.usedToday += qty;
  return true;
}
function tryChargeRun(qty = 1) {
  if (RUNTIME.runCalls + qty > CFG.RUN_HARDCAP) return false;
  RUNTIME.runCalls += qty;
  return true;
}

function impliedFromDecimal(o) {
  const x = Number(o);
  return Number.isFinite(x) && x > 1.01 ? 1 / x : null;
}
function toLocalISO(d) {
  // vraćamo "YYYY-MM-DD HH:MM" u lokalnom TZ (kao što ostatak koda očekuje)
  const fmtD = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const fmtT = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${fmtD.format(d)} ${fmtT.format(d)}`;
}

function normSelection1X2(predObj) {
  // API-Football predictions vraća percenta: "home", "draw", "away" (kao "52%")
  const p = (s) => {
    const n = Number(String(s || "").replace("%", "").trim());
    return Number.isFinite(n) ? n : null;
  };
  const h = p(predObj?.predictions?.[0]?.percent?.home);
  const d = p(predObj?.predictions?.[0]?.percent?.draw);
  const a = p(predObj?.predictions?.[0]?.percent?.away);

  const arr = [
    { key: "HOME", pct: h ?? -1 },
    { key: "DRAW", pct: d ?? -1 },
    { key: "AWAY", pct: a ?? -1 },
  ].sort((x, y) => y.pct - x.pct);

  const best = arr[0];
  if (!best || best.pct < 0) return null; // nema predikcije
  return { pick: best.key, pct: best.pct }; // procent u [0..100]
}

// ---------- API-Football fetch ----------
async function afFetch(path) {
  const KEY =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2 ||
    "";

  if (!KEY) throw new Error("API_FOOTBALL_KEY missing");

  if (!tryChargeDaily(1)) throw new Error("AF daily budget limit (soft) exceeded");
  if (!tryChargeRun(1)) throw new Error("AF run hardcap reached");

  const url = `https://v3.football.api-sports.io${path}`;
  const r = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`AF ${path} -> ${r.status} ${t}`);
  }
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j?.response) ? j.response : [];
}

// ---------- Glavni generator ----------
async function generatePicks() {
  // 1) Uzmi SVE mečeve za danas
  const ymd = todayYMD(); // već je u TZ
  const fixtures = await afFetch(`/fixtures?date=${ymd}`);

  // 2) Filtar: bez friendlies/youth/rezervi + samo oni sa future kickoff
  const now = Date.now();
  const base = fixtures
    .filter((f) => {
      const lname = `${f?.league?.name || ""} ${f?.league?.country || ""}`.trim();
      if (EXCLUDE_RE.test(lname)) return false;

      const iso = f?.fixture?.date ? new Date(f.fixture.date).getTime() : NaN;
      if (!Number.isFinite(iso) || iso <= now) return false;

      return true;
    })
    .slice(0, 400); // tvrdi limit za slučaj ogromnog broja utakmica

  // 3) Prođi kroz kandidate uz PASS1_CAP
  const out = [];
  for (const fx of base) {
    if (out.length >= CFG.PASS1_CAP) break;

    const fid = Number(fx?.fixture?.id);
    if (!fid) continue;

    // 3a) Predictions (1 poziv)
    let pred = null;
    try {
      pred = await afFetch(`/predictions?fixture=${fid}`);
    } catch {
      continue; // bez predikcije nema smisla
    }
    const best = normSelection1X2({ predictions: pred });
    if (!best) continue;

    // 3b) Odds (1 poziv) – pokušaj da nadjes 1X2 probu; ako nema, preskoči
    let odds = null;
    try {
      odds = await afFetch(`/odds?fixture=${fid}`);
    } catch {
      continue;
    }

    // Izvučemo 1X2 tržište; pokušaćemo preko "Match Winner" / "1X2"
    let odds1x2 = null;
    let bookmakersCount = 0;

    for (const row of odds) {
      const book = row?.bookmaker?.name || "";
      const markets = row?.bets || row?.markets || row?.bookmakers || row?.odds || [];
      // API-Football format zna da varira – pokrivamo najčešće varijante
      const allMarkets = Array.isArray(markets) ? markets : [];

      const m = allMarkets.find((m) => {
        const label = (m?.name || m?.label || m?.key || "").toLowerCase();
        return (
          label.includes("1x2") ||
          label.includes("match winner") ||
          label === "winner" ||
          label === "match-winner"
        );
      });

      if (m && Array.isArray(m?.values || m?.outcomes || m?.odd || m?.selections)) {
        bookmakersCount++;
        const vals =
          m.values || m.outcomes || m.odd || m.selections || [];

        // Izvučemo kvotu za naš best.pick
        const mapKey = {
          HOME: ["1", "home", "home team"],
          DRAW: ["x", "draw"],
          AWAY: ["2", "away", "away team"],
        }[best.pick] || [];

        const rowPick =
          vals.find((v) =>
            mapKey.includes(String(v?.value || v?.selection || v?.name || "").toLowerCase())
          ) || null;

        if (rowPick) {
          const dec =
            Number(rowPick?.odd || rowPick?.value || rowPick?.price || rowPick?.decimal);
          if (Number.isFinite(dec) && dec > CFG.MIN_ODDS) {
            // prva validna kvota koju smo našli – zadržimo je
            if (!odds1x2) odds1x2 = dec;
          }
        }
      }
    }

    if (!odds1x2 || bookmakersCount < CFG.VB_MIN_BOOKIES) continue;

    // 3c) Formiraj pick
    const modelPct = best.pct; // 0..100
    const modelProb = modelPct / 100;

    const implied = impliedFromDecimal(odds1x2); // ~0..1
    if (implied == null) continue;

    const edgePP = Math.round((modelProb - implied) * 1000) / 10; // u pp (1 decimal)
    if (edgePP < 0) {
      // ne guramo negativan EV; može se popustiti ako želiš
      continue;
    }

    // datetime u formatu koji koristi tvoj ostatak (local tz "YYYY-MM-DD HH:MM")
    const kickoffISO = fx?.fixture?.date ? new Date(fx.fixture.date) : null;
    if (!kickoffISO) continue;

    const localHM = toLocalISO(kickoffISO);

    // složi objekat
    const pick = {
      type: "MODEL+ODDS",
      _score: edgePP, // kao interni score za sortiranje
      fixture_id: fid,
      league: {
        id: fx?.league?.id,
        name: fx?.league?.name,
        country: fx?.league?.country,
      },
      teams: {
        home: fx?.teams?.home?.name,
        away: fx?.teams?.away?.name,
      },
      home_id: fx?.teams?.home?.id,
      away_id: fx?.teams?.away?.id,
      datetime_local: {
        starting_at: { date_time: localHM }, // (tvoj front to očekuje)
      },
      market: "1X2",
      market_label: "1X2",
      selection: best.pick, // "HOME" | "DRAW" | "AWAY"
      confidence_pct: Math.min(99, Math.max(1, Math.round(modelPct))), // 1..99
      model_prob: modelProb,
      market_odds: odds1x2,
      implied_prob: implied,
      edge_pp: edgePP, // (model-implied) * 100
      bookmakers_count: bookmakersCount,
      movement_pct: 0, // real-time drift radi /locked-floats kasnije
      explain: {
        summary: `Model ${Math.round(modelProb * 100)}% vs ${Math.round(
          implied * 100
        )}% · Bookies ${bookmakersCount}`,
      },
    };

    out.push(pick);
  }

  // sortiranje po _score (edge), zatim po kickoffu
  out.sort((a, b) => {
    if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
    const ta = new Date(a?.datetime_local?.starting_at?.date_time?.replace(" ", "T") || 0).getTime();
    const tb = new Date(b?.datetime_local?.starting_at?.date_time?.replace(" ", "T") || 0).getTime();
    return ta - tb;
  });

  return out;
}

// ---------- HTTP handler ----------
export default async function handler(req, res) {
  // guard
  if (!isAllowed(req)) {
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(403)
      .json({ error: "forbidden", note: "value-bets is cron/internal only" });
  }

  try {
    // reset run counter na početku jedne runde
    RUNTIME.runCalls = 0;

    const picks = await generatePicks();

    // cache headers (na generatoru no-store; na /locked-* stavljamo CDN)
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ value_bets: picks });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: String(e && e.message) });
  }
}
