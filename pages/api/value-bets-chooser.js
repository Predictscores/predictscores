// pages/api/value-bets-chooser.js
// "Pametniji" izbor marketa nad već zaključanim parovima.
// - čita /api/value-bets-locked?slot=… (ne menja je)
// - prikači META iz KV (što je /api/cron/enrich već upisao)
// - blago koriguje confidence (±1–3 p.p.) na osnovu injuries + H2H%
// - izračuna EV iz p_eff i izabere globalno najbolje (bez per-fixture limita)
// - globalno preseče na ~15 (LIMIT_TOP)
// Bezbedno: read-only, ne piše u KV, ne dira postojeće liste/EV u bazi.

function toRestBase(s) {
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "");
  const m = s.match(/^rediss?:\/\/(?:[^@]*@)?([^:/?#]+)(?::\d+)?/i);
  if (m) return `https://${m[1]}`;
  return "";
}
const KV_BASE_RAW = (process.env.KV_REST_API_URL || process.env.KV_URL || "").trim();
const KV_BASE = toRestBase(KV_BASE_RAW);
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || "").trim();

async function kvGet(key) {
  if (!KV_BASE || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const t = await r.text();
    try { return JSON.parse(t); } catch { return null; }
  } catch {
    return null;
  }
}
function ymdBelgrade(d = new Date()) {
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Belgrade" }).slice(0, 10);
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function safeAverage(values) {
  if (!Array.isArray(values)) return null;
  const arr = values.filter(isFiniteNumber);
  if (!arr.length) return null;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function sumTwo(a, b) {
  const arr = [];
  if (isFiniteNumber(a)) arr.push(a);
  if (isFiniteNumber(b)) arr.push(b);
  if (!arr.length) return null;
  return arr.reduce((sum, v) => sum + v, 0);
}

function normalizeStats(metaStats) {
  if (!metaStats || typeof metaStats !== "object") {
    return { home: null, away: null };
  }
  const home = metaStats.home && typeof metaStats.home === "object" ? metaStats.home : null;
  const away = metaStats.away && typeof metaStats.away === "object" ? metaStats.away : null;
  return { home, away };
}

function getTeamValue(team, field, side, minSample = 5) {
  if (!team || typeof team !== "object") return null;
  const triple = team[field];
  if (!triple || typeof triple !== "object") return null;

  if (side === "home") {
    const sample = team?.played?.h;
    if (isFiniteNumber(sample) && sample >= minSample && isFiniteNumber(triple.h)) return triple.h;
  }
  if (side === "away") {
    const sample = team?.played?.a;
    if (isFiniteNumber(sample) && sample >= minSample && isFiniteNumber(triple.a)) return triple.a;
  }

  if (isFiniteNumber(triple.t)) return triple.t;

  const vals = [];
  if (isFiniteNumber(triple.h)) vals.push(triple.h);
  if (isFiniteNumber(triple.a)) vals.push(triple.a);
  return vals.length ? safeAverage(vals) : null;
}

function expectedGoalsFromStats(home, away) {
  const combos = [];

  const attackHome = sumTwo(
    getTeamValue(home, "gf_avg", "home"),
    getTeamValue(away, "ga_avg", "away")
  );
  if (isFiniteNumber(attackHome)) combos.push(attackHome);

  const attackAway = sumTwo(
    getTeamValue(away, "gf_avg", "away"),
    getTeamValue(home, "ga_avg", "home")
  );
  if (isFiniteNumber(attackAway)) combos.push(attackAway);

  const xgHome = sumTwo(
    isFiniteNumber(home?.xg?.f) ? home.xg.f : null,
    isFiniteNumber(away?.xg?.a) ? away.xg.a : null
  );
  if (isFiniteNumber(xgHome)) combos.push(xgHome);

  const xgAway = sumTwo(
    isFiniteNumber(away?.xg?.f) ? away.xg.f : null,
    isFiniteNumber(home?.xg?.a) ? home.xg.a : null
  );
  if (isFiniteNumber(xgAway)) combos.push(xgAway);

  if (!combos.length) return null;
  return safeAverage(combos);
}

function formScore(team) {
  if (!team || typeof team.form !== "string") return null;
  const cleaned = team.form.replace(/[^WDL]/gi, "").slice(-6);
  if (!cleaned) return null;
  let pts = 0;
  let matches = 0;
  for (const ch of cleaned) {
    const c = ch.toUpperCase();
    if (c === "W") pts += 3;
    else if (c === "D") pts += 1;
    matches += 1;
  }
  if (!matches) return null;
  return pts / matches;
}

// ista mikro-korekcija kao u value-bets-meta (injuries + H2H%)
// ograničeno na ±3 p.p., konzervativno
function computeAdjPP(item, meta) {
  if (!meta || typeof item?.confidence_pct !== "number") return 0;

  const market = String(item?.market || "").toUpperCase();
  const pick = String(item?.pick_code || item?.selection_code || "").toUpperCase();

  const injH = Number(meta?.injuries?.homeCount || 0);
  const injA = Number(meta?.injuries?.awayCount || 0);
  const injTotal = injH + injA;

  let adj = 0;
  if (injTotal >= 4) {
    if (market === "OU2.5" && pick === "O2.5") adj -= 2;
    if (market === "BTTS" && (pick === "Y" || pick === "YES")) adj -= 2;
    if (market === "1X2") adj -= 1;
  } else if (injTotal >= 2) {
    if (market === "OU2.5" && pick === "O2.5") adj -= 1;
    if (market === "BTTS" && (pick === "Y" || pick === "YES")) adj -= 1;
  }

  const { home: statsHome, away: statsAway } = normalizeStats(meta?.stats);
  if (statsHome || statsAway) {
    if (market === "OU2.5") {
      let statsAdj = 0;
      const overPctStat = safeAverage([
        getTeamValue(statsHome, "over25_pct", "home"),
        getTeamValue(statsAway, "over25_pct", "away"),
      ]);
      const underPctStat = safeAverage([
        getTeamValue(statsHome, "under25_pct", "home"),
        getTeamValue(statsAway, "under25_pct", "away"),
      ]);
      const expGoals = expectedGoalsFromStats(statsHome, statsAway);

      if (pick === "O2.5") {
        if (overPctStat !== null) {
          if (overPctStat >= 68) statsAdj += 2;
          else if (overPctStat >= 60) statsAdj += 1;
          if (overPctStat <= 35) statsAdj -= 2;
          else if (overPctStat <= 42) statsAdj -= 1;
        } else if (underPctStat !== null) {
          if (underPctStat >= 65) statsAdj -= 2;
          else if (underPctStat >= 55) statsAdj -= 1;
          if (underPctStat <= 35) statsAdj += 1;
        }
        if (expGoals !== null) {
          if (expGoals >= 3.4) statsAdj += 1;
          else if (expGoals <= 2.1) statsAdj -= 1;
        }
      } else if (pick === "U2.5") {
        if (underPctStat !== null) {
          if (underPctStat >= 65) statsAdj += 2;
          else if (underPctStat >= 55) statsAdj += 1;
          if (underPctStat <= 35) statsAdj -= 2;
          else if (underPctStat <= 45) statsAdj -= 1;
        } else if (overPctStat !== null) {
          if (overPctStat >= 68) statsAdj -= 2;
          else if (overPctStat >= 60) statsAdj -= 1;
          if (overPctStat <= 35) statsAdj += 1;
        }
        if (expGoals !== null) {
          if (expGoals <= 2.1) statsAdj += 1;
          else if (expGoals >= 3.4) statsAdj -= 1;
        }
      }

      adj += clamp(statsAdj, -2, 2);
    }

    if (market === "BTTS") {
      const yes = pick === "Y" || pick === "YES";
      let statsAdj = 0;
      const bttsPctStat = safeAverage([
        getTeamValue(statsHome, "btts_pct", "home"),
        getTeamValue(statsAway, "btts_pct", "away"),
      ]);
      const failPctStat = safeAverage([
        getTeamValue(statsHome, "fail_pct", "home"),
        getTeamValue(statsAway, "fail_pct", "away"),
      ]);
      const cleanPctStat = safeAverage([
        getTeamValue(statsHome, "clean_pct", "home"),
        getTeamValue(statsAway, "clean_pct", "away"),
      ]);

      if (yes) {
        if (bttsPctStat !== null) {
          if (bttsPctStat >= 68) statsAdj += 2;
          else if (bttsPctStat >= 60) statsAdj += 1;
          if (bttsPctStat <= 32) statsAdj -= 2;
          else if (bttsPctStat <= 40) statsAdj -= 1;
        }
        if (failPctStat !== null && failPctStat >= 45) statsAdj -= 1;
        if (cleanPctStat !== null && cleanPctStat >= 45) statsAdj -= 1;
      } else {
        if (bttsPctStat !== null) {
          if (bttsPctStat <= 32) statsAdj += 2;
          else if (bttsPctStat <= 40) statsAdj += 1;
          if (bttsPctStat >= 68) statsAdj -= 2;
          else if (bttsPctStat >= 60) statsAdj -= 1;
        }
        if (failPctStat !== null && failPctStat >= 45) statsAdj += 1;
        if (cleanPctStat !== null && cleanPctStat >= 45) statsAdj += 1;
      }

      adj += clamp(statsAdj, -2, 2);
    }

    if (market === "1X2") {
      let statsAdj = 0;
      const formHome = formScore(statsHome);
      const formAway = formScore(statsAway);

      if (pick === "1") {
        const winPct = getTeamValue(statsHome, "win_pct", "home");
        const losePct = getTeamValue(statsAway, "lose_pct", "away");
        const support = safeAverage([winPct, losePct]);
        if (support !== null) {
          if (support >= 68) statsAdj += 1;
          if (support >= 76) statsAdj += 1;
          if (support <= 42) statsAdj -= 1;
        }
        if (formHome !== null && formAway !== null) {
          const diff = formHome - formAway;
          if (diff >= 1.0) statsAdj += 1;
          else if (diff <= -1.0) statsAdj -= 1;
        }
      } else if (pick === "2") {
        const winPct = getTeamValue(statsAway, "win_pct", "away");
        const losePct = getTeamValue(statsHome, "lose_pct", "home");
        const support = safeAverage([winPct, losePct]);
        if (support !== null) {
          if (support >= 68) statsAdj += 1;
          if (support >= 76) statsAdj += 1;
          if (support <= 42) statsAdj -= 1;
        }
        if (formHome !== null && formAway !== null) {
          const diff = formAway - formHome;
          if (diff >= 1.0) statsAdj += 1;
          else if (diff <= -1.0) statsAdj -= 1;
        }
      } else if (pick === "X") {
        const drawPctHome = getTeamValue(statsHome, "draw_pct", "home");
        const drawPctAway = getTeamValue(statsAway, "draw_pct", "away");
        const drawSupport = safeAverage([drawPctHome, drawPctAway]);
        if (drawSupport !== null) {
          if (drawSupport >= 36) statsAdj += 1;
          if (drawSupport >= 42) statsAdj += 1;
          if (drawSupport <= 24) statsAdj -= 1;
        }
      }

      adj += clamp(statsAdj, -2, 2);
    }
  }

  const h2hCnt = Number(meta?.h2h?.count || 0);
  const overPct = Number(meta?.h2h?.over2_5_pct || 0);
  const bttsPct = Number(meta?.h2h?.btts_pct || 0);
  const drawPct = Number(meta?.h2h?.draw_pct || 0);

  if (h2hCnt >= 4) {
    if (market === "OU2.5") {
      if (pick === "O2.5") {
        if (overPct >= 70) adj += 2; else if (overPct >= 60) adj += 1;
        if (overPct <= 30) adj -= 2; else if (overPct <= 40) adj -= 1;
      } else if (pick === "U2.5") {
        if (overPct <= 30) adj += 2; else if (overPct <= 40) adj += 1;
        if (overPct >= 70) adj -= 2; else if (overPct >= 60) adj -= 1;
      }
    }
    if (market === "BTTS") {
      const yes = (pick === "Y" || pick === "YES");
      if (yes) {
        if (bttsPct >= 65) adj += 2; else if (bttsPct >= 55) adj += 1;
        if (bttsPct <= 35) adj -= 2; else if (bttsPct <= 45) adj -= 1;
      } else {
        if (bttsPct <= 35) adj += 2; else if (bttsPct <= 45) adj += 1;
        if (bttsPct >= 65) adj -= 2; else if (bttsPct >= 55) adj -= 1;
      }
    }
    if (market === "1X2" && pick === "X") {
      if (drawPct >= 40) adj += 2; else if (drawPct >= 33) adj += 1;
      if (drawPct <= 20) adj -= 1;
    }
  }

  return clamp(adj, -3, 3);
}

// bezbednosni capovi kvota po marketu (da izbegnemo egzotiku)
function priceCapOK(market, price) {
  if (!Number.isFinite(price)) return false;
  if (market === "OU2.5" || market === "BTTS") return price >= 1.3 && price <= 7.0;
  if (market === "1X2") return price >= 1.3 && price <= 10.0;
  if (market === "HT-FT" || market === "HTFT") return price >= 2.0 && price <= 20.0;
  return price >= 1.3 && price <= 12.0;
}

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    const base = process.env.BASE_URL || `https://${req.headers.host || "predictscores.vercel.app"}`;

    // 1) Učitaj zaključane parove
    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const vb = await r.json();
    const items = Array.isArray(vb?.items) ? vb.items : [];
    const ymd = String(vb?.ymd || ymdBelgrade());

    if (!items.length) {
      return res.status(200).json({ ok: true, slot, ymd, chosen: [], count: 0, reason: "no-items" });
    }

    // 2) Učitaj META za svaki pick (ako postoji)
    const withKV = !!(KV_BASE && KV_TOKEN);
    const enriched = [];
    for (const it of items) {
      const fixtureId = it?.fixture_id;
      let meta = null;
      if (withKV && fixtureId) {
        meta = await kvGet(`vb:meta:${ymd}:${slot}:${fixtureId}`);
      }
      // blaga korekcija confidence-a (±3 p.p.)
      let confAdj = Number(it?.confidence_pct) || 0;
      let adjPP = 0;
      if (meta && typeof it?.confidence_pct === "number") {
        adjPP = computeAdjPP(it, meta);
        confAdj = clamp(confAdj + adjPP, 30, 85);
      }

      // EV iz p_eff (koristimo model_prob kao osnovu; ovo je lokalni p_eff)
      const p_model = Number(it?.model_prob) || 0;
      const p_eff = clamp(p_model + (adjPP / 100), 0, 1); // p.p. → apsolutno
      const price = Number(it?.odds?.price) || NaN;
      const books = Number(it?.odds?.books_count) || 0;

      enriched.push({
        ...it,
        _meta: meta || null,
        _confidence_adj_pp: adjPP,
        _confidence_pct_adj: confAdj,
        _p_eff: p_eff,
        _ev_eff: Number.isFinite(price) ? (price * p_eff - 1) : -Infinity,
        _books_ok: books >= 2,                // <<< prag spušten: 2 (pre je bilo 3)
        _price_ok: priceCapOK(String(it.market).toUpperCase(), price),
      });
    }

    // 3) Filtri & rangiranje
    const filtered = enriched.filter(x => x._books_ok && x._price_ok);

    // UKINUT per-fixture limit: svi marketi konkurišu globalno
    const LIMIT_TOP = 15;
    filtered.sort((a,b) => (b._ev_eff - a._ev_eff));
    const chosen = filtered.slice(0, LIMIT_TOP);

    // 4) Očisti pomoćna polja u izlazu (ostavimo _ev_eff i _confidence_pct_adj radi transparentnosti)
    const out = chosen.map(it => ({
      fixture_id: it.fixture_id,
      market: it.market,
      pick: it.pick,
      pick_code: it.pick_code,
      selection_label: it.selection_label,
      model_prob: it.model_prob,
      confidence_pct: it.confidence_pct,
      confidence_pct_adj: it._confidence_pct_adj, // novo (može biti isto ako adj=0)
      odds: it.odds,
      league: it.league,
      league_name: it.league_name,
      league_country: it.league_country,
      teams: it.teams,
      home: it.home,
      away: it.away,
      kickoff: it.kickoff,
      kickoff_utc: it.kickoff_utc,
      _ev_eff: it._ev_eff,
      _p_eff: it._p_eff,
      _confidence_adj_pp: it._confidence_adj_pp,
      _meta: it._meta, // priložimo meta radi uvida (ne utiče na ništa)
    }));

    return res.status(200).json({
      ok: true,
      slot,
      ymd,
      count: out.length,
      chosen: out,
      note: "Chooser radi read-only nad zaključanim parovima; stara ruta ostaje netaknuta.",
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
