// pages/api/cron/enrich.js
// Enrichment za zaključane predloge (stats / injuries / H2H -> meta u KV)
// UVEK pišemo meta (stub kad fale ID/season), a kad imamo H2H,
// izračunamo procentualne “hintove” (over2_5_pct, btts_pct, draw_pct).
// Bezbedno: ne menja liste; samo piše meta ključeve.

const { afxTeamStats, afxInjuries, afxH2H, afxReadBudget } = require("../../../lib/sources/apiFootball");

// Keep a small buffer so lower-priority enrichment does not consume all API credits.
const SAFE_BUDGET_THRESHOLD = 320;

function toBudgetNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const num = Number(value.trim());
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

// --- KV helpers (REST) ---
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
  } catch { return null; }
}
async function kvSet(key, value) {
  if (!KV_BASE || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch { return false; }
}

function ymdBelgrade(d = new Date()) {
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Belgrade" }).slice(0, 10);
}

function isFinalStatus(s) {
  const x = String(s || "").toUpperCase();
  return /^FT|AET|PEN$/.test(x);
}

const TEAM_SIDE_KEYS = [
  ["home", "h"],
  ["away", "a"],
  ["total", "t"],
];

const clampNum = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function roundTo(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseNumeric(value, decimals = 2) {
  if (value === undefined || value === null) return null;
  let num;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    num = value;
  } else if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9+-.]/g, "");
    if (!cleaned) return null;
    num = Number(cleaned);
    if (!Number.isFinite(num)) return null;
  } else {
    return null;
  }
  if (typeof decimals === "number") {
    const rounded = roundTo(num, decimals);
    return rounded === null ? null : rounded;
  }
  return num;
}

function parsePercentValue(value, denominator, decimals = 0) {
  if (value === undefined || value === null) return null;

  if (typeof value === "string") {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const num = Number(match[0]);
    if (!Number.isFinite(num)) return null;
    return clampNum(roundTo(num, decimals), 0, 100);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value >= 0 && value <= 1) {
      return clampNum(roundTo(value * 100, decimals), 0, 100);
    }
    if (Number.isFinite(denominator) && denominator > 0) {
      return clampNum(roundTo((value / denominator) * 100, decimals), 0, 100);
    }
    if (value >= 0 && value <= 100) {
      return clampNum(roundTo(value, decimals), 0, 100);
    }
  }

  return null;
}

function getTripleNumbers(src, decimals = 2) {
  if (!src || typeof src !== "object") return null;
  const out = {};
  let have = false;
  for (const [srcKey, alias] of TEAM_SIDE_KEYS) {
    let raw = src[srcKey];
    if (raw && typeof raw === "object") {
      if ("total" in raw) raw = raw.total;
      else if ("value" in raw) raw = raw.value;
      else if ("count" in raw) raw = raw.count;
      else if ("games" in raw) raw = raw.games;
      else if ("number" in raw) raw = raw.number;
      else if ("all" in raw) raw = raw.all;
    }
    const num = parseNumeric(raw, decimals);
    if (num !== null) {
      out[alias] = num;
      have = true;
    }
  }
  return have ? out : null;
}

function readPercentageNode(node, denom, decimals = 0) {
  if (node === undefined || node === null) return null;
  if (typeof node === "object") {
    const candidates = [
      node.percentage,
      node.percent,
      node.pct,
      node.rate,
      node.ratio,
      node.value,
      node.total,
      node.count,
    ];
    for (const cand of candidates) {
      const pct = parsePercentValue(cand, denom, decimals);
      if (pct !== null) return pct;
    }
    return null;
  }
  return parsePercentValue(node, denom, decimals);
}

function extractPercentageTriple(src, played, decimals = 0) {
  if (!src || typeof src !== "object") return null;
  const out = {};
  let have = false;
  for (const [srcKey, alias] of TEAM_SIDE_KEYS) {
    const pct = readPercentageNode(src[srcKey], played?.[alias], decimals);
    if (pct !== null) {
      out[alias] = pct;
      have = true;
    }
  }

  if (!have) {
    const alt = src.percentage || src.percent || src.pct;
    if (alt && typeof alt === "object") {
      for (const [srcKey, alias] of TEAM_SIDE_KEYS) {
        const pct = readPercentageNode(alt[srcKey], played?.[alias], decimals);
        if (pct !== null) {
          out[alias] = pct;
          have = true;
        }
      }
    }
  }

  return have ? out : null;
}

function countsToPct(counts, played, decimals = 0) {
  if (!counts || !played) return null;
  const out = {};
  let have = false;
  for (const [, alias] of TEAM_SIDE_KEYS) {
    const pct = parsePercentValue(counts[alias], played?.[alias], decimals);
    if (pct !== null) {
      out[alias] = pct;
      have = true;
    }
  }
  return have ? out : null;
}

function pickFirstNumeric(values, decimals = 2) {
  if (!values) return null;
  const list = Array.isArray(values) ? values : [values];
  for (const value of list) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const nested = pickFirstNumeric(value, decimals);
      if (nested !== null) return nested;
      continue;
    }
    if (typeof value === "object") {
      const nested = pickFirstNumeric(
        [
          value.per_match,
          value.perMatch,
          value.average,
          value.avg,
          value.mean,
          value.total,
          value.value,
          value.count,
          value.all,
        ],
        decimals
      );
      if (nested !== null) return nested;
      continue;
    }
    const num = parseNumeric(value, decimals);
    if (num !== null) return num;
  }
  return null;
}

function extractExpectedXg(response) {
  const candidatesFor = [
    response?.expected?.goals?.for,
    response?.expected?.for,
    response?.expected_goals?.for,
    response?.goals?.for?.expected,
    response?.expected?.goals_for,
    response?.goals?.expected?.for,
  ];
  const candidatesAgainst = [
    response?.expected?.goals?.against,
    response?.expected?.against,
    response?.expected_goals?.against,
    response?.goals?.against?.expected,
    response?.expected?.goals_against,
    response?.goals?.expected?.against,
  ];

  const xgFor = pickFirstNumeric(candidatesFor, 2);
  const xgAgainst = pickFirstNumeric(candidatesAgainst, 2);

  if (xgFor === null && xgAgainst === null) return null;
  const out = {};
  if (xgFor !== null) out.f = xgFor;
  if (xgAgainst !== null) out.a = xgAgainst;
  return Object.keys(out).length ? out : null;
}

function extractNestedTriple(root, paths, played, decimals = 0) {
  for (const path of paths) {
    let node = root;
    let ok = true;
    for (const part of path) {
      if (!node || typeof node !== "object") {
        ok = false;
        break;
      }
      node = node[part];
    }
    if (!ok || !node) continue;
    const pct = extractPercentageTriple(node, played, decimals);
    if (pct) return pct;
    const counts = getTripleNumbers(node, 0);
    if (counts && played) {
      const pctFromCounts = countsToPct(counts, played, decimals);
      if (pctFromCounts) return pctFromCounts;
    }
  }
  return null;
}

function sanitizeForm(form) {
  if (!form) return "";
  return String(form)
    .replace(/[^WDL]/gi, "")
    .slice(-10);
}

function extractTeamStats(stats) {
  const response = stats?.response;
  if (!response || typeof response !== "object") return null;

  const out = {};

  const form = sanitizeForm(response.form);
  if (form) out.form = form;

  const played = getTripleNumbers(response?.fixtures?.played, 0);
  if (played) out.played = played;

  const gfAvg = getTripleNumbers(response?.goals?.for?.average, 2);
  if (gfAvg) out.gf_avg = gfAvg;

  const gaAvg = getTripleNumbers(response?.goals?.against?.average, 2);
  if (gaAvg) out.ga_avg = gaAvg;

  const gfTot = getTripleNumbers(response?.goals?.for?.total, 0);
  if (gfTot) out.gf_tot = gfTot;

  const gaTot = getTripleNumbers(response?.goals?.against?.total, 0);
  if (gaTot) out.ga_tot = gaTot;

  const winPct = extractNestedTriple(response, [["fixtures", "wins"]], played, 0);
  if (winPct) out.win_pct = winPct;

  const losePct = extractNestedTriple(response, [["fixtures", "loses"]], played, 0);
  if (losePct) out.lose_pct = losePct;

  const drawPct = extractNestedTriple(response, [["fixtures", "draws"]], played, 0);
  if (drawPct) out.draw_pct = drawPct;

  const bttsPct = extractNestedTriple(
    response,
    [["fixtures", "btts"], ["fixtures", "both_to_score"], ["fixtures", "bothteams_to_score"]],
    played,
    0
  );
  if (bttsPct) out.btts_pct = bttsPct;

  const overPct = extractNestedTriple(
    response,
    [
      ["fixtures", "goals", "over_2_5"],
      ["fixtures", "goals", "over25"],
      ["fixtures", "over_2_5"],
      ["fixtures", "over25"],
      ["goals", "over_2_5"],
      ["goals", "over25"],
    ],
    played,
    0
  );
  if (overPct) out.over25_pct = overPct;

  const underPct = extractNestedTriple(
    response,
    [
      ["fixtures", "goals", "under_2_5"],
      ["fixtures", "goals", "under25"],
      ["fixtures", "under_2_5"],
      ["fixtures", "under25"],
      ["goals", "under_2_5"],
      ["goals", "under25"],
    ],
    played,
    0
  );
  if (underPct) out.under25_pct = underPct;

  const cleanPct = extractNestedTriple(response, [["clean_sheet"]], played, 0);
  if (cleanPct) out.clean_pct = cleanPct;

  const failPct = extractNestedTriple(response, [["failed_to_score"]], played, 0);
  if (failPct) out.fail_pct = failPct;

  const xg = extractExpectedXg(response);
  if (xg) out.xg = xg;

  return Object.keys(out).length ? out : null;
}

export default async function handler(req, res) {
  try {
    const { slot = "am" } = req.query || {};
    const ymd = ymdBelgrade();
    const base = process.env.BASE_URL || `https://${req.headers.host || "predictscores.vercel.app"}`;

    // 1) Zaključani pickovi iz postojeće rute (ne diramo je)
    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const data = await r.json().catch(() => ({ items: [] }));
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      return res.status(200).json({
        ok: true,
        slot,
        ymd,
        enriched: 0,
        enriched_full: 0,
        stubbed: 0,
        reason: "no-items",
        budget_exhausted: false,
        budget_remaining: null,
        budget_stop_reason: null,
      });
    }

    let enriched = 0;        // ukupno zapisanih meta (stub + full)
    let enriched_full = 0;   // meta sa povučenim podacima (stats/inj/h2h)
    let stubbed = 0;         // stub meta kad fale ID/season
    const metaKeys = [];
    const metaListKey = `vb:meta:list:${ymd}:${slot}`;

    let budgetStop = false;
    let budgetStopReason = null;
    let budgetRemaining = null;
    let skipOutbound = false;

    for (const p of items) {
      if (budgetStop) break;
      try {
        const fixture_id = p?.fixture_id;
        const homeId = p?.teams?.home_id || p?.home_id;
        const awayId = p?.teams?.away_id || p?.away_id;
        const leagueId = p?.league?.id || p?.league_id;
        const season = p?.league?.season || p?.season;

        if (!skipOutbound) {
          try {
            const remainRaw = await afxReadBudget();
            const remain = toBudgetNumber(remainRaw);
            if (remain !== null) {
              budgetRemaining = remain;
              if (remain <= SAFE_BUDGET_THRESHOLD) {
                budgetStop = true;
                budgetStopReason = remain <= 0 ? "exhausted" : "threshold";
                break;
              }
            }
          } catch {
            // ignore errors when probing budget
          }
        }

        if (!fixture_id) continue; // bez stabilnog ID-a nema ključa

        const baseMeta = {
          ts: Date.now(),
          market: p?.market,
          pick_code: p?.pick_code,
          teams: { homeId, awayId },
          leagueId,
          season,
        };

        // STUB meta ako fale identifikatori
        if (!homeId || !awayId || !leagueId || !season) {
          const meta = {
            ...baseMeta,
            reason: "missing_ids",
            stats: { haveHome: false, haveAway: false, home: null, away: null },
            injuries: { homeCount: 0, awayCount: 0 },
            h2h: { have: false, count: 0, over2_5_pct: 0, btts_pct: 0, draw_pct: 0 },
            confidence_adj_pp: 0,
          };
          const ok = await kvSet(`vb:meta:${ymd}:${slot}:${fixture_id}`, meta);
          if (ok) { enriched++; stubbed++; metaKeys.push(`vb:meta:${ymd}:${slot}:${fixture_id}`); }
          continue;
        }

        if (skipOutbound) {
          budgetStop = true;
          if (!budgetStopReason) budgetStopReason = "skip_outbound";
          break;
        }

        // Puni enrichment
        const remoteResults = await Promise.all([
          afxTeamStats(leagueId, homeId, season).catch(() => null),
          afxTeamStats(leagueId, awayId, season).catch(() => null),
          afxInjuries(homeId).catch(() => null),
          afxInjuries(awayId).catch(() => null),
          afxH2H(homeId, awayId, 10).catch(() => null),
        ]).catch(() => null);

        if (!remoteResults) {
          skipOutbound = true;
          budgetStop = true;
          if (!budgetStopReason) budgetStopReason = "remote-error";
          break;
        }

        if (remoteResults.every((value) => value === null || value === undefined)) {
          skipOutbound = true;
          budgetStop = true;
          if (!budgetStopReason) budgetStopReason = "upstream-null";
          break;
        }

        const [statsH, statsA, injH, injA, h2h] = remoteResults;

        // H2H procente računamo lokalno (bezbedno)
        let h2hCount = 0, over25 = 0, btts = 0, draws = 0;
        const H = Array.isArray(h2h?.response) ? h2h.response : [];
        for (const m of H) {
          const st = m?.fixture?.status?.short;
          const gh = Number(m?.goals?.home);
          const ga = Number(m?.goals?.away);
          if (!isFinalStatus(st) || !Number.isFinite(gh) || !Number.isFinite(ga)) continue;
          h2hCount++;
          if (gh + ga >= 3) over25++;
          if (gh > 0 && ga > 0) btts++;
          if (gh === ga) draws++;
        }
        const pct = (num, den) => (den > 0 ? Math.round((100 * num) / den) : 0);

        const meta = {
          ...baseMeta,
          stats: {
            haveHome: !!statsH,
            haveAway: !!statsA,
            home: extractTeamStats(statsH),
            away: extractTeamStats(statsA),
          },
          injuries: {
            homeCount: Array.isArray(injH?.response) ? injH.response.length : 0,
            awayCount: Array.isArray(injA?.response) ? injA.response.length : 0,
          },
          h2h: {
            have: h2hCount > 0,
            count: h2hCount,
            over2_5_pct: pct(over25, h2hCount),
            btts_pct: pct(btts, h2hCount),
            draw_pct: pct(draws, h2hCount),
          },
          confidence_adj_pp: 0,
        };

        const ok = await kvSet(`vb:meta:${ymd}:${slot}:${fixture_id}`, meta);
        if (ok) { enriched++; enriched_full++; metaKeys.push(`vb:meta:${ymd}:${slot}:${fixture_id}`); }
      } catch {
        // tiho preskoči pojedinačni fail
      }
    }

    if (enriched && metaKeys.length) {
      await kvSet(metaListKey, { ymd, slot, keys: metaKeys, n: metaKeys.length, ts: Date.now() });
    }

    return res.status(200).json({
      ok: true,
      slot,
      ymd,
      enriched,
      enriched_full,
      stubbed,
      budget_exhausted: budgetStop,
      budget_remaining: budgetRemaining,
      budget_stop_reason: budgetStop ? budgetStopReason : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
