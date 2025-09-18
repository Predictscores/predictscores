import apiFootball from "./apiFootball";

const {
  afxCacheGet,
  afxCacheSet,
  afxBudgetConsume,
  afxYmd,
} = apiFootball || {};

const DEFAULT_TTL_SECONDS = 10 * 60;
const DAILY_LIMIT_RAW = Number(process.env.ODDS_API_DAILY_LIMIT);
const DEFAULT_DAILY_LIMIT =
  Number.isFinite(DAILY_LIMIT_RAW) && DAILY_LIMIT_RAW > 0
    ? DAILY_LIMIT_RAW
    : 15;
const API_FOOTBALL_BUDGET_POOL_RAW = Number(
  process.env.API_FOOTBALL_DAILY_BUDGET
);
const API_FOOTBALL_BUDGET_POOL =
  Number.isFinite(API_FOOTBALL_BUDGET_POOL_RAW) && API_FOOTBALL_BUDGET_POOL_RAW > 0
    ? API_FOOTBALL_BUDGET_POOL_RAW
    : 5000;
const BUDGET_COST = Math.max(
  1,
  Math.ceil(API_FOOTBALL_BUDGET_POOL / DEFAULT_DAILY_LIMIT)
);
const BUDGET_PRIORITY = "P2";

function buildCacheKey(sportKey, regions, markets) {
  return `oddsapi:snap:${sportKey}:${regions}:${markets}`;
}

function resolveYmd() {
  if (typeof afxYmd === "function") return `odds:${afxYmd()}`;
  return `odds:${new Date().toISOString().slice(0, 10)}`;
}

async function maybeReadCache(cacheKey, ttlSeconds) {
  if (!cacheKey || ttlSeconds <= 0) return null;
  if (typeof afxCacheGet !== "function") return null;
  try {
    return await afxCacheGet(cacheKey);
  } catch {
    return null;
  }
}

async function maybeWriteCache(cacheKey, ttlSeconds, payload) {
  if (!cacheKey || ttlSeconds <= 0) return false;
  if (typeof afxCacheSet !== "function") return false;
  try {
    await afxCacheSet(cacheKey, payload, ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

async function consumeBudget(budgetKey, budgetCost) {
  if (typeof afxBudgetConsume !== "function") return { allowed: true };
  try {
    const allowed = await afxBudgetConsume(budgetKey, budgetCost, BUDGET_PRIORITY);
    return { allowed };
  } catch (err) {
    // On KV errors allow the request to continue but surface diagnostic info.
    return { allowed: true, error: err };
  }
}

export async function fetchOddsSnapshot(
  sportKey,
  {
    regions = "eu",
    markets = "h2h",
    ttlSeconds = DEFAULT_TTL_SECONDS,
    fetcher = fetch,
  } = {}
) {
  if (!sportKey) {
    throw new Error("fetchOddsSnapshot requires a sportKey");
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ODDS_API_KEY env var");
  }

  const cacheKey = buildCacheKey(sportKey, regions, markets);
  const cacheHit = await maybeReadCache(cacheKey, ttlSeconds);
  if (cacheHit) {
    return {
      data: cacheHit,
      fromCache: true,
      exhausted: false,
      cacheKey,
    };
  }

  const budgetKey = resolveYmd();
  const { allowed } = await consumeBudget(budgetKey, BUDGET_COST);
  if (!allowed) {
    return {
      data: null,
      fromCache: false,
      exhausted: true,
      cacheKey,
      budgetKey,
    };
  }

  const url = new URL(
    `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(
      sportKey
    )}/odds`
  );
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", markets);
  url.searchParams.set("dateFormat", "iso");
  url.searchParams.set("oddsFormat", "decimal");

  let responseText = "";
  try {
    const res = await fetcher(url.toString(), { cache: "no-store" });
    responseText = await res.text();
    if (!res.ok) {
      throw new Error(
        `Odds API fetch failed ${res.status}: ${responseText.slice(0, 240)}`
      );
    }
    const payload = responseText ? JSON.parse(responseText) : null;
    await maybeWriteCache(cacheKey, ttlSeconds, payload);
    return {
      data: payload,
      fromCache: false,
      exhausted: false,
      cacheKey,
      budgetKey,
    };
  } catch (err) {
    const error = new Error(
      `fetchOddsSnapshot error: ${err.message || err} url: ${url.toString()}`
    );
    error.cause = err;
    error.body = responseText;
    throw error;
  }
}

export default {
  fetchOddsSnapshot,
};
