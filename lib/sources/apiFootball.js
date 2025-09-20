// Safe wrapper for API-FOOTBALL (v3) using the official header.
// Drop-in replacement; izbegava RapidAPI headere koji često daju 403/HTML.
//
// Upotreba:
//   const { afFetch } = require("../../lib/sources/apiFootball");
//   const data = await afFetch("/fixtures", { date: "2025-08-17" });
//
// Env:
//   API_FOOTBALL_KEY (obavezno)
//   API_FOOTBALL_BASE (opciono; default https://v3.football.api-sports.io)

const API_BASE =
  process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
const API_KEY =
  process.env.API_FOOTBALL_KEY ||
  process.env.APIFOOTBALL_KEY ||
  process.env.APISPORTS_KEY ||
  process.env.APISPORTS_API_KEY ||
  process.env.X_APISPORTS_KEY ||
  process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
  "";

function qs(params = {}) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) v.forEach((vv) => u.append(k, vv));
    else u.append(k, v);
  });
  return u.toString();
}

async function afFetch(path, params = {}, init = {}) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY is missing");
  const url = `${API_BASE}${path}${
    Object.keys(params).length ? `?${qs(params)}` : ""
  }`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "x-apisports-key": API_KEY,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text();
    throw new Error(
      `API-FOOTBALL non-JSON response (${res.status}): ${text.slice(0, 180)}`
    );
  }
  const data = await res.json();
  return data;
}

module.exports = {
  afFetch,
  default: { afFetch },
};

// ---------------------------------------------------------------------------
// AFX Budget + Cache wrapper (append-only, safe; ne menja postojeći afFetch)
// ---------------------------------------------------------------------------

// ✓ Bez novih ENV promena (opciono čita API_FOOTBALL_BASE i/ili API_FOOTBALL_BASE_URL)
// ✓ Ako KV nije podešen, radi bez keša i bez budžeta (graceful fallback)
// ✓ Ne koristi RapidAPI header, samo zvanični x-apisports-key

const AFX_DAILY_BUDGET_DEFAULT = 5000; // cilj ~5k/dan
const AFX_TZ = "Europe/Belgrade";
const AFX_API_BASE_DEFAULT = "https://v3.football.api-sports.io";

// Upstash REST ili redis(s)://host -> https://host
function afxToRestBase(s) {
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "");
  const m = s.match(/^rediss?:\/\/(?:[^@]*@)?([^:/?#]+)(?::\d+)?/i);
  if (m) return `https://${m[1]}`;
  return "";
}

const AFX_KV_BASE_RAW =
  (process.env.KV_REST_API_URL || process.env.KV_URL || "").trim();
const AFX_KV_BASE = afxToRestBase(AFX_KV_BASE_RAW);
const AFX_KV_TOKEN_RO = (
  process.env.KV_REST_API_READ_ONLY_TOKEN || process.env.KV_REST_API_TOKEN || ""
).trim();
const AFX_KV_TOKEN_RW = (process.env.KV_REST_API_TOKEN || "").trim();

const AFX_HAS_KV_ANY = !!(AFX_KV_BASE && AFX_KV_TOKEN_RO);
const AFX_HAS_KV_RW = !!(AFX_KV_BASE && AFX_KV_TOKEN_RW);

function afxYmd(date = new Date()) {
  // "sv-SE" daje ISO-like "YYYY-MM-DD HH:MM:SS"
  return date.toLocaleString("sv-SE", { timeZone: AFX_TZ }).slice(0, 10);
}

// ---- KV helpers ----
async function afxKvGet(key) {
  if (!AFX_HAS_KV_ANY) return null;
  try {
    const r = await fetch(`${AFX_KV_BASE}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${AFX_KV_TOKEN_RO}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    let body = null;
    if (ct.includes("application/json")) {
      body = await r.json().catch(() => null);
    } else {
      const text = await r.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (body == null) return null;

    let value;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      if (Object.prototype.hasOwnProperty.call(body, "result")) {
        value = body.result;
      } else if (Object.prototype.hasOwnProperty.call(body, "value")) {
        value = body.value;
      } else {
        value = body;
      }
    } else {
      value = body;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (
        Object.prototype.hasOwnProperty.call(value, "value") &&
        typeof value.value === "string"
      ) {
        const inner = value.value.trim();
        if (!inner) return null;
        try {
          return JSON.parse(inner);
        } catch {
          return value.value;
        }
      }
      return value;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }

    return value ?? null;
  } catch {
    return null;
  }
}

async function afxKvSet(key, value) {
  if (!AFX_HAS_KV_RW) return false;
  try {
    const r = await fetch(`${AFX_KV_BASE}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AFX_KV_TOKEN_RW}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- TTL cache (KV): čuvamo { _v: any, _exp: epoch_ms } ----
async function afxCacheGet(key) {
  const obj = await afxKvGet(key);
  if (!obj || typeof obj !== "object") return null;
  const exp = Number(obj._exp || 0);
  if (exp && Date.now() > exp) return null;
  return "_v" in obj ? obj._v : null;
}

async function afxCacheSet(key, value, ttlSeconds) {
  if (!AFX_HAS_KV_RW) return false;
  const exp = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
  return afxKvSet(key, { _v: value, _exp: exp });
}

// ---- Budget (simple token-bucket po lokalnom danu) ----
function afxBudgetKey(ymd) {
  return `af:budget:${ymd}:remain`;
}
async function afxBudgetInit(ymd) {
  if (!AFX_HAS_KV_RW) return null; // bez KV write: ne pratimo budžet
  const cur = await afxKvGet(afxBudgetKey(ymd));
  if (Number.isFinite(cur)) return cur;
  const start = Number(
    process.env.API_FOOTBALL_DAILY_BUDGET || AFX_DAILY_BUDGET_DEFAULT
  );
  await afxKvSet(afxBudgetKey(ymd), start);
  return start;
}
async function afxBudgetConsume(ymd, n = 1, priority = "P2") {
  // priority: P1 > P2 > P3 > P4
  if (!AFX_HAS_KV_RW) return true;
  const rank = { P1: 3, P2: 2, P3: 1, P4: 0 }[priority] ?? 1;
  const reserveForP1 = 300; // čuvamo malo za P1 kada smo pri dnu
  let remain = await afxBudgetInit(ymd);
  if (!Number.isFinite(remain)) return true;
  if (remain <= 0) return false;
  if (remain <= reserveForP1 && rank < 3) return false;
  remain = Math.max(0, remain - n);
  await afxKvSet(afxBudgetKey(ymd), remain);
  return true;
}

// ---- API-Football fetch (sa kešom i budžetom) ----
function afxApiBase() {
  // Podržimo i API_FOOTBALL_BASE_URL ako postoji, ali ne diramo afFetch gore.
  const base =
    process.env.API_FOOTBALL_BASE ||
    process.env.API_FOOTBALL_BASE_URL ||
    AFX_API_BASE_DEFAULT;
  return String(base).replace(/\/+$/, "");
}

/**
 * Glavni wrapper:
 *  - path npr. "/odds?fixture=123"
 *  - cacheKey (opciono); ako nema, koristi path
 *  - ttlSeconds: 0 = bez keša
 *  - priority: 'P1'..'P4' (P1 najvažnije)
 *  - skipOnNoBudget: true => vrati null kad nema budžeta
 */
async function afxGetJson(
  path,
  { cacheKey, ttlSeconds = 0, priority = "P2", skipOnNoBudget = true, headers = {} } = {}
) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY is missing");
  const ymd = afxYmd();
  const key = cacheKey || `af:cache:${path}`;

  // 1) Keš
  if (ttlSeconds > 0) {
    const hit = await afxCacheGet(key);
    if (hit !== null && hit !== undefined) return hit;
  }

  // 2) Budžet
  const allowed = await afxBudgetConsume(ymd, 1, priority);
  if (!allowed && skipOnNoBudget) return null;

  // 3) Poziv
  const BASE = afxApiBase();
  const url = `${BASE}${path}`;
  const H = {
    "x-apisports-key": API_KEY,
    Accept: "application/json",
    ...headers,
  };
  const resp = await fetch(url, { headers: H, cache: "no-store" });
  const ct = resp.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await resp.text();
    throw new Error(
      `API-FOOTBALL non-JSON response (${resp.status}): ${text.slice(0, 180)}`
    );
  }
  const json = await resp.json();

  // 4) Upis u keš
  if (ttlSeconds > 0 && json !== null) {
    await afxCacheSet(key, json, ttlSeconds);
  }
  return json;
}

// ---- Praktični helper-i (za sledeće korake; niko ih još ne zove) ----
async function afxOddsByFixture(
  fixtureId,
  { cacheKey, ttlSeconds = 0, priority = "P2", skipOnNoBudget = true, headers } = {}
) {
  if (!fixtureId) return null;
  const path = `/odds?fixture=${encodeURIComponent(fixtureId)}`;
  return afxGetJson(path, {
    cacheKey: cacheKey || `af:odds:fixture:${fixtureId}:snap`,
    ttlSeconds,
    priority,
    skipOnNoBudget,
    headers,
  });
}

async function afxFixturesByDate(
  ymd,
  {
    cacheKey,
    ttlSeconds = 2 * 3600,
    priority = "P2",
    skipOnNoBudget = true,
    headers,
    timezone,
  } = {}
) {
  if (!ymd) return null;
  const tz = timezone ? `&timezone=${encodeURIComponent(timezone)}` : "";
  const path = `/fixtures?date=${encodeURIComponent(ymd)}${tz}`;
  return afxGetJson(path, {
    cacheKey: cacheKey || `af:fixtures:${ymd}${timezone ? `:${timezone}` : ""}`,
    ttlSeconds,
    priority,
    skipOnNoBudget,
    headers,
  });
}

async function afxTeamStats(
  leagueId,
  teamId,
  season,
  {
    cacheKey,
    ttlSeconds = 3 * 24 * 3600,
    priority = "P3",
    skipOnNoBudget = true,
    headers,
  } = {}
) {
  if (!leagueId || !teamId || !season) return null;
  const path = `/teams/statistics?league=${encodeURIComponent(
    leagueId
  )}&team=${encodeURIComponent(teamId)}&season=${encodeURIComponent(season)}`;
  return afxGetJson(path, {
    cacheKey:
      cacheKey || `af:stats:team:${teamId}:lg:${leagueId}:ssn:${season}`,
    ttlSeconds,
    priority,
    skipOnNoBudget,
    headers,
  });
}

async function afxInjuries(
  teamId,
  { cacheKey, ttlSeconds = 24 * 3600, priority = "P1", skipOnNoBudget = true, headers } = {}
) {
  if (!teamId) return null;
  const ymd = afxYmd();
  const path = `/injuries?team=${encodeURIComponent(teamId)}`;
  return afxGetJson(path, {
    cacheKey: cacheKey || `af:inj:team:${teamId}:${ymd}`,
    ttlSeconds,
    priority,
    skipOnNoBudget,
    headers,
  });
}

async function afxH2H(
  homeId,
  awayId,
  last = 10,
  { cacheKey, ttlSeconds = 7 * 24 * 3600, priority = "P3", skipOnNoBudget = true, headers } = {}
) {
  if (!homeId || !awayId) return null;
  const path = `/fixtures/headtohead?h2h=${encodeURIComponent(
    homeId
  )}-${encodeURIComponent(awayId)}&last=${encodeURIComponent(last)}`;
  return afxGetJson(path, {
    cacheKey: cacheKey || `af:h2h:${homeId}-${awayId}:last:${last}`,
    ttlSeconds,
    priority,
    skipOnNoBudget,
    headers,
  });
}

async function afxLineups(
  fixtureId,
  { cacheKey, ttlSeconds = 2 * 3600, priority = "P1", skipOnNoBudget = true, headers } = {}
) {
  if (!fixtureId) return null;
  const ymd = afxYmd();
  const path = `/fixtures/lineups?fixture=${encodeURIComponent(fixtureId)}`;
  return afxGetJson(path, {
    cacheKey: cacheKey || `af:lineups:${fixtureId}:${ymd}`,
    ttlSeconds,
    priority,
    skipOnNoBudget,
    headers,
  });
}

// (opciono) čitanje budžeta za debug rutu/panel
async function afxReadBudget() {
  if (!AFX_HAS_KV_ANY) return null;
  return afxKvGet(afxBudgetKey(afxYmd()));
}

// ---- Exports (zadržavamo postojeći default) ----
module.exports.afxGetJson = afxGetJson;
module.exports.afxOddsByFixture = afxOddsByFixture;
module.exports.afxFixturesByDate = afxFixturesByDate;
module.exports.afxTeamStats = afxTeamStats;
module.exports.afxInjuries = afxInjuries;
module.exports.afxH2H = afxH2H;
module.exports.afxLineups = afxLineups;
module.exports.afxReadBudget = afxReadBudget;
module.exports.afxCacheGet = afxCacheGet;
module.exports.afxCacheSet = afxCacheSet;
module.exports.afxBudgetConsume = afxBudgetConsume;
module.exports.afxYmd = afxYmd;
