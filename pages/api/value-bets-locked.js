// pages/api/value-bets.js
// Generator kandidata za sve mečeve dana (FOOTBALL) sa trusted-consensus kvotama.
// EV≥0 za sve markete (1X2 ima SAFE izuzetak), high-odds garde za BTTS/OU,
// "jedan predlog po meču" i kratko "Zašto" iz forme (H2H ako je dostupno).

export const config = { api: { bodyParser: false } };

// ---------- ENV & CONST ----------
const BASE = "https://v3.football.api-sports.io";
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

const MIN_ODDS = parseFloat(process.env.MIN_ODDS || "1.50");

const TRUSTED_SPREAD_MAX = parseFloat(process.env.TRUSTED_SPREAD_MAX || "0.12"); // 12%
const TRUSTED_UPLIFT_CAP = parseFloat(process.env.TRUSTED_UPLIFT_CAP || "0.08"); // +8%
const ALL_SPREAD_MAX     = parseFloat(process.env.ALL_SPREAD_MAX || "0.12");     // 12%
const ONE_TRUSTED_TOL    = parseFloat(process.env.ONE_TRUSTED_TOL || "0.05");    // ±5%

// High-odds garde (za BTTS/OU)
const HIGH_ODDS_BUFFER_PP = parseFloat(process.env.HIGH_ODDS_BUFFER_PP || "2");     // EV ≥ +2pp kada kvota >2.60
const HIGH_ODDS_STRICT_AT = parseFloat(process.env.HIGH_ODDS_STRICT_AT || "3.00");  // ako kvota >3.00 → trusted≥3 & ukupno≥10

const VB_CANDIDATE_MAX = parseInt(process.env.VB_CANDIDATE_MAX || "90", 10);

const TRUSTED_BOOKIES = String(process.env.TRUSTED_BOOKIES || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ---------- helpers: time ----------
function ymdTZ(d = new Date(), tz = TZ) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}

// ---------- helpers: AF fetch ----------
async function afGet(path) {
  const key =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key, Accept: "application/json" },
    cache: "no-store",
  });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await r.text().catch(() => "");
    throw new Error(`AF ${path} ${r.status}: ${text.slice(0, 180)}`);
  }
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

// ---------- math utils ----------
function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
function spreadRatio(arr) {
  if (!arr?.length) return null;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (min <= 0) return null;
  return (max - min) / ((max + min) / 2); // relativni raspon oko sredine
}
function impliedFromOdds(odds) {
  const o = Number(odds);
  return o > 0 ? 1 / o : null;
}
function edgeRatio(modelProb, impliedProb) {
  if (!Number.isFinite(modelProb) || !Number.isFinite(impliedProb) || impliedProb <= 0) return null;
  return modelProb / impliedProb - 1;
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// ---------- learning overlay (per league + market) ----------
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
async function kvGET(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  try {
    const js = await r.json();
    return js && typeof js === "object" && "result" in js ? js.result : js;
  } catch {
    return null;
  }
}
async function loadOverlay() {
  try {
    const raw = await kvGET("learn:overlay:current");
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function overlayFor(overlay, leagueId, market) {
  try {
    const o = overlay?.[String(leagueId)]?.[market];
    return typeof o === "number" ? o : 0;
  } catch {
    return 0;
  }
}

// ---------- odds parsing (API-FOOTBALL) ----------
function collectOddsFromAF(oddsResponse) {
  // Structure we build:
  // { x12: { home:[], draw:[], away:[] }, btts: { yes:[], no:[] }, ou25: { over:[], under:[] } }
  const out = {
    x12: { home: [], draw: [], away: [] },
    btts: { yes: [], no: [] },
    ou25: { over: [], under: [] },
  };

  for (const row of oddsResponse || []) {
    const books = row?.bookmakers || [];
    for (const bk of books) {
      const book = String(bk?.name || "").toLowerCase();
      const bets = bk?.bets || [];
      for (const bet of bets) {
        const name = String(bet?.name || "").toLowerCase();
        const values = bet?.values || [];

        // 1X2
        if (name.includes("match winner") || name === "1x2" || name.includes("winner")) {
          for (const v of values) {
            const val = String(v?.value || "").toLowerCase();
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || odd <= 1.01) continue;
            if (val.includes("home") || val === "1") out.x12.home.push({ book, odds: odd });
            else if (val.includes("draw") || val === "x") out.x12.draw.push({ book, odds: odd });
            else if (val.includes("away") || val === "2") out.x12.away.push({ book, odds: odd });
          }
        }

        // BTTS
        if (name.includes("both teams") || name.includes("btts")) {
          for (const v of values) {
            const val = String(v?.value || "").toLowerCase();
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || odd <= 1.01) continue;
            if (val === "yes") out.btts.yes.push({ book, odds: odd });
            if (val === "no") out.btts.no.push({ book, odds: odd });
          }
        }

        // Over/Under (2.5)
        if (name.includes("over/under") || name.includes("over under") || name.includes("totals") || name.includes("goals")) {
          for (const v of values) {
            const label = String(v?.value || "").toLowerCase();
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || odd <= 1.01) continue;
            // pokušaj da nađeš granicu 2.5 – label "Over 2.5" ili samo "2.5"
            if (label.includes("over 2.5") || label === "2.5" || (label.includes("over") && label.includes("2.5"))) {
              out.ou25.over.push({ book, odds: odd });
            }
            if (label.includes("under 2.5") || (label.includes("under") && label.includes("2.5"))) {
              out.ou25.under.push({ book, odds: odd });
            }
          }
        }
      }
    }
  }

  return out;
}

function pickConsensusOdds(list) {
  const all = list.map((x) => x.odds);
  if (!all.length) return null;

  const trusted = list.filter((x) => TRUSTED_BOOKIES.includes(x.book)).map((x) => x.odds);
  const trustedCount = trusted.length;
  const allSpread = spreadRatio(all);

  // ≥2 trusted → koristimo median(trusted) uz "uplift cap", ali ne preko njihovog maksimuma
  if (trustedCount >= 2) {
    const tSpread = spreadRatio(trusted);
    if (tSpread != null && tSpread <= TRUSTED_SPREAD_MAX) {
      const tMed = median(trusted);
      const tMax = Math.max(...trusted);
      const capped = Math.min(tMax, tMed * (1 + TRUSTED_UPLIFT_CAP));
      return { odds: capped, src: "trusted≥2", bookmakers_count: all.length, bookmakers_count_trusted: trustedCount };
    }
    return null;
  }

  // tačno 1 trusted → uzmi median(all) ako je blizu tog jednog (±5%)
  if (trustedCount === 1) {
    const tOnly = trusted[0];
    const aMed = median(all);
    if (aMed && Math.abs(aMed - tOnly) / tOnly <= ONE_TRUSTED_TOL) {
      return { odds: aMed, src: "trusted=1+all", bookmakers_count: all.length, bookmakers_count_trusted: 1 };
    }
    return null;
  }

  // 0 trusted → treba 6+ knjiga i mali spread
  if (all.length >= 6 && allSpread != null && allSpread <= ALL_SPREAD_MAX) {
    return { odds: median(all), src: "all-median", bookmakers_count: all.length, bookmakers_count_trusted: 0 };
  }

  return null;
}

// ---------- Confidence ----------
function withConfidence(basePct, bookmakersCount, trustedCount, overlayPP = 0) {
  let c = Math.round(basePct);

  // više izvora -> veći signal
  if (bookmakersCount >= 6) c += 1;
  if (bookmakersCount >= 10) c += 1;
  if (bookmakersCount >= 12) c += 1; // dodatni +1 za 12+ knjiga

  // „trusted” knjige teže više
  if (trustedCount >= 2) c += 1;
  if (trustedCount >= 4) c += 1;

  // uči iz overlay-a (±3pp cap)
  c += Math.max(-3, Math.min(3, Math.round(overlayPP)));

  // bezbedni pragovi + povrat Top ≥ 90%
  c = clamp(c, 35, 97);
  return c;
}

// ---------- Model (simple Poisson) ----------
function avgGoalsFor(list, teamId) {
  let s = 0,
    n = 0;
  for (const fx of list || []) {
    const sc = fx?.score?.fulltime || fx?.score || {};
    const h = Number(sc.home ?? fx?.goals?.home ?? 0);
    const a = Number(sc.away ?? fx?.goals?.away ?? 0);
    const hid = fx?.teams?.home?.id,
      aid = fx?.teams?.away?.id;
    if (hid == null || aid == null) continue;
    if (hid === teamId) {
      s += h;
      n++;
    } else if (aid === teamId) {
      s += a;
      n++;
    }
  }
  return n ? s / n : 1.2; // baseline
}
function avgGoalsAgainst(list, teamId) {
  let s = 0,
    n = 0;
  for (const fx of list || []) {
    const sc = fx?.score?.fulltime || fx?.score || {};
    const h = Number(sc.home ?? fx?.goals?.home ?? 0);
    const a = Number(sc.away ?? fx?.goals?.away ?? 0);
    const hid = fx?.teams?.home?.id,
      aid = fx?.teams?.away?.id;
    if (hid == null || aid == null) continue;
    if (hid === teamId) {
      s += a;
      n++;
    } else if (aid === teamId) {
      s += h;
      n++;
    }
  }
  return n ? s / n : 1.0; // baseline
}
function deriveLambdas(hLast, aLast, homeId, awayId) {
  const hFor = avgGoalsFor(hLast, homeId);
  const hAga = avgGoalsAgainst(hLast, homeId);
  const aFor = avgGoalsFor(aLast, awayId);
  const aAga = avgGoalsAgainst(aLast, awayId);
  // jednostavna fuzija napada/odbrane
  const lambdaH = clamp((hFor + aAga) / 2, 0.2, 3.2);
  const lambdaA = clamp((aFor + hAga) / 2, 0.2, 3.2);
  return { lambdaH, lambdaA };
}
function poisPMF(l, k) {
  // e^-l * l^k / k!
  return Math.exp(-l) * Math.pow(l, k) / fact(k);
}
const factMemo = new Map([[0, 1]]);
function fact(n) {
  if (factMemo.has(n)) return factMemo.get(n);
  let v = factMemo.get(n - 1) * n;
  factMemo.set(n, v);
  return v;
}
function prob1X2(lambdaH, lambdaA, cap = 10) {
  let pH = 0,
    pD = 0,
    pA = 0;
  for (let i = 0; i <= cap; i++) {
    const ph = poisPMF(lambdaH, i);
    for (let j = 0; j <= cap; j++) {
      const pa = poisPMF(lambdaA, j);
      const pij = ph * pa;
      if (i > j) pH += pij;
      else if (i === j) pD += pij;
      else pA += pij;
    }
  }
  return { pHome: pH, pDraw: pD, pAway: pA };
}
function probOver25(lambdaH, lambdaA, cap = 10) {
  let p = 0;
  for (let i = 0; i <= cap; i++) {
    const ph = poisPMF(lambdaH, i);
    for (let j = 0; j <= cap; j++) {
      const pa = poisPMF(lambdaA, j);
      if (i + j >= 3) p += ph * pa;
    }
  }
  return p;
}
function probBTTS(lambdaH, lambdaA) {
  // 1 - P(H=0) - P(A=0) + P(H=0 ∧ A=0)
  return 1 - Math.exp(-lambdaH) - Math.exp(-lambdaA) + Math.exp(-(lambdaH + lambdaA));
}

// ---------- "Zašto" tekst ----------
function formWDL(list, teamId) {
  let W = 0,
    D = 0,
    L = 0,
    GF = 0,
    GA = 0;
  for (const fx of (list || []).slice(0, 5)) {
    const sc = fx.score?.fulltime || fx.score || {};
    const h = Number(sc.home ?? fx.goals?.home ?? 0);
    const a = Number(sc.away ?? fx.goals?.away ?? 0);
    const hid = fx.teams?.home?.id,
      aid = fx.teams?.away?.id;
    if (hid == null || aid == null) continue;
    const my = hid === teamId ? h : a;
    const opp = hid === teamId ? a : h;
    GF += my;
    GA += opp;
    if (my > opp) W++;
    else if (my === opp) D++;
    else L++;
  }
  return { W, D, L, GF, GA };
}
function h2hWDL(list, homeId) {
  let W = 0,
    D = 0,
    L = 0,
    GF = 0,
    GA = 0; // W for home team
  for (const fx of (list || []).slice(0, 5)) {
    const sc = fx.score?.fulltime || fx.score || {};
    const h = Number(sc.home ?? fx.goals?.home ?? 0);
    const a = Number(sc.away ?? fx.goals?.away ?? 0);
    GF += h;
    GA += a;
    if (h > a) W++;
    else if (h === a) D++;
    else L++;
  }
  return { W, D, L, GF, GA };
}

// ---------- Exclusions (po želji dopuni) ----------
function isExcludedLeagueOrTeam(_fx) {
  // Ostavljen hook ako želiš da isključiš youth/rezerve itd.
  return false;
}

// ---------- build kandidata za fixture ----------
function makePickFromFixture({
  fixture,
  market,
  selection,
  modelProb,
  consensus,
  overlayPP,
  explainLines,
}) {
  const implied = impliedFromOdds(consensus?.odds);
  const evRatio = edgeRatio(modelProb, implied);
  const mp = Math.round(modelProb * 100);
  const ip = Math.round((implied || 0) * 100);
  const evp = Number.isFinite(evRatio) ? Math.round(evRatio * 1000) / 10 : null;

  const conf = withConfidence(mp, consensus.bookmakers_count || 0, consensus.bookmakers_count_trusted || 0, overlayPP || 0);

  return {
    fixture_id: fixture?.fixture?.id,
    teams: {
      home: { id: fixture?.teams?.home?.id, name: fixture?.teams?.home?.name },
      away: { id: fixture?.teams?.away?.id, name: fixture?.teams?.away?.name },
    },
    league: {
      id: fixture?.league?.id,
      name: fixture?.league?.name,
      country: fixture?.league?.country,
      season: fixture?.league?.season,
    },
    datetime_local: {
      starting_at: { date_time: String(fixture?.fixture?.date || "").replace(" ", "T") },
    },
    market,
    market_label: market,
    selection,
    type: "MODEL+ODDS",
    model_prob: Number(modelProb),
    market_odds: Number(consensus?.odds || 0),
    implied_prob: implied,
    edge: evRatio,
    edge_pp: Number.isFinite(evRatio) ? (modelProb - implied) * 100 : null,
    ev: evRatio,
    movement_pct: 0,
    confidence_pct: conf,
    bookmakers_count: Number(consensus?.bookmakers_count || 0),
    bookmakers_count_trusted: Number(consensus?.bookmakers_count_trusted || 0),
    explain: {
      summary: `Model ${mp}% vs ${ip}% · EV ${evp}% · Bookies ${consensus.bookmakers_count} (trusted ${consensus.bookmakers_count_trusted})`,
      bullets: explainLines || [],
    },
  };
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const overlay = await loadOverlay(); // {}
    const date = ymdTZ(); // današnji dan po TZ

    // Fixtures za danas (NS/TBD)
    const fixtures = await afGet(`/fixtures?date=${date}`);
    const candidatesAll = fixtures.filter((fx) => {
      const st = String(fx?.fixture?.status?.short || "").toUpperCase();
      return (st === "NS" || st === "TBD") && !isExcludedLeagueOrTeam(fx);
    });

    const outCandidatesByFixture = new Map();
    let calls_used = 1;

    const MAX_FIX = Math.min(candidatesAll.length, VB_CANDIDATE_MAX);

    for (let idx = 0; idx < MAX_FIX; idx++) {
      const fx = candidatesAll[idx];
      const homeId = fx?.teams?.home?.id;
      const awayId = fx?.teams?.away?.id;
      if (!homeId || !awayId) continue;

      // L5 forma (2 poziva)
      let hLast = [],
        aLast = [];
      try {
        hLast = await afGet(`/fixtures?team=${homeId}&last=5`);
        calls_used++;
      } catch {}
      try {
        aLast = await afGet(`/fixtures?team=${awayId}&last=5`);
        calls_used++;
      } catch {}

      // H2H (1 poziv, opcionalno)
      let h2h = [],
        h2hOk = false;
      try {
        h2h = await afGet(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=5`);
        h2hOk = true;
        calls_used++;
      } catch {}

      // Model: lambde + verovatnoće
      const { lambdaH, lambdaA } = deriveLambdas(hLast, aLast, homeId, awayId);
      const { pHome, pDraw, pAway } = prob1X2(lambdaH, lambdaA);
      const pOver25 = probOver25(lambdaH, lambdaA);
      const pBTTS = probBTTS(lambdaH, lambdaA);

      // Odds (1 poziv)
      let oddsRaw = [];
      try {
        oddsRaw = await afGet(`/odds?fixture=${fx?.fixture?.id}`);
        calls_used++;
      } catch {}
      const perBook = collectOddsFromAF(oddsRaw);

      // 1X2: uzmi onaj ishod sa najvećom model verovatnoćom
      let x12Sel = null;
      let x12Prob = 0;
      if (pHome >= pDraw && pHome >= pAway) {
        x12Sel = "HOME";
        x12Prob = pHome;
      } else if (pAway >= pHome && pAway >= pDraw) {
        x12Sel = "AWAY";
        x12Prob = pAway;
      } else {
        x12Sel = "DRAW";
        x12Prob = pDraw;
      }
      const x12Consensus =
        x12Sel === "HOME"
          ? pickConsensusOdds(perBook.x12.home)
          : x12Sel === "AWAY"
          ? pickConsensusOdds(perBook.x12.away)
          : pickConsensusOdds(perBook.x12.draw);

      // BTTS Yes
      const bttsConsensus = pickConsensusOdds(perBook.btts.yes);

      // Over 2.5
      const ouOverConsensus = pickConsensusOdds(perBook.ou25.over);

      // Kandidati po marketu (filtrirani po kvoti i EV pravilima)
      const cand = [];

      // 1X2 kandidat (dozvoli blago negativan EV ako je kvota ≥ MIN_ODDS i imamo dovoljno trusted)
      if (x12Consensus && x12Consensus.odds >= MIN_ODDS) {
        const imp = impliedFromOdds(x12Consensus.odds);
        const ev = edgeRatio(x12Prob, imp);
        // 1X2 "safe" izuzetak: dozvoli do -1.5pp ako je pouzdan consensus
        const ok = ev >= 0 || (ev > -0.015 && (x12Consensus.bookmakers_count_trusted || 0) >= 2);
        if (ok) {
          const explainX = [];
          const hf = formWDL(hLast, homeId);
          const af = formWDL(aLast, awayId);
          explainX.push(
            `L5 Home ${hf.W}-${hf.D}-${hf.L} (GF ${hf.GF}, GA ${hf.GA})`,
            `L5 Away ${af.W}-${af.D}-${af.L} (GF ${af.GF}, GA ${af.GA})`
          );
          if (h2hOk) {
            const hh = h2hWDL(h2h, homeId);
            explainX.push(`H2H last 5: ${hh.W}-${hh.D}-${hh.L} (GF ${hh.GF}, GA ${hh.GA})`);
          }
          const overlayPP = overlayFor(overlay, fx?.league?.id, "1X2");
          cand.push(
            makePickFromFixture({
              fixture: fx,
              market: "1X2",
              selection: x12Sel,
              modelProb: x12Prob,
              consensus: x12Consensus,
              overlayPP,
              explainLines: explainX,
            })
          );
        }
      }

      // BTTS Yes kandidat (zahtevaj EV≥0; dodatna guarda za visoke kvote)
      if (bttsConsensus && bttsConsensus.odds >= MIN_ODDS) {
        const imp = impliedFromOdds(bttsConsensus.odds);
        const ev = edgeRatio(pBTTS, imp);
        const isHigh = bttsConsensus.odds >= 2.6;
        const strict = bttsConsensus.odds >= HIGH_ODDS_STRICT_AT;
        const okHigh = !isHigh || (ev * 100 >= HIGH_ODDS_BUFFER_PP);
        const okStrict =
          !strict ||
          ((bttsConsensus.bookmakers_count_trusted || 0) >= 3 && (bttsConsensus.bookmakers_count || 0) >= 10);
        if (ev >= 0 && okHigh && okStrict) {
          const overlayPP = overlayFor(overlay, fx?.league?.id, "BTTS");
          cand.push(
            makePickFromFixture({
              fixture: fx,
              market: "BTTS",
              selection: "YES",
              modelProb: pBTTS,
              consensus: bttsConsensus,
              overlayPP,
              explainLines: ["BTTS model vs market (YES)"],
            })
          );
        }
      }

      // Over 2.5 kandidat (zahtevaj EV≥0; garde za visoke kvote kao i za BTTS)
      if (ouOverConsensus && ouOverConsensus.odds >= MIN_ODDS) {
        const imp = impliedFromOdds(ouOverConsensus.odds);
        const ev = edgeRatio(pOver25, imp);
        const isHigh = ouOverConsensus.odds >= 2.6;
        const strict = ouOverConsensus.odds >= HIGH_ODDS_STRICT_AT;
        const okHigh = !isHigh || (ev * 100 >= HIGH_ODDS_BUFFER_PP);
        const okStrict =
          !strict ||
          ((ouOverConsensus.bookmakers_count_trusted || 0) >= 3 && (ouOverConsensus.bookmakers_count || 0) >= 10);
        if (ev >= 0 && okHigh && okStrict) {
          const overlayPP = overlayFor(overlay, fx?.league?.id, "OU 2.5");
          cand.push(
            makePickFromFixture({
              fixture: fx,
              market: "OU",
              selection: "OVER 2.5",
              modelProb: pOver25,
              consensus: ouOverConsensus,
              overlayPP,
              explainLines: ["Over/Under 2.5 (OVER)"],
            })
          );
        }
      }

      // Odaberi 1 predlog po meču: rang po (confidence desc, EV desc, raniji KO asc)
      if (cand.length) {
        cand.sort((a, b) => {
          if ((b.SAFE ? 1 : 0) !== (a.SAFE ? 1 : 0)) return (b.SAFE ? 1 : 0) - (a.SAFE ? 1 : 0);
          if ((b?.confidence_pct || 0) !== (a?.confidence_pct || 0)) return (b.confidence_pct || 0) - (a.confidence_pct || 0);
          const eva = Number.isFinite(a?.ev) ? a.ev : -Infinity;
          const evb = Number.isFinite(b?.ev) ? b.ev : -Infinity;
          if (evb !== eva) return evb - eva;
          const ta = Number(new Date(a?.datetime_local?.starting_at?.date_time || 0).getTime());
          const tb = Number(new Date(b?.datetime_local?.starting_at?.date_time || 0).getTime());
          return ta - tb;
        });
        const best = cand[0];
        outCandidatesByFixture.set(best.fixture_id, best);
      }
    }

    const out = Array.from(outCandidatesByFixture.values());
    out.sort((a, b) => {
      if ((b?.confidence_pct || 0) !== (a?.confidence_pct || 0)) return (b.confidence_pct || 0) - (a.confidence_pct || 0);
      const eva = Number.isFinite(a?.ev) ? a.ev : -Infinity;
      const evb = Number.isFinite(b?.ev) ? b.ev : -Infinity;
      if (evb !== eva) return evb - eva;
      const ta = Number(new Date(a?.datetime_local?.starting_at?.date_time || 0).getTime());
      const tb = Number(new Date(b?.datetime_local?.starting_at?.date_time || 0).getTime());
      return ta - tb;
    });

    res.status(200).json({
      value_bets: out,
      generated_at: new Date().toISOString(),
      calls_used,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
