// pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ helpers ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));

/* ---------- KV (Vercel KV or Upstash REST) ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGET(key, trace=[]) {
  for (const b of kvBackends()) {
    try {
      const u = `${b.url}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${b.tok}` }, cache:"no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const v = j?.result ?? j?.value ?? null;
      if (v==null) continue;
      const out = typeof v==="string" ? JSON.parse(v) : v;
      trace.push({kv:"hit", key, flavor:b.flavor, size: (Array.isArray(out?.items)?out.items.length: (Array.isArray(out)?out.length:0))});
      return out;
    } catch {}
  }
  trace.push({kv:"miss", key});
  return null;
}
async function kvSET(key, val, trace=[]) {
  const saves = [];
  for (const b of kvBackends()) {
    try {
      const body = typeof val==="string" ? val : JSON.stringify(val);
      const u = `${b.url}/set/${encodeURIComponent(key)}`;
      const r = await fetch(u, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${b.tok}` }, body: JSON.stringify({ value: body }) });
      saves.push({ key, flavor:b.flavor, ok:r.ok });
    } catch (e) {
      saves.push({ key, flavor:b.flavor, ok:false, error:String(e?.message||e) });
    }
  }
  trace.push({kv:"set", key, saves});
  return saves;
}

/* ---------- API-Football thin wrapper (uses official header) ---------- */
const {
  afxFixturesByDate,
  afxTeamStats,
  afxTeamFixtures,
  afxH2H,
  afxStandings,
  afxCacheGet,
  afxCacheSet,
} = require("../../../lib/sources/apiFootball");

/* ---------- utils ---------- */
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function isYouthLeague(name=""){ name=String(name||"").toLowerCase(); return /(u-?\d{2}|youth|reserve|women|futsal)/.test(name); }
function kickoffISOFromAF(fix){ return fix?.fixture?.date || null; }
function leagueFromAF(fix){ return { id: fix?.league?.id, name: fix?.league?.name, country: fix?.league?.country, season: fix?.league?.season }; }
function teamsFromAF(fix){ return { home: fix?.teams?.home?.name, away: fix?.teams?.away?.name, home_id: fix?.teams?.home?.id, away_id: fix?.teams?.away?.id }; }

function slotFilter(dateISO, slot){
  if(!dateISO) return false;
  const d = new Date(dateISO);
  const h = hourInTZ(d, TZ);
  if (slot==="late") return h < 10;
  if (slot==="am")   return h >= 10 && h < 15;
  if (slot==="pm")   return h >= 15;
  return true;
}
function perLeagueCap(slot, isWeekend){
  const CAP_LATE = Number(process.env.CAP_LATE)||6;
  const CAP_AM_WD = Number(process.env.CAP_AM_WD)||15;
  const CAP_PM_WD = Number(process.env.CAP_PM_WD)||15;
  const CAP_AM_WE = Number(process.env.CAP_AM_WE)||20;
  const CAP_PM_WE = Number(process.env.CAP_PM_WE)||20;
  if (slot==="late") return CAP_LATE;
  if (!isWeekend) return slot==="am" ? CAP_AM_WD : CAP_PM_WD;
  return slot==="am" ? CAP_AM_WE : CAP_PM_WE;
}
function isWeekendYmd(ymd, tz){
  const [y,m,d]=ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d, 12, 0, 0));
  const w = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, weekday:"short"}).format(dt).toLowerCase();
  return w==="sat"||w==="sun";
}

/* ---------- modelling helpers ---------- */
const MODEL_BATCH_MIN = 25;
const MODEL_BATCH_MAX = 50;
const MODEL_BATCH_DEFAULT = Number(process.env.REBUILD_BATCH_SIZE || 36);
const MODEL_MAX_RUNTIME_MS = Number(process.env.REBUILD_MAX_MS || 23000);
const MODEL_CACHE_PREFIX = "vb:model";
const CACHE_TTL_STATS = 6 * 3600;
const CACHE_TTL_RECENT = 3600;
const CACHE_TTL_H2H = 12 * 3600;
const CACHE_TTL_STANDINGS = 12 * 3600;
const DAY_MS = 24 * 3600 * 1000;
const HALF_GOAL_RATIO = 0.46;
const POISSON_MAX_GOALS = 8;
const DEFAULT_BASE_GOALS = 1.35;
const DEFAULT_PPG = 1.35;
const DEFAULT_SHOTS_ON_TARGET = 4.2;
const DEFAULT_LEAGUE_STRENGTH = 0.5;
const STOP_TOKEN = Symbol("rebuild-stop");

function clamp(value, min, max) {
  let out = value;
  if (!Number.isFinite(out)) return Number.isFinite(min) ? min : Number.isFinite(max) ? max : out;
  if (Number.isFinite(min) && out < min) out = min;
  if (Number.isFinite(max) && out > max) out = max;
  return out;
}

function clampProbability(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return clamp(min, min, max);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function safeMean(values = []) {
  const arr = values.filter((v) => Number.isFinite(v));
  if (!arr.length) return null;
  const sum = arr.reduce((acc, v) => acc + v, 0);
  return sum / arr.length;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, ".").trim();
    if (!normalized) return null;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parseId(value) {
  const num = toNumber(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function normalizeForm(form) {
  if (!form) return "";
  return String(form)
    .toUpperCase()
    .replace(/[^WDL]/g, "")
    .slice(-6);
}

function computeFormScore(formStr) {
  if (!formStr) return null;
  const weights = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < formStr.length && i < weights.length; i += 1) {
    const ch = formStr[i];
    const weight = weights[i];
    let value = 0;
    if (ch === "W") value = 1;
    else if (ch === "L") value = -1;
    sum += value * weight;
    weightSum += weight;
  }
  if (!weightSum) return null;
  return sum / weightSum;
}

function readSideValue(node, side) {
  if (node === null || node === undefined) return null;
  if (typeof node === "number" || typeof node === "string") {
    return toNumber(node);
  }
  if (typeof node !== "object") return null;
  const candidates = [node[side], node.total, node.value, node.count, node.number, node.all];
  for (const cand of candidates) {
    const num = toNumber(cand);
    if (num !== null) return num;
  }
  if (Array.isArray(node)) {
    for (const part of node) {
      const num = toNumber(part);
      if (num !== null) return num;
    }
  }
  return null;
}

function parseRatioValue(value, played) {
  const num = toNumber(value);
  if (num === null) return null;
  if (num >= 0 && num <= 1) return clampProbability(num);
  if (num >= 0 && num <= 100) return clampProbability(num / 100);
  if (Number.isFinite(played) && played > 0) {
    if (num >= 0 && num <= played) return clampProbability(num / played);
    if (num > played) return clampProbability(num / played);
  }
  return null;
}

function readRatioNode(node, side, played) {
  if (node === null || node === undefined) return null;
  if (typeof node === "number" || typeof node === "string") {
    return parseRatioValue(node, played);
  }
  if (typeof node !== "object") return null;
  const candidates = [
    node[side],
    node.total,
    node.value,
    node.percentage,
    node.percent,
    node.pct,
    node.ratio,
    node.yes,
    node.true,
  ];
  for (const cand of candidates) {
    const ratio = parseRatioValue(cand, played);
    if (ratio !== null) return ratio;
  }
  if (Array.isArray(node)) {
    for (const part of node) {
      const ratio = readRatioNode(part, side, played);
      if (ratio !== null) return ratio;
    }
  }
  return null;
}

function unwrapTeamStats(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw.response)) return raw.response[0] || null;
  if (raw.response && typeof raw.response === "object") return raw.response;
  if (Array.isArray(raw)) return raw[0] || null;
  return raw;
}

function computeTeamSummary(stats, side) {
  const summary = {
    played_total: null,
    played_side: null,
    ppg: null,
    goals_for_avg: null,
    goals_against_avg: null,
    goals_for_total: null,
    goals_against_total: null,
    shots_on_target_avg: null,
    shots_accuracy: null,
    btts_ratio: null,
    ou25_ratio: null,
    form: "",
    form_score: null,
  };
  if (!stats || typeof stats !== "object") return summary;

  const fixtures = stats.fixtures || {};
  const wins = fixtures.wins || {};
  const draws = fixtures.draws || {};
  const played = fixtures.played || {};

  const playedTotal = toNumber(played.total);
  const playedSide = toNumber(played[side]);
  summary.played_total = playedTotal ?? null;
  summary.played_side = playedSide ?? null;

  const winTotal = toNumber(wins.total) ?? 0;
  const drawTotal = toNumber(draws.total) ?? 0;
  if (Number.isFinite(playedTotal) && playedTotal > 0) {
    summary.ppg = (winTotal * 3 + drawTotal) / playedTotal;
  }

  summary.goals_for_avg =
    toNumber(stats?.goals?.for?.average?.[side]) ?? toNumber(stats?.goals?.for?.average?.total);
  summary.goals_against_avg =
    toNumber(stats?.goals?.against?.average?.[side]) ?? toNumber(stats?.goals?.against?.average?.total);
  summary.goals_for_total =
    toNumber(stats?.goals?.for?.total?.[side]) ?? toNumber(stats?.goals?.for?.total?.total);
  summary.goals_against_total =
    toNumber(stats?.goals?.against?.total?.[side]) ?? toNumber(stats?.goals?.against?.total?.total);

  const shotsTotal = readSideValue(stats?.shots?.total, side);
  const shotsOn = readSideValue(stats?.shots?.on, side);
  let shotsOnAvg = null;
  if (Number.isFinite(shotsOn)) {
    if (Number.isFinite(playedSide) && playedSide > 0 && shotsOn > playedSide * 1.5) {
      shotsOnAvg = shotsOn / playedSide;
    } else {
      shotsOnAvg = shotsOn;
    }
  }
  if (shotsOnAvg === null && Number.isFinite(shotsTotal)) {
    if (Number.isFinite(playedSide) && playedSide > 0) {
      shotsOnAvg = (shotsTotal / playedSide) * 0.35;
    } else {
      shotsOnAvg = shotsTotal * 0.35;
    }
  }
  summary.shots_on_target_avg = Number.isFinite(shotsOnAvg)
    ? clamp(shotsOnAvg, 0, 15)
    : null;
  if (Number.isFinite(shotsOn) && Number.isFinite(shotsTotal) && shotsTotal > 0) {
    summary.shots_accuracy = clampProbability(shotsOn / shotsTotal);
  }

  const basePlayed = Number.isFinite(playedSide) && playedSide > 0 ? playedSide : playedTotal;
  summary.btts_ratio = readRatioNode(stats?.fixtures?.btts, side, basePlayed);
  const overNode =
    stats?.fixtures?.goals?.over_2_5 ??
    stats?.fixtures?.goals?.over25 ??
    stats?.goals?.over_2_5 ??
    stats?.goals?.over25;
  summary.ou25_ratio = readRatioNode(overNode, side, basePlayed);

  summary.form = normalizeForm(stats?.form);
  summary.form_score = computeFormScore(summary.form);
  return summary;
}

function isFinalStatus(status) {
  const code = String(status || "").toUpperCase();
  return code === "FT" || code === "AET" || code === "PEN" || code === "AWD" || code === "WO";
}

function computeRestDays(recent, kickoffDate) {
  if (!kickoffDate || Number.isNaN(kickoffDate.getTime())) return null;
  const list = Array.isArray(recent?.response)
    ? recent.response
    : Array.isArray(recent)
    ? recent
    : [];
  let lastMatch = null;
  for (const item of list) {
    const dateISO = item?.fixture?.date || item?.date || item?.fixtureDate;
    if (!dateISO) continue;
    const dt = new Date(dateISO);
    if (Number.isNaN(dt.getTime())) continue;
    if (dt >= kickoffDate) continue;
    const status = item?.fixture?.status?.short || item?.status?.short || item?.status;
    if (!isFinalStatus(status)) continue;
    if (!lastMatch || dt > lastMatch) lastMatch = dt;
  }
  if (!lastMatch) return null;
  const diffMs = kickoffDate.getTime() - lastMatch.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return null;
  return diffMs / DAY_MS;
}

function flattenStandings(raw) {
  if (!raw || typeof raw !== "object") return [];
  const response = Array.isArray(raw.response)
    ? raw.response
    : raw.response
    ? [raw.response]
    : Array.isArray(raw)
    ? raw
    : [raw];
  const out = [];
  for (const entry of response) {
    const leagueNode = entry?.league || entry;
    const standings = leagueNode?.standings || entry?.standings;
    if (!standings) continue;
    if (Array.isArray(standings)) {
      for (const group of standings) {
        if (Array.isArray(group)) {
          for (const row of group) {
            if (row && typeof row === "object") out.push(row);
          }
        } else if (group && typeof group === "object") {
          out.push(group);
        }
      }
    }
  }
  return out;
}

function computeLeagueSnapshot(standingsRaw, teamId) {
  const flat = flattenStandings(standingsRaw);
  const totalTeams = flat.length || null;
  if (!teamId) return { totalTeams, rank: null, strength: null, ppg: null, entry: null };
  const entry = flat.find((row) => parseId(row?.team?.id) === teamId) || null;
  if (!entry) return { totalTeams, rank: null, strength: null, ppg: null, entry: null };
  const rank = toNumber(entry.rank);
  const points = toNumber(entry.points);
  const played = toNumber(entry?.all?.played);
  const strength =
    totalTeams && Number.isFinite(rank)
      ? clampProbability((totalTeams - rank + 1) / totalTeams)
      : null;
  const ppg = Number.isFinite(points) && Number.isFinite(played) && played > 0 ? points / played : null;
  return { totalTeams, rank: Number.isFinite(rank) ? rank : null, strength, ppg, entry };
}

function summarizeH2H(raw, homeId, awayId) {
  const list = Array.isArray(raw?.response)
    ? raw.response
    : Array.isArray(raw)
    ? raw
    : [];
  let homeWins = 0;
  let awayWins = 0;
  let draws = 0;
  const recent = [];
  for (const match of list) {
    const fixture = match?.fixture || match;
    const status = fixture?.status?.short || match?.status?.short || match?.status;
    if (!isFinalStatus(status)) continue;
    let goalsHome = toNumber(match?.goals?.home ?? match?.score?.fulltime?.home);
    let goalsAway = toNumber(match?.goals?.away ?? match?.score?.fulltime?.away);
    if (!Number.isFinite(goalsHome) || !Number.isFinite(goalsAway)) continue;
    const matchHomeId = parseId(match?.teams?.home?.id);
    const matchAwayId = parseId(match?.teams?.away?.id);
    if (matchHomeId === awayId && matchAwayId === homeId) {
      const tmp = goalsHome;
      goalsHome = goalsAway;
      goalsAway = tmp;
    } else if (matchHomeId !== homeId || matchAwayId !== awayId) {
      continue;
    }
    if (goalsHome > goalsAway) {
      homeWins += 1;
      recent.push("W");
    } else if (goalsHome < goalsAway) {
      awayWins += 1;
      recent.push("L");
    } else {
      draws += 1;
      recent.push("D");
    }
  }
  const total = homeWins + awayWins + draws;
  const edge = total ? (homeWins - awayWins) / total : 0;
  return {
    home_wins: homeWins,
    away_wins: awayWins,
    draws,
    total,
    edge,
    recent: recent.slice(0, 8),
  };
}

function poissonDistribution(lambda, maxGoals = POISSON_MAX_GOALS) {
  const dist = new Array(maxGoals + 1).fill(0);
  if (!Number.isFinite(lambda) || lambda <= 0) {
    dist[0] = 1;
    return dist;
  }
  dist[0] = Math.exp(-lambda);
  let sum = dist[0];
  for (let k = 1; k <= maxGoals; k += 1) {
    dist[k] = (dist[k - 1] * lambda) / k;
    sum += dist[k];
  }
  const remainder = 1 - sum;
  if (Math.abs(remainder) > 1e-6) {
    dist[maxGoals] += remainder;
  }
  for (let i = 0; i < dist.length; i += 1) {
    if (dist[i] < 0) dist[i] = 0;
  }
  return dist;
}

function computeOutcomeFromExpectedGoals(lambdaHome, lambdaAway) {
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return null;
  const homeDist = poissonDistribution(lambdaHome);
  const awayDist = poissonDistribution(lambdaAway);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let btts = 0;
  for (let i = 0; i <= POISSON_MAX_GOALS; i += 1) {
    for (let j = 0; j <= POISSON_MAX_GOALS; j += 1) {
      const p = homeDist[i] * awayDist[j];
      if (!Number.isFinite(p) || p <= 0) continue;
      if (i > j) homeWin += p;
      else if (i < j) awayWin += p;
      else draw += p;
      if (i + j >= 3) over25 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  const total = homeWin + draw + awayWin;
  if (!(total > 0)) return null;
  const scale = 1 / total;
  return {
    home: homeWin * scale,
    draw: draw * scale,
    away: awayWin * scale,
    over25: clampProbability(over25),
    btts: clampProbability(btts),
  };
}

function computeHtFtMatrix(lambdaHome, lambdaAway) {
  const combos = {
    HH: 0,
    HD: 0,
    HA: 0,
    DH: 0,
    DD: 0,
    DA: 0,
    AH: 0,
    AD: 0,
    AA: 0,
  };
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) {
    return { matrix: combos, fhOver15: null };
  }
  const lambdaHomeHalf = clamp(lambdaHome * HALF_GOAL_RATIO, 0.05, 4.5);
  const lambdaAwayHalf = clamp(lambdaAway * HALF_GOAL_RATIO, 0.05, 4.5);
  const lambdaHomeSecond = Math.max(lambdaHome - lambdaHomeHalf, 0.05);
  const lambdaAwaySecond = Math.max(lambdaAway - lambdaAwayHalf, 0.05);
  const halfHome = poissonDistribution(lambdaHomeHalf);
  const halfAway = poissonDistribution(lambdaAwayHalf);
  const secondHome = poissonDistribution(lambdaHomeSecond);
  const secondAway = poissonDistribution(lambdaAwaySecond);
  let fhOver = 0;
  for (let i = 0; i <= POISSON_MAX_GOALS; i += 1) {
    for (let j = 0; j <= POISSON_MAX_GOALS; j += 1) {
      const pHalf = halfHome[i] * halfAway[j];
      if (!Number.isFinite(pHalf) || pHalf <= 0) continue;
      if (i + j >= 2) fhOver += pHalf;
      const ht = i > j ? "H" : i < j ? "A" : "D";
      for (let m = 0; m <= POISSON_MAX_GOALS; m += 1) {
        for (let n = 0; n <= POISSON_MAX_GOALS; n += 1) {
          const pSecond = secondHome[m] * secondAway[n];
          if (!Number.isFinite(pSecond) || pSecond <= 0) continue;
          const p = pHalf * pSecond;
          const finalHome = i + m;
          const finalAway = j + n;
          const ft = finalHome > finalAway ? "H" : finalHome < finalAway ? "A" : "D";
          const key = `${ht}${ft}`;
          combos[key] += p;
        }
      }
    }
  }
  let total = 0;
  for (const val of Object.values(combos)) total += val;
  if (total > 0) {
    for (const key of Object.keys(combos)) {
      combos[key] = clampProbability(combos[key] / total);
    }
  }
  return { matrix: combos, fhOver15: clampProbability(fhOver) };
}

function computeModelFromFeatures(home, away, extras = {}) {
  const baseHome =
    safeMean([home.goals_for_avg, away.goals_against_avg, DEFAULT_BASE_GOALS]) ?? DEFAULT_BASE_GOALS;
  const baseAway =
    safeMean([away.goals_for_avg, home.goals_against_avg, DEFAULT_BASE_GOALS]) ?? DEFAULT_BASE_GOALS;

  let lambdaHome = clamp(baseHome, 0.15, 4.8);
  let lambdaAway = clamp(baseAway, 0.15, 4.8);

  const homePPG = Number.isFinite(home.ppg) ? home.ppg : DEFAULT_PPG;
  const awayPPG = Number.isFinite(away.ppg) ? away.ppg : DEFAULT_PPG;
  const ppgDiff = homePPG - awayPPG;
  lambdaHome += 0.18 * ppgDiff;
  lambdaAway -= 0.18 * ppgDiff;

  const formHome = Number.isFinite(home.form_score) ? home.form_score : 0;
  const formAway = Number.isFinite(away.form_score) ? away.form_score : 0;
  const formDiff = formHome - formAway;
  lambdaHome += 0.12 * formDiff;
  lambdaAway -= 0.12 * formDiff;

  const restHome = Number.isFinite(home.rest_days) ? home.rest_days : null;
  const restAway = Number.isFinite(away.rest_days) ? away.rest_days : null;
  if (restHome !== null || restAway !== null) {
    const restDiff = (restHome ?? restAway ?? 0) - (restAway ?? restHome ?? 0);
    lambdaHome += 0.05 * restDiff;
    lambdaAway -= 0.05 * restDiff;
  }

  const leagueHome = Number.isFinite(home.league_strength)
    ? home.league_strength
    : DEFAULT_LEAGUE_STRENGTH;
  const leagueAway = Number.isFinite(away.league_strength)
    ? away.league_strength
    : DEFAULT_LEAGUE_STRENGTH;
  const leagueDiff = leagueHome - leagueAway;
  lambdaHome += 0.35 * leagueDiff;
  lambdaAway -= 0.35 * leagueDiff;

  const shotsHome = Number.isFinite(home.shots_on_target_avg)
    ? home.shots_on_target_avg
    : DEFAULT_SHOTS_ON_TARGET;
  const shotsAway = Number.isFinite(away.shots_on_target_avg)
    ? away.shots_on_target_avg
    : DEFAULT_SHOTS_ON_TARGET;
  const shotDiff = shotsHome - shotsAway;
  lambdaHome += 0.04 * shotDiff;
  lambdaAway -= 0.04 * shotDiff;

  const h2hEdge = Number.isFinite(extras.h2h_edge) ? extras.h2h_edge : 0;
  lambdaHome += 0.08 * h2hEdge;
  lambdaAway -= 0.08 * h2hEdge;

  lambdaHome = clamp(lambdaHome, 0.15, 4.8);
  lambdaAway = clamp(lambdaAway, 0.15, 4.8);

  const outcome = computeOutcomeFromExpectedGoals(lambdaHome, lambdaAway);
  if (!outcome) return null;

  let btts = outcome.btts;
  const bttsFreq = safeMean([home.btts_ratio, away.btts_ratio]);
  if (Number.isFinite(bttsFreq)) {
    btts = clampProbability(0.45 * outcome.btts + 0.55 * bttsFreq);
  }

  let over25 = outcome.over25;
  const overFreq = safeMean([home.ou25_ratio, away.ou25_ratio]);
  if (Number.isFinite(overFreq)) {
    over25 = clampProbability(0.45 * outcome.over25 + 0.55 * overFreq);
  }

  const htft = computeHtFtMatrix(lambdaHome, lambdaAway);
  const fhOver15 = Number.isFinite(htft.fhOver15)
    ? htft.fhOver15
    : clampProbability(over25 * 0.65);

  const oneXtwo = {
    home: clampProbability(outcome.home),
    draw: clampProbability(outcome.draw),
    away: clampProbability(outcome.away),
  };
  const sum = oneXtwo.home + oneXtwo.draw + oneXtwo.away;
  if (sum > 0) {
    const inv = 1 / sum;
    oneXtwo.home = clampProbability(oneXtwo.home * inv);
    oneXtwo.draw = clampProbability(oneXtwo.draw * inv);
    oneXtwo.away = clampProbability(oneXtwo.away * inv);
  }

  return {
    probs: oneXtwo,
    btts,
    over25,
    fhOver15,
    htFtMatrix: htft.matrix,
    lambdaHome,
    lambdaAway,
  };
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value).toFixed(digits);
}

function buildModelWhy(home, away, h2h) {
  const out = [];
  const ppgHome = formatNumber(home.ppg, 2);
  const ppgAway = formatNumber(away.ppg, 2);
  if (ppgHome && ppgAway) out.push(`PPG ${ppgHome}-${ppgAway}`);
  const gfHome = formatNumber(home.goals_for_avg, 2);
  const gfAway = formatNumber(away.goals_for_avg, 2);
  if (gfHome && gfAway) out.push(`GF ${gfHome}-${gfAway}`);
  const gaHome = formatNumber(home.goals_against_avg, 2);
  const gaAway = formatNumber(away.goals_against_avg, 2);
  if (gaHome && gaAway) out.push(`GA ${gaHome}-${gaAway}`);
  const sotHome = formatNumber(home.shots_on_target_avg, 1);
  const sotAway = formatNumber(away.shots_on_target_avg, 1);
  if (sotHome && sotAway) out.push(`SOT ${sotHome}-${sotAway}`);
  const restHome = formatNumber(home.rest_days, 1);
  const restAway = formatNumber(away.rest_days, 1);
  if (restHome && restAway) out.push(`Rest ${restHome}d v ${restAway}d`);
  if (Number.isFinite(home.league_rank) && Number.isFinite(away.league_rank)) {
    out.push(`Rank ${home.league_rank}-${away.league_rank}`);
  }
  if (Number.isFinite(home.league_strength) && Number.isFinite(away.league_strength)) {
    const sHome = formatNumber(home.league_strength * 100, 0);
    const sAway = formatNumber(away.league_strength * 100, 0);
    if (sHome && sAway) out.push(`Strength ${sHome}-${sAway}`);
  }
  if (h2h && h2h.total) {
    out.push(`H2H ${h2h.home_wins}-${h2h.draws}-${h2h.away_wins}`);
  }
  const bttsHome = Number.isFinite(home.btts_ratio) ? Math.round(home.btts_ratio * 100) : null;
  const bttsAway = Number.isFinite(away.btts_ratio) ? Math.round(away.btts_ratio * 100) : null;
  if (bttsHome !== null && bttsAway !== null) out.push(`BTTS% ${bttsHome}-${bttsAway}`);
  const ouHome = Number.isFinite(home.ou25_ratio) ? Math.round(home.ou25_ratio * 100) : null;
  const ouAway = Number.isFinite(away.ou25_ratio) ? Math.round(away.ou25_ratio * 100) : null;
  if (ouHome !== null && ouAway !== null) out.push(`O2.5% ${ouHome}-${ouAway}`);
  return out.slice(0, 6);
}

function computeBatchSize(total) {
  const base = Number.isFinite(MODEL_BATCH_DEFAULT) && MODEL_BATCH_DEFAULT > 0 ? MODEL_BATCH_DEFAULT : 36;
  const clamped = Math.min(Math.max(base, MODEL_BATCH_MIN), MODEL_BATCH_MAX);
  if (!Number.isFinite(total) || total <= 0) return clamped;
  if (total < MODEL_BATCH_MIN) return Math.max(1, total);
  return Math.min(clamped, Math.max(MODEL_BATCH_MIN, Math.min(MODEL_BATCH_MAX, total)));
}

async function ensureFixtureCache(key, value, ttlSeconds, ctx) {
  if (!key || value === null || value === undefined) return;
  if (ctx.fixtureCacheWrites.has(key)) return;
  if (ttlSeconds > 0) {
    await afxCacheSet(key, value, ttlSeconds);
  } else {
    await afxCacheSet(key, value, 0);
  }
  ctx.fixtureCacheWrites.add(key);
}

async function loadTeamStatsForFixture(meta, side, ctx) {
  const teamId = side === "home" ? meta.homeId : meta.awayId;
  if (!teamId || !meta.leagueId || !meta.season) return { data: null };
  const fixtureKey = `${MODEL_CACHE_PREFIX}:fixture:${meta.fixtureId}:stats:${side}`;
  const mapKey = `${meta.leagueId}:${teamId}:${meta.season}`;
  if (ctx.caches.stats.has(mapKey)) {
    const data = ctx.caches.stats.get(mapKey);
    await ensureFixtureCache(fixtureKey, data, CACHE_TTL_STATS, ctx);
    return { data };
  }
  const cached = await afxCacheGet(fixtureKey);
  if (cached !== null && cached !== undefined) {
    ctx.caches.stats.set(mapKey, cached);
    return { data: cached };
  }
  const fresh = await afxTeamStats(meta.leagueId, teamId, meta.season, { priority: "P2" });
  if (fresh === null || fresh === undefined) return { stop: true };
  ctx.caches.stats.set(mapKey, fresh);
  await ensureFixtureCache(fixtureKey, fresh, CACHE_TTL_STATS, ctx);
  return { data: fresh };
}

async function loadRecentForFixture(meta, side, ctx) {
  const teamId = side === "home" ? meta.homeId : meta.awayId;
  if (!teamId) return { data: null };
  const fixtureKey = `${MODEL_CACHE_PREFIX}:fixture:${meta.fixtureId}:recent:${side}`;
  const mapKey = `recent:${teamId}`;
  if (ctx.caches.recent.has(mapKey)) {
    const data = ctx.caches.recent.get(mapKey);
    await ensureFixtureCache(fixtureKey, data, CACHE_TTL_RECENT, ctx);
    return { data };
  }
  const cached = await afxCacheGet(fixtureKey);
  if (cached !== null && cached !== undefined) {
    ctx.caches.recent.set(mapKey, cached);
    return { data: cached };
  }
  const fresh = await afxTeamFixtures(teamId, { last: 6, priority: "P3" });
  if (fresh === null || fresh === undefined) return { stop: true };
  ctx.caches.recent.set(mapKey, fresh);
  await ensureFixtureCache(fixtureKey, fresh, CACHE_TTL_RECENT, ctx);
  return { data: fresh };
}

async function loadStandingsForFixture(meta, ctx) {
  if (!meta.leagueId || !meta.season) return { data: null };
  const fixtureKey = `${MODEL_CACHE_PREFIX}:fixture:${meta.fixtureId}:standings`;
  const mapKey = `${meta.leagueId}:${meta.season}`;
  if (ctx.caches.standings.has(mapKey)) {
    const data = ctx.caches.standings.get(mapKey);
    await ensureFixtureCache(fixtureKey, data, CACHE_TTL_STANDINGS, ctx);
    return { data };
  }
  const cached = await afxCacheGet(fixtureKey);
  if (cached !== null && cached !== undefined) {
    ctx.caches.standings.set(mapKey, cached);
    return { data: cached };
  }
  const fresh = await afxStandings(meta.leagueId, meta.season, { priority: "P3" });
  if (fresh === null || fresh === undefined) return { stop: true };
  ctx.caches.standings.set(mapKey, fresh);
  await ensureFixtureCache(fixtureKey, fresh, CACHE_TTL_STANDINGS, ctx);
  return { data: fresh };
}

async function loadH2HForFixture(meta, ctx) {
  if (!meta.homeId || !meta.awayId) return { data: null };
  const pairKey = `${meta.homeId}:${meta.awayId}`;
  const fixtureKey = `${MODEL_CACHE_PREFIX}:fixture:${meta.fixtureId}:h2h`;
  if (ctx.caches.h2h.has(pairKey)) {
    const data = ctx.caches.h2h.get(pairKey);
    await ensureFixtureCache(fixtureKey, data, CACHE_TTL_H2H, ctx);
    return { data };
  }
  const cached = await afxCacheGet(fixtureKey);
  if (cached !== null && cached !== undefined) {
    ctx.caches.h2h.set(pairKey, cached);
    return { data: cached };
  }
  const fresh = await afxH2H(meta.homeId, meta.awayId, 8, { priority: "P3" });
  if (fresh === null || fresh === undefined) return { stop: true };
  ctx.caches.h2h.set(pairKey, fresh);
  await ensureFixtureCache(fixtureKey, fresh, CACHE_TTL_H2H, ctx);
  return { data: fresh };
}

function extractFixtureMeta(fixture = {}) {
  const fixtureId =
    parseId(fixture?.fixture_id) ??
    parseId(fixture?.fixture?.id) ??
    parseId(fixture?.id);
  const leagueId =
    parseId(fixture?.league?.id) ??
    parseId(fixture?.league_id) ??
    parseId(fixture?.competition_id);
  const season =
    parseId(fixture?.league?.season) ??
    parseId(fixture?.season) ??
    parseId(fixture?.season_id);
  const homeId =
    parseId(fixture?.teams?.home_id) ??
    parseId(fixture?.teams?.home?.id) ??
    parseId(fixture?.home_id);
  const awayId =
    parseId(fixture?.teams?.away_id) ??
    parseId(fixture?.teams?.away?.id) ??
    parseId(fixture?.away_id);
  const homeName =
    fixture?.home ??
    fixture?.teams?.home ??
    fixture?.teams?.home?.name ??
    fixture?.teams?.home?.team ??
    null;
  const awayName =
    fixture?.away ??
    fixture?.teams?.away ??
    fixture?.teams?.away?.name ??
    fixture?.teams?.away?.team ??
    null;
  const kickoffISO = fixture?.kickoff || fixture?.fixture?.date || fixture?.kickoff_utc || null;
  return { fixtureId, leagueId, season, homeId, awayId, homeName, awayName, kickoffISO };
}

async function processFixture(fixture, ctx) {
  const meta = extractFixtureMeta(fixture);
  const missing = [];
  if (!meta.fixtureId) missing.push("fixtureId");
  if (!meta.leagueId) missing.push("leagueId");
  if (!meta.season) missing.push("season");
  if (!meta.homeId) missing.push("homeId");
  if (!meta.awayId) missing.push("awayId");
  if (missing.length) {
    ctx.trace.push({
      model: {
        fixture: meta.fixtureId ?? null,
        status: "skip",
        reason: "missing-identifiers",
        missing,
      },
    });
    return { updated: false };
  }

  const kickoffDate = meta.kickoffISO ? new Date(meta.kickoffISO) : null;

  const homeStatsRes = await loadTeamStatsForFixture(meta, "home", ctx);
  if (homeStatsRes.stop) return { stopReason: "budget" };
  const awayStatsRes = await loadTeamStatsForFixture(meta, "away", ctx);
  if (awayStatsRes.stop) return { stopReason: "budget" };

  const homeSummary = computeTeamSummary(unwrapTeamStats(homeStatsRes.data), "home");
  const awaySummary = computeTeamSummary(unwrapTeamStats(awayStatsRes.data), "away");

  const recentHome = await loadRecentForFixture(meta, "home", ctx);
  if (recentHome.stop) return { stopReason: "budget" };
  const recentAway = await loadRecentForFixture(meta, "away", ctx);
  if (recentAway.stop) return { stopReason: "budget" };

  const standingsRes = await loadStandingsForFixture(meta, ctx);
  if (standingsRes.stop) return { stopReason: "budget" };

  const h2hRes = await loadH2HForFixture(meta, ctx);
  if (h2hRes.stop) return { stopReason: "budget" };

  const kickoffValid = kickoffDate && !Number.isNaN(kickoffDate.getTime()) ? kickoffDate : null;
  homeSummary.rest_days = computeRestDays(recentHome.data, kickoffValid);
  awaySummary.rest_days = computeRestDays(recentAway.data, kickoffValid);

  const leagueHome = computeLeagueSnapshot(standingsRes.data, meta.homeId);
  const leagueAway = computeLeagueSnapshot(standingsRes.data, meta.awayId);
  homeSummary.league_rank = leagueHome.rank ?? null;
  homeSummary.league_strength = leagueHome.strength ?? null;
  homeSummary.league_ppg = leagueHome.ppg ?? null;
  awaySummary.league_rank = leagueAway.rank ?? null;
  awaySummary.league_strength = leagueAway.strength ?? null;
  awaySummary.league_ppg = leagueAway.ppg ?? null;

  homeSummary.team_id = meta.homeId;
  homeSummary.team_name = meta.homeName;
  awaySummary.team_id = meta.awayId;
  awaySummary.team_name = meta.awayName;

  const h2hSummary = summarizeH2H(h2hRes.data, meta.homeId, meta.awayId);

  const model = computeModelFromFeatures(homeSummary, awaySummary, { h2h_edge: h2hSummary.edge });
  if (!model) {
    ctx.trace.push({ model: { fixture: meta.fixtureId, status: "skip", reason: "model" } });
    return { updated: false };
  }

  const oneXtwo = { ...model.probs };
  const sum = oneXtwo.home + oneXtwo.draw + oneXtwo.away;
  if (sum > 0) {
    const inv = 1 / sum;
    oneXtwo.home = clampProbability(oneXtwo.home * inv);
    oneXtwo.draw = clampProbability(oneXtwo.draw * inv);
    oneXtwo.away = clampProbability(oneXtwo.away * inv);
  }

  let predicted = "home";
  let topProb = oneXtwo.home;
  if (oneXtwo.draw > topProb) {
    predicted = "draw";
    topProb = oneXtwo.draw;
  }
  if (oneXtwo.away > topProb) {
    predicted = "away";
    topProb = oneXtwo.away;
  }

  const btts = clampProbability(model.btts ?? 0);
  const over25 = clampProbability(model.over25 ?? 0);
  const fhOver = clampProbability(model.fhOver15 ?? clampProbability(over25 * 0.65));
  const fhUnder = clampProbability(1 - fhOver);
  const bttsNo = clampProbability(1 - btts);
  const under25 = clampProbability(1 - over25);

  const modelProbs = {
    home: oneXtwo.home,
    draw: oneXtwo.draw,
    away: oneXtwo.away,
    oneXtwo: { ...oneXtwo },
    btts_yes: btts,
    btts_no: bttsNo,
    btts: { yes: btts, no: bttsNo },
    over25,
    under25,
    ou25_over: over25,
    ou25_under: under25,
    ou25: { over: over25, under: under25 },
    fh_over15: fhOver,
    fh_under15: fhUnder,
    fh_ou15: { over: fhOver, under: fhUnder },
    ht_ft: model.htFtMatrix,
  };

  const modelWhy = buildModelWhy(homeSummary, awaySummary, h2hSummary);

  const modelFeatures = {
    home: homeSummary,
    away: awaySummary,
    h2h: h2hSummary,
    lambda: { home: model.lambdaHome, away: model.lambdaAway },
  };

  const updatedFixture = {
    ...fixture,
    model_prob: topProb,
    model_probs: modelProbs,
    model_pick: predicted,
    model_pred: predicted,
    model_why: modelWhy,
    model_features: modelFeatures,
    model_updated_at: new Date().toISOString(),
  };

  ctx.trace.push({
    model: {
      fixture: meta.fixtureId,
      status: "ok",
      predicted,
      model_prob: topProb,
    },
  });

  return { updated: true, fixture: updatedFixture };
}

async function enrichFixturesForDay({ items, ymd, slot, trace, persistKeys }) {
  const caches = {
    stats: new Map(),
    recent: new Map(),
    standings: new Map(),
    h2h: new Map(),
  };
  const fixtureCacheWrites = new Set();
  const ctx = { trace, caches, fixtureCacheWrites };
  const batchSize = computeBatchSize(items.length);
  const maxRuntime = Number.isFinite(MODEL_MAX_RUNTIME_MS) && MODEL_MAX_RUNTIME_MS > 0
    ? MODEL_MAX_RUNTIME_MS
    : 23000;
  const started = Date.now();
  const deadline = maxRuntime > 0 ? started + maxRuntime : null;
  let processed = 0;
  let updated = 0;
  let stopReason = null;
  let batchesSaved = 0;
  const targets = Array.isArray(persistKeys)
    ? Array.from(new Set(persistKeys.filter(Boolean)))
    : [];

  for (let start = 0; start < items.length && !stopReason; start += batchSize) {
    const end = Math.min(items.length, start + batchSize);
    let batchChanged = false;
    for (let idx = start; idx < end; idx += 1) {
      if (deadline && Date.now() > deadline) {
        stopReason = "time";
        break;
      }
      const result = await processFixture(items[idx], ctx);
      processed += 1;
      if (result?.stopReason) {
        stopReason = result.stopReason;
        break;
      }
      if (result?.updated && result.fixture) {
        items[idx] = result.fixture;
        updated += 1;
        batchChanged = true;
      }
    }
    if (batchChanged && targets.length) {
      const payload = { items };
      for (const key of targets) {
        await kvSET(key, payload, trace);
      }
      batchesSaved += 1;
    }
  }

  return { processed, updated, stopReason, batchesSaved };
}

/* ---------- main ---------- */
export default async function handler(req, res){
  const trace = [];
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    let slot = canonicalSlot(req.query.slot);
    if (slot==="auto") {
      const h = hourInTZ(now, TZ);
      slot = (h<10) ? "late" : (h<15) ? "am" : "pm";
    }
    const weekend = isWeekendYmd(ymd, TZ);
    const capPerLeague = perLeagueCap(slot, weekend);

    // 1) try existing KV
    const unionKey = `vb:day:${ymd}:${slot}`;
    const fullKey  = `vbl_full:${ymd}:${slot}`;
    let base = await kvGET(unionKey, trace);
    let full  = await kvGET(fullKey,  trace);
    const baseItems = Array.isArray(base?.items) ? base.items : (Array.isArray(base)?base:[]);
    const fullItems = Array.isArray(full?.items) ? full.items : (Array.isArray(full)?full:[]);

    let items = fullItems.length ? fullItems : baseItems;
    let budgetStop = false;

    const respond = ({ items: responseItems = items, source, processed = 0, updated = 0, stopReason } = {}) => {
      const resolvedSource =
        source ??
        (responseItems.length
          ? stopReason === "time"
            ? "time"
            : "af:seed-or-kv"
          : budgetStop
          ? "budget"
          : "empty");
      return res.status(200).json({
        ok:true,
        ymd, slot,
        counts: { full: responseItems.length, processed, updated },
        source: resolvedSource,
        budget_exhausted: budgetStop,
        timed_out: stopReason === "time",
        stop_reason: stopReason || null,
        trace
      });
    };

    // 2) If base empty, fetch fixtures for the day and seed KV
    if (!items.length){
      const af = await afxFixturesByDate(ymd, { priority: "P2" });
      const list = Array.isArray(af?.response) ? af.response : null;
      if (!list) {
        budgetStop = true;
        trace.push({ afx: "fixtures", ymd, budget: "exhausted" });
        const preserved = fullItems.length ? fullItems : baseItems;
        return respond({ items: preserved, source: "budget" });
      }
      const mapped = list
        .filter(f => !isYouthLeague(f?.league?.name))
        .filter(f => slotFilter(kickoffISOFromAF(f), slot))
        .map(f => {
          const dateISO = kickoffISOFromAF(f);
          return {
            fixture_id: f?.fixture?.id,
            fixture: { id: f?.fixture?.id, date: dateISO, timezone: f?.fixture?.timezone },
            kickoff: dateISO,
            kickoff_utc: dateISO,
            league: leagueFromAF(f),
            league_name: f?.league?.name,
            league_country: f?.league?.country,
            teams: teamsFromAF(f),
            home: f?.teams?.home?.name,
            away: f?.teams?.away?.name,
            markets: {} // to be filled by refresh-odds
          };
        });

      // per-league cap for slim list; full list keeps all (by slot)
      const perLeagueCounter = new Map();
      const slim = [];
      for (const it of mapped){
        const key = String(it?.league?.id || it?.league?.name || "?");
        const cur = perLeagueCounter.get(key)||0;
        if (cur < capPerLeague){ slim.push(it); perLeagueCounter.set(key, cur+1); }
      }

      await kvSET(fullKey,  { items: slim   }, trace);
      await kvSET(unionKey, { items: slim   }, trace);
      await kvSET(`vb:day:${ymd}:last`,  { items: slim }, trace);
      await kvSET(`vb:day:${ymd}:union`, { items: slim }, trace);

      items = slim;
    }

    const persistKeys = Array.from(
      new Set([
        fullKey,
        unionKey,
        `vb:day:${ymd}:last`,
        `vb:day:${ymd}:union`,
      ])
    ).filter(Boolean);

    if (items.length) {
      const enrich = await enrichFixturesForDay({ items, ymd, slot, trace, persistKeys });
      if (enrich.stopReason === "budget") budgetStop = true;
      const sourceOverride = enrich.stopReason === "budget" ? "budget" : undefined;
      return respond({
        items,
        source: sourceOverride,
        processed: enrich.processed,
        updated: enrich.updated,
        stopReason: enrich.stopReason,
      });
    }

    return respond();
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
