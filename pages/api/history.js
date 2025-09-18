// pages/api/history.js
export const config = { api: { bodyParser: false } };

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get: key, ok: r.ok, flavor: b.flavor, hit: !!raw });
      if (!r.ok) continue;
      return { raw, flavor: b.flavor };
    } catch (e) {
      trace && trace.push({ get: key, ok: false, err: String(e?.message || e) });
    }
  }
  return { raw: null, flavor: null };
}

/* ---------- helpers ---------- */
const J = (s) => {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
};
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const onlyMarketsCSV = (process.env.HISTORY_ALLOWED_MARKETS || "h2h")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const allowSet = new Set(onlyMarketsCSV.length ? onlyMarketsCSV : ["h2h"]);
const arrFromAny = (x) =>
  Array.isArray(x)
    ? x
    : x && typeof x === "object" && Array.isArray(x.items)
    ? x.items
    : x && typeof x === "object" && Array.isArray(x.history)
    ? x.history
    : x && typeof x === "object" && Array.isArray(x.list)
    ? x.list
    : [];
const dedupKey = (e) =>
  `${e?.fixture_id || e?.id || "?"}__${String(e?.market_key || "").toLowerCase()}__${String(
    e?.pick || ""
  ).toLowerCase()}`;

function filterAllowed(arr) {
  const by = new Map();
  for (const e of arr || []) {
    const mkey = String(e?.market_key || "").toLowerCase();
    if (!allowSet.has(mkey)) continue;
    const k = dedupKey(e);
    if (!by.has(k)) by.set(k, e);
  }
  return Array.from(by.values());
}

const toNumberOrNull = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};
const parsePercentish = (val) => {
  if (typeof val === "string") {
    const s = val.trim();
    if (s.endsWith("%")) {
      const n = Number(s.slice(0, -1));
      if (Number.isFinite(n)) return n / 100;
    }
  }
  return toNumberOrNull(val);
};
const firstNumber = (...vals) => {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function ensureItemsHaveYmd(items, ymd) {
  if (!ymd) return Array.isArray(items) ? items.slice() : [];
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (it && typeof it === "object") {
      if (it.ymd) {
        out.push(it);
      } else {
        out.push({ ...it, ymd });
      }
    } else {
      out.push(it);
    }
  }
  return out;
}

function extractOdds(entry) {
  const candidates = [
    entry?.price_snapshot,
    entry?.price,
    entry?.decimal,
    entry?.odd,
    entry?.odds?.price,
    entry?.snapshot?.price,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function computeROIstats(items) {
  let played = 0;
  let wins = 0;
  let profit = 0;
  let avgOdds = 0;
  for (const e of Array.isArray(items) ? items : []) {
    const rawRes = (e?.result ?? e?.outcome ?? "").toString().toLowerCase();
    const won = e?.won === true || /win/.test(rawRes);
    const lost = (e?.won === false && !won) || /loss|lose/.test(rawRes);
    if (!won && !lost) continue; // pending/void
    const odds = extractOdds(e);
    played += 1;
    if (won) {
      wins += 1;
      if (odds != null) {
        profit += odds - 1;
        avgOdds += odds;
      }
    } else if (lost) {
      profit -= 1;
      if (odds != null) avgOdds += odds;
    }
  }
  const roi = played ? profit / played : 0;
  const winrate = played ? wins / played : 0;
  const avg_odds = played ? avgOdds / played : 0;
  return { played, wins, profit, roi, winrate, avg_odds };
}

function toRoiObject(candidate, counts, items, sourceLabel) {
  if (!candidate || typeof candidate !== "object") return null;
  const played = toNumberOrNull(
    firstNumber(
      candidate.played,
      candidate.decided,
      candidate.settled,
      counts?.settled,
      counts?.decided
    )
  );
  const wins = toNumberOrNull(firstNumber(candidate.wins, candidate.win, candidate.won, counts?.won));
  const losses = toNumberOrNull(firstNumber(candidate.losses, candidate.lost, counts?.lost));
  let profit = toNumberOrNull(candidate.profit);
  const staked = toNumberOrNull(firstNumber(candidate.staked, candidate.played, counts?.settled));
  const returned = toNumberOrNull(candidate.returned);
  if (profit == null && staked != null && returned != null) profit = returned - staked;
  let roiVal = parsePercentish(candidate.roi);
  if (roiVal == null && candidate.roi_pct != null) roiVal = parsePercentish(candidate.roi_pct);
  if (roiVal == null && candidate.roi_percent != null) roiVal = parsePercentish(candidate.roi_percent);
  if (roiVal == null && profit != null && staked && staked !== 0) roiVal = profit / staked;
  const avgOdds = toNumberOrNull(firstNumber(candidate.avg_odds, candidate.avgOdds, candidate.average_odds));
  let winrate = parsePercentish(candidate.winrate);
  if (winrate == null && candidate.win_rate != null) winrate = parsePercentish(candidate.win_rate);
  if (winrate == null && candidate.winRate != null) winrate = parsePercentish(candidate.winRate);
  if (winrate == null && wins != null && played) winrate = wins / played;

  const out = {
    played: played != null ? played : null,
    wins: wins != null ? wins : null,
    losses: losses != null ? losses : null,
    profit: profit != null ? profit : null,
    roi: roiVal != null ? roiVal : null,
    avg_odds: avgOdds != null ? avgOdds : null,
    winrate: winrate != null ? winrate : null,
  };

  if (sourceLabel) {
    out.source = sourceLabel;
  } else if (typeof candidate.source === "string" && candidate.source) {
    out.source = candidate.source;
  }

  const hasValue = Object.values(out).some((v) => Number.isFinite(v));
  if (!hasValue) return null;

  if (Array.isArray(items) && items.length) {
    const computed = computeROIstats(items);
    if (!isFiniteNumber(out.played)) out.played = computed.played;
    if (!isFiniteNumber(out.wins)) out.wins = computed.wins;
    if (!isFiniteNumber(out.profit)) out.profit = computed.profit;
    if (!isFiniteNumber(out.roi)) out.roi = computed.roi;
    if (!isFiniteNumber(out.avg_odds)) out.avg_odds = computed.avg_odds;
    if (!isFiniteNumber(out.winrate)) out.winrate = computed.winrate;
  } else if (counts) {
    if (!isFiniteNumber(out.played)) out.played = toNumberOrNull(counts.settled ?? counts.decided);
    if (!isFiniteNumber(out.wins)) out.wins = toNumberOrNull(counts.won);
  }

  return out;
}

async function fetchHistoryRoiViaApi(req, ymd, trace) {
  try {
    const host =
      req.headers["x-forwarded-host"] ||
      req.headers.host ||
      (req.headers["x-vercel-forwarded-for"] ? req.headers["x-vercel-forwarded-for"].split(",")[0] : null);
    if (!host) return null;
    const protoHeader = req.headers["x-forwarded-proto"] || "";
    const proto = protoHeader ? protoHeader.split(",")[0] : host.includes("localhost") ? "http" : "https";
    const url = `${proto}://${host}/api/history-roi?ymd=${encodeURIComponent(ymd)}`;
    const r = await fetch(url, { cache: "no-store", headers: { "x-history-proxy": "1" } });
    const j = await r.json().catch(() => null);
    trace && trace.push({ fetch: "history-roi", url, ok: r.ok, status: r.status });
    if (!r.ok || !j?.ok) return null;
    const roi = toRoiObject(j, null, j?.items, "history-roi");
    if (roi) return roi;
    const computed = computeROIstats(j?.items || []);
    return { ...computed, source: "history-roi" };
  } catch (e) {
    trace && trace.push({ fetch: "history-roi", ok: false, error: String(e?.message || e) });
    return null;
  }
}

async function loadDayHistory({ ymd, trace, req }) {
  const histKey = `hist:${ymd}`;
  const { raw: rawHist } = await kvGETraw(histKey, trace);
  const parsedHist = J(rawHist);
  let items = filterAllowed(arrFromAny(parsedHist));
  let source = items.length ? histKey : null;
  let counts = parsedHist && typeof parsedHist === "object" ? parsedHist.counts || null : null;
  let roiCandidate = parsedHist && typeof parsedHist === "object" ? parsedHist.roi || parsedHist.stats?.roi || null : null;

  if (!items.length) {
    const combKey = `vb:day:${ymd}:combined`;
    const { raw: rawComb } = await kvGETraw(combKey, trace);
    const parsedComb = J(rawComb);
    const combArr = arrFromAny(parsedComb);
    items = filterAllowed(combArr);
    source = items.length ? combKey : null;
    if (!counts && parsedComb && typeof parsedComb === "object" && parsedComb.counts) {
      counts = parsedComb.counts;
    }
    if (!roiCandidate && parsedComb && typeof parsedComb === "object" && parsedComb.roi) {
      roiCandidate = parsedComb.roi;
    }
  }

  const itemsWithYmd = ensureItemsHaveYmd(items, ymd);
  let roi = toRoiObject(roiCandidate, counts, itemsWithYmd, roiCandidate ? "history" : null);

  if (!roi) {
    const fallback = await fetchHistoryRoiViaApi(req, ymd, trace);
    if (fallback) {
      roi = fallback;
    }
  }

  if (!roi) {
    const computed = computeROIstats(itemsWithYmd);
    roi = { ...computed, source: "computed" };
  } else {
    const computed = computeROIstats(itemsWithYmd);
    if (!isFiniteNumber(roi.played)) roi.played = computed.played;
    if (!isFiniteNumber(roi.wins)) roi.wins = computed.wins;
    if (!isFiniteNumber(roi.profit)) roi.profit = computed.profit;
    if (!isFiniteNumber(roi.roi)) roi.roi = computed.roi;
    if (!isFiniteNumber(roi.avg_odds)) roi.avg_odds = computed.avg_odds;
    if (!isFiniteNumber(roi.winrate)) roi.winrate = computed.winrate;
  }

  return { ymd, items: itemsWithYmd, source, roi, counts };
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const qYmd = String(req.query.ymd || "").trim();
    const qDays = Number.parseInt(String(req.query.days || "").trim(), 10);
    const ymd = isValidYmd(qYmd) ? qYmd : null;

    if (ymd) {
      const day = await loadDayHistory({ ymd, trace, req });
      return res.status(200).json({
        ok: true,
        ymd,
        count: day.items.length,
        source: day.source,
        history: day.items,
        roi: day.roi,
        counts: day.counts || null,
        debug: { trace, allowed: Array.from(allowSet) },
      });
    }

    const days = Number.isFinite(qDays) ? Math.max(1, Math.min(30, qDays)) : 7;
    const today = new Date();
    const ymds = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const dayYmd = d.toISOString().slice(0, 10);
      ymds.push(dayYmd);
    }

    const combined = [];
    const daily = [];
    for (const dayYmd of ymds) {
      const day = await loadDayHistory({ ymd: dayYmd, trace, req });
      combined.push(...day.items);
      daily.push({
        ymd: day.ymd,
        count: day.items.length,
        source: day.source,
        roi: day.roi,
        counts: day.counts || null,
      });
    }

    const aggregateRoi = computeROIstats(combined);
    aggregateRoi.source = "aggregate";

    return res.status(200).json({
      ok: true,
      mode: "range",
      days,
      range: { latest: ymds[0], earliest: ymds[ymds.length - 1] },
      count: combined.length,
      history: combined,
      roi: aggregateRoi,
      byDay: daily,
      debug: { trace, allowed: Array.from(allowSet) },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
