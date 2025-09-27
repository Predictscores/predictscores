// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const {
  DEFAULT_FLAGS: LEARNING_DEFAULT_FLAGS,
  normalizeFlags,
  resolveLeagueTier,
  resolveMarketBucket,
  resolveOddsBand,
  applyCalibration,
  applyLeagueAdjustment,
  applyEvGuard,
  resolveDefaultEvGuard,
} = require("../../lib/learning/runtime");

/* =========================
 *  Inline helpers (KV)
 * ========================= */
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
      const v = (j && ("result" in j ? j.result : j.value)) ?? null;
      if (v==null) continue;
      trace.push({ get:key, ok:true, flavor:b.flavor, hit:true });
      return v;
    } catch {}
  }
  trace.push({ get:key, ok:true, hit:false });
  return null;
}
function kvToItems(doc) {
  if (doc == null) return { items: [] };
  let v = doc;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { items: [] }; } }
  if (v && typeof v === "object" && typeof v.value === "string") {
    try { v = JSON.parse(v.value); } catch { return { items: [] }; }
  }
  if (Array.isArray(v)) return { items: v };
  if (v && Array.isArray(v.items)) return v;
  return { items: [] };
}

function kvToObject(doc) {
  if (doc == null) return null;
  let v = doc;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (v && typeof v === "object" && typeof v.value === "string") {
    try { v = JSON.parse(v.value); } catch { return null; }
  }
  return (v && typeof v === "object") ? v : null;
}

async function kvSET(key, value, trace = []) {
  const saves = [];
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    const record = { flavor: b.flavor, ok: false };
    try {
      const url = `${b.url}/set/${encodeURIComponent(key)}`;
      const body = JSON.stringify({ value: serialized });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${b.tok}`,
          "Content-Type": "application/json",
        },
        body,
      });
      record.status = res.status;
      if (res.ok) {
        record.ok = true;
      } else {
        const fallbackUrl = `${b.url}/set/${encodeURIComponent(key)}/${encodeURIComponent(serialized)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${b.tok}` },
        }).catch(() => null);
        if (fallbackRes && fallbackRes.ok) {
          record.ok = true;
          record.status = fallbackRes.status;
        } else {
          record.error = `http_${res.status}`;
        }
      }
    } catch (err) {
      record.error = String(err?.message || err);
    }
    saves.push(record);
  }
  if (trace) trace.push({ set: key, saves });
  return saves.some((s) => s.ok);
}

/* =========================
 *  ENV / time helpers
 * ========================= */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
function pickSlotAuto(now){ const h=hourInTZ(now, TZ); return h<10?"late":h<15?"am":"pm"; }

const VB_LIMIT = Number(process.env.VB_LIMIT || 25);
const VB_MAX_PER_LEAGUE = Number(process.env.VB_MAX_PER_LEAGUE || 2);
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.50);
const MAX_ODDS = Number(process.env.MAX_ODDS || 5.50);
const UEFA_DAILY_CAP = Number(process.env.UEFA_DAILY_CAP || 6);

const CAP_LATE = Number(process.env.CAP_LATE || 6);
const CAP_AM_WD = Number(process.env.CAP_AM_WD || 15);
const CAP_PM_WD = Number(process.env.CAP_PM_WD || 15);
const CAP_AM_WE = Number(process.env.CAP_AM_WE || 20);
const CAP_PM_WE = Number(process.env.CAP_PM_WE || 20);

function isWeekend(ymd){
  const [y,m,d]=ymd.split("-").map(Number);
  const dt=new Date(Date.UTC(y,m-1,d,12,0,0));
  const wd=new Intl.DateTimeFormat("en-GB",{ timeZone:TZ, weekday:"short"}).format(dt).toLowerCase();
  return wd==="sat"||wd==="sun";
}
function isUEFA(league){ const n=String(league?.name||"").toLowerCase(); return /uefa|champions|europa|conference|ucl|uel|uecl/.test(n); }

/* =========================
 *  Model helpers
 * ========================= */
function toProbability(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num > 1) {
    if (num <= 100) return Math.max(0, Math.min(1, num / 100));
    return null;
  }
  if (num < 0) return 0;
  return Math.max(0, Math.min(1, num));
}
function pluck(obj, path){
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}
function probabilityFromPaths(obj, paths){
  for (const path of paths) {
    const val = pluck(obj, path);
    const prob = toProbability(val);
    if (prob != null) return prob;
  }
  return null;
}
function probabilityValue(src, keys){
  if (!src || typeof src !== "object") return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      const prob = toProbability(src[key]);
      if (prob != null) return prob;
    }
  }
  return null;
}
const HTFT_CODES = ["HH","HD","HA","DH","DD","DA","AH","AD","AA"];
function normalizeHtftOutcomeCode(raw){
  if (raw == null) return null;
  let str;
  try {
    str = String(raw);
  } catch {
    return null;
  }
  if (!str) return null;
  str = str.toUpperCase();
  str = str.replace(/HOME/g, "H").replace(/DRAW/g, "D").replace(/AWAY/g, "A");
  let out = "";
  for (const ch of str) {
    if (ch === "H" || ch === "1") out += "H";
    else if (ch === "D" || ch === "X") out += "D";
    else if (ch === "A" || ch === "2") out += "A";
  }
  if (out.length >= 2) return out.slice(0, 2);
  return null;
}
function collectHtftProbabilities(fix){
  const addFromSource = (out, src) => {
    if (!src || typeof src !== "object") return;
    for (const [rawKey, rawVal] of Object.entries(src)) {
      const code = normalizeHtftOutcomeCode(rawKey);
      if (!code) continue;
      const prob = toProbability(rawVal);
      if (prob != null) out[code] = prob;
    }
  };
  const out = {};
  const sources = [
    fix?.model_probs?.htft,
    fix?.model_probs?.htft_probs,
    fix?.model_probs?.htft_probabilities,
    fix?.model?.htft,
    fix?.model?.htft_probs,
    fix?.model?.htft_probabilities,
    fix?.models?.htft,
    fix?.models?.htft_probs,
    fix?.models?.htft_probabilities,
    fix?.htft,
    fix?.htft_probs,
  ];
  for (const src of sources) addFromSource(out, src);
  for (const code of HTFT_CODES) {
    if (out[code] != null) continue;
    const lower = code.toLowerCase();
    const prob = probabilityFromPaths(fix, [
      ["model_probs","htft",lower],
      ["model_probs","htft",code],
      ["model","htft",lower],
      ["model","htft",code],
      ["models","htft",lower],
      ["models","htft",code],
    ]);
    if (prob != null) out[code] = prob;
  }
  return Object.keys(out).length ? out : null;
}
function normalizedModelProbs(fix){
  const candidates = [fix?.model_probs, fix?.model?.probs, fix?.model?.probabilities, fix?.models?.probs, fix?.models?.probabilities];
  for (const src of candidates) {
    if (!src || typeof src !== "object") continue;
    const home = probabilityValue(src, ["home","Home","HOME","1","H","home_win","homeWin","p1","prob_home","prob1"]);
    const draw = probabilityValue(src, ["draw","Draw","DRAW","X","D","drawn","pX","prob_draw","probx"]);
    const away = probabilityValue(src, ["away","Away","AWAY","2","A","away_win","awayWin","p2","prob_away","prob2"]);
    if (home == null && draw == null && away == null) continue;
    const out = {};
    if (home != null) { out.home = home; out["1"] = home; }
    if (draw != null) { out.draw = draw; out["X"] = draw; }
    if (away != null) { out.away = away; out["2"] = away; }
    return out;
  }
  return null;
}
function buildModelContext(fix){
  return {
    oneXtwo: normalizedModelProbs(fix),
    btts: probabilityFromPaths(fix, [
      ["btts_probability"],
      ["model_probs","btts_yes"],
      ["model_probs","btts","yes"],
      ["model","btts_probability"],
      ["model","btts","yes"],
      ["models","btts","yes"],
    ]),
    ou25: probabilityFromPaths(fix, [
      ["over25_probability"],
      ["ou25_probability"],
      ["model_probs","over25"],
      ["model_probs","ou25_over"],
      ["model","over25_probability"],
      ["model","ou25","over"],
      ["models","ou25","over"],
    ]),
    fh_ou15: probabilityFromPaths(fix, [
      ["fh_over15_probability"],
      ["model_probs","fh_over15"],
      ["model_probs","fh_ou15_over"],
      ["model","fh_ou15","over"],
      ["models","fh_ou15","over"],
    ]),
    htft: collectHtftProbabilities(fix),
  };
}
function impliedFromPrice(price){
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 1) return null;
  return 1 / p;
}
function normalizePickCode(rawCode, rawPick, rawLabel){
  const candidates = [rawCode, rawPick, rawLabel];
  for (const cand of candidates) {
    if (!cand) continue;
    const str = String(cand).trim();
    if (!str) continue;
    const up = str.toUpperCase();
    if (up.includes(":")) {
      const parts = up.split(":");
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    return up;
  }
  return "";
}
function modelProbabilityFor(ctx, marketRaw, pickCodeRaw, pickRaw, labelRaw){
  const market = String(marketRaw || "").toUpperCase();
  const code = normalizePickCode(pickCodeRaw, pickRaw, labelRaw);
  if (!code) return null;

  if (market === "BTTS") {
    const yes = ctx?.btts;
    if (yes == null) return null;
    if (code === "Y" || code === "YES") return yes;
    if (code === "N" || code === "NO") return 1 - yes;
    return null;
  }

  if (market === "OU2.5" || market === "O/U 2.5" || market === "OU25") {
    const over = ctx?.ou25;
    if (over == null) return null;
    if (code.startsWith("O")) return over;
    if (code.startsWith("U")) return 1 - over;
    return null;
  }

  if (market === "FH_OU1.5" || market === "FH OU1.5" || market === "FH-OU1.5") {
    const over = ctx?.fh_ou15;
    if (over == null) return null;
    if (code.includes("O")) return over;
    if (code.includes("U")) return 1 - over;
    return null;
  }

  if (market === "1X2" || market === "1X-2") {
    const map = ctx?.oneXtwo;
    if (!map) return null;
    if (code === "1" || code === "HOME") return map["1"] ?? map.home ?? null;
    if (code === "X" || code === "DRAW") return map["X"] ?? map.draw ?? null;
    if (code === "2" || code === "AWAY") return map["2"] ?? map.away ?? null;
    return null;
  }

  if (market === "HTFT" || market === "HT/FT" || market === "HT-FT") {
    const map = ctx?.htft;
    if (!map) return null;
    let lookup = code.trim();
    if (!lookup) return null;
    let negate = false;
    const NEG_PREFIXES = ["NOT ", "NO "];
    for (const pre of NEG_PREFIXES) {
      if (lookup.startsWith(pre)) {
        negate = true;
        lookup = lookup.slice(pre.length).trim();
        break;
      }
    }
    if (!negate && lookup.startsWith("!")) {
      negate = true;
      lookup = lookup.slice(1).trim();
    }
    const NEG_SUFFIXES = [" NOT", " NO", "_NOT", "_NO", "-NOT", "-NO", "/NOT", "/NO"];
    for (const suf of NEG_SUFFIXES) {
      if (lookup.endsWith(suf)) {
        negate = true;
        lookup = lookup.slice(0, -suf.length).trim();
        break;
      }
    }
    const htftCode = normalizeHtftOutcomeCode(lookup);
    if (!htftCode) return null;
    const prob = map[htftCode];
    if (prob == null) return null;
    if (negate) return 1 - prob;
    return prob;
  }

  return null;
}
function confidenceFromModel(prob, implied){
  const hasProb = Number.isFinite(prob);
  const hasImplied = Number.isFinite(implied);
  if (!hasProb && !hasImplied) return 0;

  if (hasProb) {
    const p = Math.max(0, Math.min(1, prob));
    const base = p * 100;
    if (hasImplied) {
      const edge = (p - implied) * 100;
      const boosted = base + edge * 0.65;
      return Math.round(Math.max(20, Math.min(88, boosted)));
    }
    return Math.round(Math.max(20, Math.min(88, base)));
  }

  const ip = Math.max(0, Math.min(1, implied));
  return Math.round(Math.max(20, Math.min(88, ip * 100)));
}
function applyModelFields(candidate, ctx){
  const prob = modelProbabilityFor(ctx, candidate.market, candidate.pick_code, candidate.pick, candidate.selection_label);
  const implied = impliedFromPrice(candidate?.odds?.price);
  candidate.model_prob = prob != null ? prob : null;
  candidate.implied_prob = implied != null ? implied : null;
  const marketKey = (candidate.market || "").toUpperCase();
  if (marketKey === "1X2" && ctx?.oneXtwo) {
    candidate.model_probs = ctx.oneXtwo;
  }
  if ((marketKey === "HTFT" || marketKey === "HT/FT" || marketKey === "HT-FT") && ctx?.htft) {
    candidate.model_probs_htft = { ...ctx.htft };
  }
  candidate.confidence_pct = confidenceFromModel(prob, implied);
  return candidate;
}
function oneXtwoCapForSlot(slot, we){ if(slot==="late") return CAP_LATE; if(!we) return slot==="am"?CAP_AM_WD:CAP_PM_WD; return slot==="am"?CAP_AM_WE:CAP_PM_WE; }

function keyPartForFixture(val){
  if (val == null) return "";
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed ? trimmed.toLowerCase() : "";
  }
  if (typeof val === "object") {
    const candidates = [val.id, val.ID, val.fixture_id, val.name, val.team, val.code, val.label];
    for (const cand of candidates) {
      const part = keyPartForFixture(cand);
      if (part) return part;
    }
  }
  try {
    const str = String(val).trim();
    return str ? str.toLowerCase() : "";
  } catch {
    return "";
  }
}

function fixtureKeyForPick(it){
  if (!it || typeof it !== "object") return null;
  const fid = it.fixture_id ?? it.fixture?.id;
  if (fid != null && fid !== "") return `fid:${fid}`;
  const league = keyPartForFixture(it.league?.id ?? it.league?.name ?? it.league_name ?? it.league);
  const kickoff = keyPartForFixture(it.kickoff_utc ?? it.kickoff ?? it.fixture?.date);
  const home = keyPartForFixture(
    it.teams?.home?.id ?? it.teams?.home?.name ?? it.home?.id ?? it.home?.name ?? it.home_name ?? it.home
  );
  const away = keyPartForFixture(
    it.teams?.away?.id ?? it.teams?.away?.name ?? it.away?.id ?? it.away?.name ?? it.away_name ?? it.away
  );
  const key = [league, kickoff, home, away].filter(Boolean).join("|");
  return key || null;
}

function dedupeByFixture(items){
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []){
    const key = fixtureKeyForPick(it);
    if (key){
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(it);
  }
  return out;
}

/* =========================
 *  Learning helpers
 * ========================= */
function pickKeyForCandidate(it) {
  if (!it || typeof it !== "object") return null;
  const fid = it.fixture_id ?? it.fixture?.id ?? it.model?.fixture ?? it.model?.fixture_id ?? null;
  const fixturePart = fid != null ? `fid:${fid}` : (fixtureKeyForPick(it) || `kick:${String(it.kickoff_utc || it.kickoff || "")}`);
  const market = resolveMarketBucket(it.market || "");
  const pickCodeRaw = it.pick_code || it.pick || it.selection_label || it.selection || "";
  const pick = String(pickCodeRaw).trim().toUpperCase() || "?";
  const price = Number(it?.odds?.price ?? it.price);
  const pricePart = Number.isFinite(price) ? price.toFixed(2) : "na";
  return `${fixturePart}|${market}|${pick}|${pricePart}`;
}

function learningBucketForCandidate(it) {
  const marketBucket = resolveMarketBucket(it?.market || "");
  const rawPrice = Number(it?.odds?.price ?? it.price);
  const oddsBand = resolveOddsBand(rawPrice);
  const leagueObj = it?.league || it?.fixture?.league || null;
  const leagueTier = resolveLeagueTier(leagueObj || {});
  const leagueId = it?.league?.id ?? it?.league_id ?? it?.leagueId ?? leagueObj?.id ?? null;
  const leagueKey = leagueId != null && leagueId !== "" ? String(leagueId) : null;
  return { marketBucket, oddsBand, leagueTier, leagueKey, price: Number.isFinite(rawPrice) ? rawPrice : null };
}

function edgeFromProb(prob, implied) {
  if (!Number.isFinite(prob) || !Number.isFinite(implied)) return null;
  const edge = (prob - implied) * 100;
  return Number.isFinite(edge) ? Number(edge.toFixed(3)) : null;
}

function ensureLearningMetaEntry(metaMap, candidate, bucket, baselineEdge, baselineProb) {
  const key = pickKeyForCandidate(candidate);
  if (!key) return null;
  const implied = Number.isFinite(candidate?.implied_prob)
    ? candidate.implied_prob
    : impliedFromPrice(candidate?.odds?.price);
  let entry = metaMap.get(key);
  if (!entry) {
    entry = {
      pick_key: key,
      fixture_id: candidate.fixture_id ?? candidate.fixture?.id ?? null,
      market: resolveMarketBucket(candidate.market || ""),
      pick_code: candidate.pick_code || candidate.pick || candidate.selection_label || null,
      odds_price: Number.isFinite(candidate?.odds?.price) ? Number(candidate.odds.price) : null,
      implied_prob: Number.isFinite(implied) ? implied : null,
      baseline_prob: Number.isFinite(baselineProb) ? baselineProb : null,
      baseline_edge_pp: Number.isFinite(baselineEdge) ? baselineEdge : null,
      buckets: bucket,
      samples: { calib: null, evmin: null, league: null },
      adjustments: { calib: false, evmin: false, league: false },
    };
    metaMap.set(key, entry);
  } else {
    if (entry.buckets == null && bucket) entry.buckets = bucket;
    if (entry.baseline_prob == null && Number.isFinite(baselineProb)) entry.baseline_prob = baselineProb;
    if (entry.baseline_edge_pp == null && Number.isFinite(baselineEdge)) entry.baseline_edge_pp = baselineEdge;
    if (entry.implied_prob == null && Number.isFinite(implied)) entry.implied_prob = implied;
  }
  return entry;
}

function cloneCandidate(it) {
  try {
    if (typeof structuredClone === "function") return structuredClone(it);
    return JSON.parse(JSON.stringify(it));
  } catch {
    return JSON.parse(JSON.stringify(it));
  }
}

function applyLearningToCandidate(original, context, metaMap, bucketMap) {
  if (!original || typeof original !== "object") return null;
  const clone = cloneCandidate(original);
  const key = pickKeyForCandidate(original);
  const bucket = (key && bucketMap.get(key)) || learningBucketForCandidate(original);

  const implied = Number.isFinite(clone?.implied_prob)
    ? Number(clone.implied_prob)
    : impliedFromPrice(clone?.odds?.price);
  if (Number.isFinite(implied)) clone.implied_prob = implied;

  const baselineProb = Number.isFinite(original?.model_prob) ? Number(original.model_prob) : null;
  const baselineEdge = Number.isFinite(original?.edge_pp) ? Number(original.edge_pp) : null;
  const metaEntry = ensureLearningMetaEntry(metaMap, clone, bucket, baselineEdge, baselineProb);

  let prob = baselineProb;
  if (!Number.isFinite(prob)) {
    if (metaEntry) {
      metaEntry.learned_prob = prob;
      metaEntry.learned_edge_pp = baselineEdge;
      metaEntry.ev_guard_used = null;
      metaEntry.passes_ev = true;
    }
    clone.learning_meta = {
      buckets: bucket,
      calibration: null,
      league: null,
      ev: null,
      passes_ev: true,
    };
    clone.edge_pp = baselineEdge;
    clone.confidence_pct = Number.isFinite(clone.confidence_pct)
      ? clone.confidence_pct
      : confidenceFromModel(prob, implied);
    clone.confidence = clone.confidence_pct;
    return { candidate: clone, passesEv: true };
  }

  let calibrationResult = null;
  const calibrationKey = bucket && bucket.marketBucket && bucket.leagueTier && bucket.oddsBand
    ? `${bucket.marketBucket}:${bucket.leagueTier}:${bucket.oddsBand}`
    : null;
  if (context.flags.enable_calib && calibrationKey) {
    const doc = context.calibrations.get(calibrationKey);
    if (doc) {
      calibrationResult = applyCalibration(prob, doc);
      prob = calibrationResult.prob;
    }
  }

  let leagueResult = null;
  const leagueKey = bucket && bucket.leagueKey ? String(bucket.leagueKey) : null;
  if (context.flags.enable_league_adj && leagueKey) {
    const doc = context.leagueAdj.get(leagueKey);
    if (doc) {
      leagueResult = applyLeagueAdjustment(prob, doc);
      prob = leagueResult.prob;
    }
  }

  prob = Math.max(0, Math.min(1, prob));
  clone.model_prob = prob;

  const edge = edgeFromProb(prob, implied);
  clone.edge_pp = edge;

  const marketForGuard = bucket?.marketBucket || resolveMarketBucket(clone.market || "");
  let guard = resolveDefaultEvGuard(marketForGuard);
  let evResult = { guard_pp: guard, applied: false, samples: 0 };
  const evKey = bucket && bucket.marketBucket && bucket.oddsBand ? `${bucket.marketBucket}:${bucket.oddsBand}` : null;
  if (context.flags.enable_evmin && evKey) {
    const doc = context.evmin.get(evKey);
    if (doc) {
      evResult = applyEvGuard(guard, doc);
      guard = evResult.guard_pp;
    }
  }
  guard = Math.max(0.5, Math.min(8, guard));
  clone.ev_guard_pp = guard;

  const passesEv = !(Number.isFinite(edge) && edge < guard);

  clone.learning_meta = {
    buckets: bucket,
    calibration: calibrationResult ? { key: calibrationKey, ...calibrationResult } : null,
    league: leagueResult ? { key: leagueKey, ...leagueResult } : null,
    ev: evResult ? { key: evKey, ...evResult } : null,
    passes_ev: passesEv,
  };

  clone.confidence_pct = confidenceFromModel(prob, implied);
  clone.confidence = clone.confidence_pct;

  if (metaEntry) {
    metaEntry.learned_prob = prob;
    metaEntry.learned_edge_pp = edge;
    metaEntry.ev_guard_used = guard;
    metaEntry.passes_ev = passesEv;
    metaEntry.samples = {
      calib: calibrationResult ? calibrationResult.samples : metaEntry.samples?.calib ?? null,
      evmin: evResult ? evResult.samples : metaEntry.samples?.evmin ?? null,
      league: leagueResult ? leagueResult.samples : metaEntry.samples?.league ?? null,
    };
    metaEntry.adjustments = {
      calib: Boolean(calibrationResult && calibrationResult.applied),
      evmin: Boolean(evResult && evResult.applied),
      league: Boolean(leagueResult && leagueResult.applied),
    };
  }

  return { candidate: clone, passesEv };
}

function applyLearningSet(list, context, metaMap, bucketMap) {
  const picks = [];
  const dropped = [];
  for (const item of Array.isArray(list) ? list : []) {
    const res = applyLearningToCandidate(item, context, metaMap, bucketMap);
    if (!res) continue;
    if (res.passesEv) picks.push(res.candidate);
    else dropped.push(res.candidate);
  }
  return { picks, dropped };
}

async function loadLearningContext(bucketMap, flags, trace) {
  const calibrations = new Map();
  const evmin = new Map();
  const leagueAdj = new Map();
  const normalized = normalizeFlags(flags || LEARNING_DEFAULT_FLAGS);

  const calibKeys = new Set();
  const evKeys = new Set();
  const leagueKeys = new Set();

  for (const bucket of bucketMap.values()) {
    if (!bucket) continue;
    if (normalized.enable_calib && bucket.marketBucket !== "UNK" && bucket.oddsBand !== "UNK") {
      calibKeys.add(`${bucket.marketBucket}:${bucket.leagueTier}:${bucket.oddsBand}`);
    }
    if (normalized.enable_evmin && bucket.marketBucket !== "UNK" && bucket.oddsBand !== "UNK") {
      evKeys.add(`${bucket.marketBucket}:${bucket.oddsBand}`);
    }
    if (normalized.enable_league_adj && bucket.leagueKey) {
      leagueKeys.add(String(bucket.leagueKey));
    }
  }

  const tasks = [];
  for (const key of calibKeys) {
    tasks.push((async () => {
      const [market, tier, odds] = key.split(":");
      const kvKey = `learn:calib:v2:${market}:${tier}:${odds}`;
      const doc = kvToObject(await kvGET(kvKey, trace));
      calibrations.set(key, doc);
    })());
  }
  for (const key of evKeys) {
    tasks.push((async () => {
      const [market, odds] = key.split(":");
      const kvKey = `learn:evmin:v2:${market}:${odds}`;
      const doc = kvToObject(await kvGET(kvKey, trace));
      evmin.set(key, doc);
    })());
  }
  for (const leagueId of leagueKeys) {
    tasks.push((async () => {
      const kvKey = `learn:league_adj:v1:${leagueId}`;
      const doc = kvToObject(await kvGET(kvKey, trace));
      leagueAdj.set(leagueId, doc);
    })());
  }

  await Promise.all(tasks);

  return { flags: normalized, calibrations, evmin, leagueAdj };
}

function buildSelections({ candidates, oneXtwoAll, slot, weekend }) {
  const ranked = (Array.isArray(candidates) ? candidates : []).slice().sort((a, b) => (b.confidence_pct || 0) - (a.confidence_pct || 0));
  const afterUefa = applyUefaCap(ranked, UEFA_DAILY_CAP);
  const leagueCapped = capPerLeague(afterUefa, VB_MAX_PER_LEAGUE);
  const topN = leagueCapped.slice(0, VB_LIMIT);
  const tickets = topKPerMarket(leagueCapped, 3, 5);

  const oneXtwoSorted = (Array.isArray(oneXtwoAll) ? oneXtwoAll : []).slice().sort((a, b) => (b.confidence_pct || 0) - (a.confidence_pct || 0));
  const deduped = dedupeByFixture(oneXtwoSorted);
  const cap = oneXtwoCapForSlot(slot, weekend);
  const one_x_two_raw = capPerLeague(deduped, VB_MAX_PER_LEAGUE).slice(0, cap);

  return { topN, tickets, one_x_two_raw };
}

async function readLearningFlags(trace) {
  const raw = await kvGET("cfg:learning", trace);
  const obj = kvToObject(raw);
  return normalizeFlags(obj || LEARNING_DEFAULT_FLAGS);
}

/* =========================
 *  Candidate builders
 * ========================= */
function resolveFixtureTier(fix) {
  const direct = [
    fix?.tier,
    fix?.match_selector?.tier,
    fix?.match_selector?.tier_key,
    fix?.match_selector?.tierKey,
    fix?.tier_key,
    fix?.tierKey,
    fix?.league?.tier,
    fix?.league?.tier_key,
    fix?.league?.tierKey,
    fix?.league?.tier_level,
    fix?.league?.tierLevel,
  ];
  for (const cand of direct) {
    if (typeof cand === "string") {
      const trimmed = cand.trim();
      if (trimmed) return trimmed;
    }
    const num = Number(cand);
    if (Number.isFinite(num)) {
      return resolveLeagueTier({ tier: num });
    }
  }
  if (fix?.league) {
    const leagueTier = resolveLeagueTier(fix.league);
    if (leagueTier) return leagueTier;
  }
  if (fix?.league_name || fix?.league_country) {
    const fallback = resolveLeagueTier({ name: fix.league_name, country: fix.league_country });
    if (fallback) return fallback;
  }
  return null;
}

function fromMarkets(fix){
  const out=[]; const m=fix?.markets||{}; const fid=fix.fixture_id||fix.fixture?.id; const ctx = buildModelContext(fix);
  const resolvedTier = resolveFixtureTier(fix) ?? (fix?.league ? resolveLeagueTier(fix.league) : null);

  const push = (market, pick, pickCode, selectionLabel, rawPrice) => {
    const price = Number(rawPrice);
    if (!Number.isFinite(price)) return;
    const cand = {
      fixture_id: fid,
      market,
      pick,
      pick_code: pickCode,
      selection_label: selectionLabel,
      odds: { price },
      tier: resolvedTier,
    };
    applyModelFields(cand, ctx);
    if (resolvedTier != null) cand.tier = resolvedTier;
    out.push(cand);
  };

  if (Number.isFinite(m?.btts?.yes) && m.btts.yes>=MIN_ODDS && m.btts.yes<=MAX_ODDS) {
    push("BTTS", "Yes", "BTTS:Y", "BTTS Yes", m.btts.yes);
  }
  if (Number.isFinite(m?.ou25?.over) && m.ou25.over>=MIN_ODDS && m.ou25.over<=MAX_ODDS) {
    push("OU2.5", "Over 2.5", "O2.5", "Over 2.5", m.ou25.over);
  }
  if (Number.isFinite(m?.fh_ou15?.over) && m.fh_ou15.over>=MIN_ODDS && m.fh_ou15.over<=Math.max(MAX_ODDS,10)) {
    push("FH_OU1.5", "Over 1.5 FH", "FH O1.5", "FH Over 1.5", m.fh_ou15.over);
  }
  const htft=m.htft||{}; const ORDER=["hh","dd","aa","hd","dh","ha","ah","da","ad"];
  for (const code of ORDER){
    const price=Number(htft[code]);
    if (Number.isFinite(price) && price>=MIN_ODDS && price<=Math.max(MAX_ODDS,10)) {
      push("HTFT", code.toUpperCase(), `HTFT:${code.toUpperCase()}`, `HT/FT ${code.toUpperCase()}`, price);
      if (out.length>=6) break;
    }
  }

  for (const c of out) {
    c.league=fix.league; c.league_name=fix.league?.name; c.league_country=fix.league?.country;
    c.teams=fix.teams; c.home=fix.home; c.away=fix.away;
    c.kickoff=fix.kickoff; c.kickoff_utc=fix.kickoff_utc||fix.kickoff;
    if (typeof c.tier === "undefined" && resolvedTier != null) c.tier = resolvedTier;
    if (typeof c.model_prob !== "number") c.model_prob = c.model_prob != null ? Number(c.model_prob) : null;
  }
  return out;
}
function oneXtwoOffers(fix){
  const xs=[]; const x=fix?.markets?.['1x2']||{}; const fid=fix.fixture_id||fix.fixture?.id; const ctx = buildModelContext(fix);
  const resolvedTier = resolveFixtureTier(fix) ?? (fix?.league ? resolveLeagueTier(fix.league) : null);
  const push=(code,label,price)=>{
    const p=Number(price);
    if(!Number.isFinite(p)||p<MIN_ODDS||p>MAX_ODDS) return;
    const cand={
      fixture_id:fid, market:"1x2", pick:code, pick_code:code, selection_label:label, odds:{price:p},
      league:fix.league, league_name:fix.league?.name,
      league_country:fix.league?.country, teams:fix.teams, home:fix.home, away:fix.away,
      kickoff:fix.kickoff, kickoff_utc:fix.kickoff_utc||fix.kickoff,
      tier: resolvedTier,
    };
    applyModelFields(cand, ctx);
    if (resolvedTier != null) cand.tier = resolvedTier;
    xs.push(cand);
  };
  if (x.home) push("1","Home",x.home);
  if (x.draw) push("X","Draw",x.draw);
  if (x.away) push("2","Away",x.away);
  return xs;
}
function capPerLeague(items, maxPerLeague){
  const per=new Map(), out=[];
  for (const it of items){
    const key=String(it?.league?.id||it?.league_name||"?");
    const cur=per.get(key)||0; if (cur>=maxPerLeague) continue;
    per.set(key,cur+1); out.push(it);
  }
  return out;
}
function topKPerMarket(items, kMin=3, kMax=5){
  const buckets = { BTTS:[], "OU2.5":[], "FH_OU1.5":[], HTFT:[] };
  for (const it of items) if (buckets[it.market]) buckets[it.market].push(it);
  for (const key of Object.keys(buckets)) buckets[key].sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
  const clamp = arr => arr.slice(0, Math.max(kMin, Math.min(kMax, arr.length)));
  return {
    btts:   clamp(buckets.BTTS),
    ou25:   clamp(buckets["OU2.5"]),
    fh_ou15:clamp(buckets["FH_OU1.5"]),
    htft:   clamp(buckets.HTFT),
  };
}
function applyUefaCap(items, cap){
  const out=[]; let cnt=0;
  for (const it of items){
    if (isUEFA(it.league)) { if (cnt>=cap) continue; cnt++; }
    out.push(it);
  }
  return out;
}

/* ===== Alias layer to match legacy frontend ===== */
function aliasItem(it){
  const resolvedTier = (() => {
    const direct = resolveFixtureTier(it);
    if (direct) return direct;
    if (it?.league) {
      const leagueTier = resolveLeagueTier(it.league);
      if (leagueTier) return leagueTier;
    }
    if (it?.league_name || it?.league_country) {
      const fallback = resolveLeagueTier({ name: it.league_name, country: it.league_country });
      if (fallback) return fallback;
    }
    return null;
  })();
  const a = { ...it };
  if (resolvedTier != null) a.tier = resolvedTier;
  // legacy confidence
  a.confidence = typeof it.confidence !== "undefined" ? it.confidence : (it.confidence_pct ?? 0);
  // legacy price on root
  if (it?.odds && typeof it.odds.price !== "undefined") a.price = Number(it.odds.price);
  // legacy names
  if (it.home && !a.home_name) a.home_name = it.home;
  if (it.away && !a.away_name) a.away_name = it.away;
  // kickoff timestamp if frontend sorts by number
  a.kickoff_ts = (() => {
    const s = it.kickoff_utc || it.kickoff;
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : null;
  })();
  return a;
}

/* =========================
 *  Handler
 * ========================= */
export default async function handler(req,res){
  const trace=[];
  try{
    const now=new Date(); const ymd=ymdInTZ(now, TZ);
    let slot=String(req.query.slot||"auto").toLowerCase();
    if (!["late","am","pm"].includes(slot)) slot=pickSlotAuto(now);
    const weekend=isWeekend(ymd);

    const unionKey=`vb:day:${ymd}:${slot}`;
    const fullKey =`vbl_full:${ymd}:${slot}`;
    const lastKey =`vb:last-odds:${slot}`;
    const union=kvToItems(await kvGET(unionKey, trace));
    const full =kvToItems(await kvGET(fullKey,  trace));
    const lastRefresh=kvToObject(await kvGET(lastKey, trace));
    const base = full.items.length ? full.items : union.items;

    if (!base.length) {
      return res.status(200).json({
        ok:true, ymd, slot, source:null,
        items:[], tickets:{ btts:[], ou25:[], fh_ou15:[], htft:[], BTTS:[], OU25:[], FH_OU15:[], HTFT:[] },
        one_x_two: [], meta:{ last_odds_refresh: lastRefresh }, debug:{ trace }
      });
    }

    const candidates = [];
    for (const f of base) candidates.push(...fromMarkets(f));

    const oneXtwoAll = [];
    for (const f of base) oneXtwoAll.push(...oneXtwoOffers(f));

    const bucketMap = new Map();
    const learningMeta = new Map();

    for (const cand of candidates) {
      const bucket = learningBucketForCandidate(cand);
      const key = pickKeyForCandidate(cand);
      if (key) bucketMap.set(key, bucket);
      const prob = Number.isFinite(cand.model_prob) ? Number(cand.model_prob) : null;
      const implied = Number.isFinite(cand.implied_prob) ? Number(cand.implied_prob) : impliedFromPrice(cand?.odds?.price);
      if (Number.isFinite(implied)) cand.implied_prob = implied;
      const edge = edgeFromProb(prob, implied);
      if (edge != null) cand.edge_pp = edge;
      cand.confidence = cand.confidence_pct;
      ensureLearningMetaEntry(learningMeta, cand, bucket, edge, prob);
    }

    for (const cand of oneXtwoAll) {
      const bucket = learningBucketForCandidate(cand);
      const key = pickKeyForCandidate(cand);
      if (key) bucketMap.set(key, bucket);
      const prob = Number.isFinite(cand.model_prob) ? Number(cand.model_prob) : null;
      const implied = Number.isFinite(cand.implied_prob) ? Number(cand.implied_prob) : impliedFromPrice(cand?.odds?.price);
      if (Number.isFinite(implied)) cand.implied_prob = implied;
      const edge = edgeFromProb(prob, implied);
      if (edge != null) cand.edge_pp = edge;
      cand.confidence = cand.confidence_pct;
      ensureLearningMetaEntry(learningMeta, cand, bucket, edge, prob);
    }

    const baselineSelections = buildSelections({ candidates, oneXtwoAll, slot, weekend });

    const aliasTickets = (ticketsObj) => ({
      btts: ticketsObj.btts.map(aliasItem),
      ou25: ticketsObj.ou25.map(aliasItem),
      fh_ou15: ticketsObj.fh_ou15.map(aliasItem),
      htft: ticketsObj.htft.map(aliasItem),
      BTTS: ticketsObj.btts.map(aliasItem),
      OU25: ticketsObj.ou25.map(aliasItem),
      FH_OU15: ticketsObj.fh_ou15.map(aliasItem),
      HTFT: ticketsObj.htft.map(aliasItem),
    });

    const baselineItems = baselineSelections.topN.map(aliasItem);
    const baselineTicketsAliased = aliasTickets(baselineSelections.tickets);
    const baselineOneXtwo = baselineSelections.one_x_two_raw.map(aliasItem);

    const flags = await readLearningFlags(trace);
    const learningEnabled = Boolean(flags.enable_calib || flags.enable_evmin || flags.enable_league_adj);
    const shadowKey = `vb:shadow:${ymd}:${slot}`;
    const baseSource = full.items.length ? "vbl_full" : "vb:day";

    let finalItems = baselineItems;
    let finalTickets = baselineTicketsAliased;
    let finalOneXtwo = baselineOneXtwo;
    let responseSource = baseSource;
    let shadowWriteOk = false;

    let learningDebug = {
      flags,
      enabled: learningEnabled,
      shadow_mode: flags.shadow_mode,
      applied: false,
      shadow_key: shadowKey,
      wrote_shadow: false,
    };

    if (learningEnabled) {
      const context = await loadLearningContext(bucketMap, flags, trace);
      const learnedCandidates = applyLearningSet(candidates, context, learningMeta, bucketMap);
      const learnedOneXtwo = applyLearningSet(oneXtwoAll, context, learningMeta, bucketMap);
      const learnedSelections = buildSelections({
        candidates: learnedCandidates.picks,
        oneXtwoAll: learnedOneXtwo.picks,
        slot,
        weekend,
      });

      const learnedItems = learnedSelections.topN.map(aliasItem);
      const learnedTicketsAliased = aliasTickets(learnedSelections.tickets);
      const learnedOneXtwoAliased = learnedSelections.one_x_two_raw.map(aliasItem);

      const shadowPayload = {
        baseline: baselineItems,
        learned: learnedItems,
        one_x_two_baseline: baselineOneXtwo,
        one_x_two_learned: learnedOneXtwoAliased,
        tickets: {
          baseline: baselineTicketsAliased,
          learned: learnedTicketsAliased,
        },
        meta: {
          ymd,
          slot,
          generated_at: new Date().toISOString(),
          flags,
          shadow_mode: flags.shadow_mode,
          picks: Array.from(learningMeta.values()),
        },
      };

      try {
        shadowWriteOk = await kvSET(shadowKey, shadowPayload, trace);
      } catch {
        shadowWriteOk = false;
      }

      learningDebug = {
        ...learningDebug,
        context_keys: {
          calib: context.calibrations.size,
          evmin: context.evmin.size,
          league: context.leagueAdj.size,
        },
        wrote_shadow: Boolean(shadowWriteOk),
        dropped: learnedCandidates.dropped.length + learnedOneXtwo.dropped.length,
      };

      if (!flags.shadow_mode) {
        finalItems = learnedItems;
        finalTickets = learnedTicketsAliased;
        finalOneXtwo = learnedOneXtwoAliased;
        responseSource = `${baseSource}+learning`;
        learningDebug.applied = true;
      }
    }

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      source: responseSource,
      items: finalItems,
      tickets: finalTickets,
      one_x_two: finalOneXtwo,
      meta: { last_odds_refresh: lastRefresh },
      debug: { trace, learning: learningDebug },
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
