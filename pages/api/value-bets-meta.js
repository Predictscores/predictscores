// pages/api/value-bets-meta.js
// Read-only meta view: vraća iste stavke kao /api/value-bets-locked,
// prilaže meta (stats/injuries/H2H) i OPCIONO (query ?enrich=1) računa BLAGU
// korekciju confidence-a (±1–3 p.p.) na osnovu injuries + H2H procenata.
// Ne menja broj/izbor parova; ne piše u KV; potpuno bezbedno.

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

function computeAdjPP(item, meta) {
  if (!meta || typeof item?.confidence_pct !== "number") return 0;

  const market = String(item?.market || "").toUpperCase();
  const pick = String(item?.pick_code || item?.selection_code || "").toUpperCase();

  // --- Injuries signal (kao i ranije) ---
  const injH = Number(meta?.injuries?.homeCount || 0);
  const injA = Number(meta?.injuries?.awayCount || 0);
  const injTotal = injH + injA;

  let adj = 0;
  if (injTotal >= 4) {
    if (market === "OU2.5" && pick === "O2.5") adj -= 2;
    if (market === "BTTS" && (pick === "Y" || pick === "YES")) adj -= 2;
    if (market === "1X2" && (pick === "1" || pick === "2" || pick === "X")) adj -= 1;
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

  // --- H2H procente (NOVO): koristimo ih samo kad imamo ≥4 FT meča ---
  const h2hCnt = Number(meta?.h2h?.count || 0);
  const overPct = Number(meta?.h2h?.over2_5_pct || 0);
  const bttsPct = Number(meta?.h2h?.btts_pct || 0);
  const drawPct = Number(meta?.h2h?.draw_pct || 0);

  if (h2hCnt >= 4) {
    // OU2.5
    if (market === "OU2.5") {
      if (pick === "O2.5") {
        if (overPct >= 70) adj += 2; else if (overPct >= 60) adj += 1;
        if (overPct <= 30) adj -= 2; else if (overPct <= 40) adj -= 1;
      } else if (pick === "U2.5") {
        if (overPct <= 30) adj += 2; else if (overPct <= 40) adj += 1;
        if (overPct >= 70) adj -= 2; else if (overPct >= 60) adj -= 1;
      }
    }
    // BTTS
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
    // 1X2 — Draw samo (jer je robustno), ostale ne diramo
    if (market === "1X2" && pick === "X") {
      if (drawPct >= 40) adj += 2; else if (drawPct >= 33) adj += 1;
      if (drawPct <= 20) adj -= 1; // blaga penalizacija ako retko nerešeno
    }
  }

  return clamp(adj, -3, 3);
}

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    const wantEnrich = String(req.query?.enrich || "0") === "1";
    const base = process.env.BASE_URL || `https://${req.headers.host || "predictscores.vercel.app"}`;

    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const vb = await r.json();
    const items = Array.isArray(vb?.items) ? vb.items : [];
    const ymd = String(vb?.ymd || ymdBelgrade());

    if (!items.length) {
      return res.status(200).json({ ...vb, with_meta: !!(KV_BASE && KV_TOKEN), meta_attached: 0, applied_enrich: false });
    }

    let attached = 0, adjusted = 0;
    const out = [];

    for (const it of items) {
      const fixtureId = it?.fixture_id;
      let meta = null;
      if (fixtureId && KV_BASE && KV_TOKEN) {
        const key = `vb:meta:${ymd}:${slot}:${fixtureId}`;
        meta = await kvGet(key);
        if (meta && typeof meta === "object") attached++;
      }

      if (wantEnrich && typeof it?.confidence_pct === "number") {
        const adj = computeAdjPP(it, meta);
        if (adj !== 0) {
          const baseConf = Number(it.confidence_pct) || 0;
          const newConf = clamp(baseConf + adj, 30, 85);
          out.push({
            ...it,
            confidence_pct_adj: newConf,
            meta: { ...(meta || {}), confidence_adj_pp: adj, applied: true },
          });
          adjusted++;
          continue;
        }
      }

      if (meta) out.push({ ...it, meta: { ...meta, applied: false } });
      else out.push(it);
    }

    return res.status(200).json({
      ...vb,
      items: out,
      with_meta: !!(KV_BASE && KV_TOKEN),
      meta_attached: attached,
      applied_enrich: wantEnrich,
      adjusted_count: wantEnrich ? adjusted : 0,
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
