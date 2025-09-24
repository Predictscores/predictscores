// pages/api/cron/apply-learning.js
// Settling i history SAMO nad vb:day:<YMD>:combined (Top 3).
// Ako combined nedostaje ili je prazan, SAM pokreće /api/cron/rebuild (koji po potrebi poziva /api/score-sync).
// Podrazumevani YMD je Europe/Belgrade. Presuđuje 1X2, OU, BTTS, HT-FT.
import { afxGetJson } from "../../../lib/sources/apiFootball";

function kvEnv() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_URL ||
    "";
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_READ_ONLY_TOKEN ||
    "";
  return { url, token };
}
async function kvPipeline(cmds) {
  const { url, token } = kvEnv();
  if (!url || !token) throw new Error("KV env not set (URL/TOKEN).");
  const r = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    cache: "no-store",
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`KV pipeline HTTP ${r.status}: ${t}`); }
  return r.json();
}
async function kvGet(key) { const out = await kvPipeline([["GET", key]]); return out?.[0]?.result ?? null; }
async function kvSet(key, val) { const out = await kvPipeline([["SET", key, val]]); return out?.[0]?.result ?? "OK"; }
async function kvGetJSON(key) {
  const raw = await kvGet(key);
  if (raw == null) return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try { return JSON.parse(s); } catch { return raw; }
    }
    return raw;
  }
  return raw;
}
async function kvSetJSON(key, obj) { return kvSet(key, JSON.stringify(obj)); }

function kvBackends() {
  const out = [];
  const vercelUrlRaw = process.env.KV_REST_API_URL || process.env.KV_URL;
  const vercelTok = process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN;
  const upstashUrlRaw = process.env.UPSTASH_REDIS_REST_URL;
  const upstashTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (vercelUrlRaw && vercelTok) out.push({ flavor: "vercel-kv", url: vercelUrlRaw.replace(/\/+$/, ""), token: vercelTok });
  if (upstashUrlRaw && upstashTok) out.push({ flavor: "upstash-redis", url: upstashUrlRaw.replace(/\/+$/, ""), token: upstashTok });
  if (!out.length) {
    const { url, token } = kvEnv();
    if (url && token) out.push({ flavor: "default", url: url.replace(/\/+$/, ""), token });
  }
  return out;
}
function safeJsonParse(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function extractArray(payload) {
  if (payload == null) return [];
  const preferredKeys = [
    "items",
    "value_bets",
    "valueBets",
    "value-bets",
    "valuebets",
    "bets",
    "entries",
    "picks",
    "list",
    "data",
    "normalized",
    "alias",
    "alias_combined",
    "result",
    "models",
  ];
  const visited = new Set();
  const queue = [{ node: payload, depth: 0 }];
  const found = [];
  const maxDepth = 6;

  while (queue.length) {
    const { node, depth } = queue.shift();
    if (node == null || depth > maxDepth) continue;
    if (typeof node === "string") {
      const parsed = safeJsonParse(node);
      if (typeof parsed !== "undefined") {
        queue.push({ node: parsed, depth: depth + 1 });
      }
      continue;
    }
    if (typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);

    if (Array.isArray(node)) {
      found.push(node);
      for (const part of node) {
        if (part && typeof part === "object") {
          queue.push({ node: part, depth: depth + 1 });
        } else if (typeof part === "string") {
          const parsed = safeJsonParse(part);
          if (typeof parsed !== "undefined") {
            queue.push({ node: parsed, depth: depth + 1 });
          }
        }
      }
      continue;
    }

    const keys = Object.keys(node);
    const numericKeys = keys.filter((k) => /^\d+$/.test(k));
    if (numericKeys.length && numericKeys.length === keys.length) {
      const arr = numericKeys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => node[k]);
      found.push(arr);
      queue.push({ node: arr, depth: depth + 1 });
      continue;
    }

    const prioritized = [];
    const seen = new Set();
    for (const key of preferredKeys) {
      if (key in node) {
        prioritized.push(key);
        seen.add(key);
      }
    }
    for (const key of keys) {
      if (!seen.has(key)) prioritized.push(key);
    }

    for (const key of prioritized) {
      const value = node[key];
      if (value == null) continue;
      if (Array.isArray(value)) {
        found.push(value);
        queue.push({ node: value, depth: depth + 1 });
      } else if (typeof value === "object") {
        queue.push({ node: value, depth: depth + 1 });
      } else if (typeof value === "string") {
        const parsed = safeJsonParse(value);
        if (typeof parsed !== "undefined") {
          queue.push({ node: parsed, depth: depth + 1 });
        }
      }
    }
  }

  let best = null;
  let bestScore = -1;
  for (const arr of found) {
    if (!Array.isArray(arr)) continue;
    const objects = arr.filter((it) => it && typeof it === "object");
    const score = objects.length;
    if (score > bestScore) {
      bestScore = score;
      best = arr;
    }
  }

  return Array.isArray(best) ? best : [];
}
async function kvGetJSONFromBackend(key, backend) {
  try {
    const url = `${backend.url}/get/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${backend.token}` }, cache: "no-store" });
    if (!res.ok) return { key, flavor: backend.flavor, value: null, items: [], count: 0 };
    const json = await res.json().catch(() => null);
    let value = json?.result ?? json?.value ?? null;
    if (value == null) return { key, flavor: backend.flavor, value: null, items: [], count: 0 };
    const parsed = safeJsonParse(value);
    if (typeof parsed !== "undefined") value = parsed;
    const items = extractArray(value);
    return { key, flavor: backend.flavor, value, items, count: Array.isArray(items) ? items.length : 0 };
  } catch (err) {
    return { key, flavor: backend.flavor, value: null, items: [], count: 0, error: String(err?.message || err) };
  }
}

function ymdInTZ(tz = "Europe/Belgrade", d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const dd = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${dd}`;
}

/* ---------- ranking / combined helpers ---------- */

function fixtureKeyForDedupe(it) {
  if (!it || typeof it !== "object") return null;
  const model = it.model && typeof it.model === "object" ? it.model : null;
  const fixtureId = coerceFixtureId(
    model?.fixture,
    model?.fixture_id,
    model?.fixtureId,
    it.fixture_id,
    it.fixture,
    it.fixtureId,
    it?.fixture?.id,
    it.id,
    it.match_id,
    it.matchId
  );
  if (fixtureId == null) return null;
  return String(fixtureId);
}

function dedupeBySignature(items = []) {
  const out = [];
  const seen = new Set();
  let fallback = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    const key = fixtureKeyForDedupe(it);
    const sig = key != null ? key : `__auto_${fallback++}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(it);
  }
  return out;
}

function normalizeMarketLabel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^h2h$/i.test(raw)) return "1X2";
  if (/^1x2$/i.test(raw)) return "1X2";
  if (/^match\s*(winner|odds)$/i.test(raw)) return "1X2";
  if (/^moneyline$/i.test(raw)) return "1X2";
  return raw;
}

function normalizeValueBetEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const normalized = { ...entry };
  const fixtureId = coerceFixtureId(
    entry.fixture_id,
    entry.fixture,
    entry.fixtureId,
    entry?.fixture?.id,
    entry.id,
    entry.match_id,
    entry.matchId,
    entry.model?.fixture,
    entry.model?.fixture_id,
    entry.model?.fixtureId
  );
  if (fixtureId != null) {
    normalized.fixture_id = fixtureId;
    if (normalized.fixtureId == null) normalized.fixtureId = fixtureId;
    if (normalized.fixture == null || typeof normalized.fixture !== "object") normalized.fixture = fixtureId;
    if (typeof normalized.fixture === "object" && normalized.fixture && normalized.fixture.id == null) {
      normalized.fixture.id = fixtureId;
    }
    if (normalized.id == null) normalized.id = fixtureId;
  }

  const modelBase = entry.model && typeof entry.model === "object" ? { ...entry.model } : {};
  if (fixtureId != null && modelBase.fixture == null) modelBase.fixture = fixtureId;

  const marketCandidates = [
    entry.market_label,
    entry.market,
    entry.market_key,
    entry.marketName,
    entry.marketname,
  ];
  let market = "";
  for (const candidate of marketCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      market = normalizeMarketLabel(candidate);
      if (market) break;
    }
  }
  if (!market) market = "1X2";
  normalized.market = market;
  if (!normalized.market_label) normalized.market_label = market;
  if (!normalized.market_key) normalized.market_key = market.toLowerCase();

  const selectionCandidates = [
    entry.selection,
    entry.selection_label,
    entry.pick,
    entry.pick_code,
    entry.predicted,
    modelBase.predicted,
  ];
  let rawSelection = null;
  for (const candidate of selectionCandidates) {
    if (candidate != null && String(candidate).trim() !== "") {
      rawSelection = candidate;
      break;
    }
  }
  let normalizedSelection = rawSelection;
  let selectionLabel = rawSelection != null ? String(rawSelection).trim() : "";
  if (market === "1X2") {
    const mapped = normalizeModelSelection(rawSelection);
    if (mapped) {
      normalizedSelection = mapped;
      selectionLabel =
        mapped === "home"
          ? "HOME"
          : mapped === "away"
          ? "AWAY"
          : mapped === "draw"
          ? "DRAW"
          : selectionLabel.toUpperCase();
    }
    if (!normalized.predicted && mapped) normalized.predicted = mapped;
  }
  if (normalizedSelection != null && normalized.selection == null) normalized.selection = normalizedSelection;
  if (selectionLabel && !normalized.selection_label) normalized.selection_label = selectionLabel;
  if (selectionLabel && !normalized.pick) normalized.pick = selectionLabel;

  const probabilityCandidates = [
    entry.model_prob,
    entry.modelProbability,
    entry.model_prob_pct,
    entry.prob,
    entry.probability,
    modelBase.model_prob,
    modelBase.prob,
    modelBase.probability,
    modelBase.model_probability,
  ];
  let prob = null;
  for (const candidate of probabilityCandidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) {
      prob = num;
      break;
    }
  }
  if (prob == null && market === "1X2" && entry.model_probs && typeof entry.model_probs === "object") {
    const key = normalizedSelection === "home" ? "home" : normalizedSelection === "away" ? "away" : normalizedSelection === "draw" ? "draw" : null;
    if (key && entry.model_probs[key] != null) {
      const num = Number(entry.model_probs[key]);
      if (Number.isFinite(num)) prob = num;
    }
  }
  if (prob != null) {
    normalized.model_prob = prob;
    if (normalized.prob == null) normalized.prob = prob;
    if (modelBase.model_prob == null) modelBase.model_prob = prob;
  }

  if (Object.keys(modelBase).length) normalized.model = modelBase;

  return normalized;
}

function normalizeModelSelection(value) {
  if (value == null) return "";
  const raw = String(value).trim().toLowerCase();
  if (!raw) return "";
  if (raw === "1" || raw === "home" || raw === "h" || raw.includes("home")) return "home";
  if (raw === "2" || raw === "away" || raw === "a" || raw.includes("away")) return "away";
  if (raw === "x" || raw === "draw" || raw === "d" || raw === "tie" || raw.includes("draw") || raw.includes("tie")) return "draw";
  return raw;
}

function extractModelContainer(entry) {
  if (entry && typeof entry === "object" && entry.model && typeof entry.model === "object") {
    return entry.model;
  }
  return entry;
}

function extractModelRawSelection(entry, model = extractModelContainer(entry)) {
  if (!entry || typeof entry !== "object") return null;
  const candidates = [
    model?.predicted,
    entry?.predicted,
    model?.prediction,
    entry?.prediction,
    model?.pick,
    entry?.pick,
    model?.selection,
    entry?.selection,
    model?.side,
    entry?.side,
    model?.model_pick,
    entry?.model_pick,
    model?.modelPick,
    entry?.modelPick,
    model?.model_pred,
    entry?.model_pred,
    model?.modelPred,
    entry?.modelPred,
    model?.model_prediction,
    entry?.model_prediction,
    model?.modelPrediction,
    entry?.modelPrediction,
  ];
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  return null;
}

function coerceFixtureId(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const asNumber = Number(trimmed);
      if (!Number.isNaN(asNumber)) return asNumber;
      return trimmed;
    }
    if (typeof value === "object") {
      const nested = coerceFixtureId(
        value.fixture_id,
        value.fixtureId,
        value.fixture,
        value.id,
        value.match_id,
        value.matchId
      );
      if (nested != null) return nested;
    }
  }
  return null;
}

function normalizeModelEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const model = extractModelContainer(entry);
  const fixtureId = coerceFixtureId(
    entry.fixture_id,
    entry.fixtureId,
    entry.fixture,
    entry.id,
    entry.match_id,
    entry.matchId,
    model.fixture_id,
    model.fixtureId,
    model.fixture,
    model.id
  );
  if (fixtureId == null) return null;

  const rawSelection = extractModelRawSelection(entry, model);
  const normalizedSelection = normalizeModelSelection(rawSelection);
  if (!normalizedSelection || !["home", "away", "draw"].includes(normalizedSelection)) return null;

  const probRaw =
    model.model_prob ??
    model.modelProbability ??
    model.prob ??
    model.probability ??
    entry.model_prob ??
    entry.prob ??
    entry.probability;
  const probNum = Number(probRaw);
  const hasProb = Number.isFinite(probNum);

  const displayLabel =
    normalizedSelection === "home"
      ? "HOME"
      : normalizedSelection === "away"
      ? "AWAY"
      : "DRAW";

  const normalized = {
    ...entry,
    fixture_id: fixtureId,
    fixtureId,
    market: "1X2",
    market_label: "1X2",
    market_key: "1x2",
    selection: normalizedSelection,
    selection_label: displayLabel,
    pick: displayLabel,
    predicted: normalizedSelection,
  };
  if (normalized.id == null) normalized.id = fixtureId;
  if (hasProb) {
    normalized.prob = probNum;
    normalized.model_prob = probNum;
  } else {
    delete normalized.prob;
    delete normalized.model_prob;
  }

  const modelClone = typeof entry.model === "object" && entry.model ? { ...entry.model } : {};
  if (modelClone && typeof modelClone === "object") {
    if (modelClone.fixture == null) modelClone.fixture = fixtureId;
    if (modelClone.predicted == null) modelClone.predicted = normalizedSelection;
    if (hasProb && modelClone.model_prob == null) modelClone.model_prob = probNum;
  }
  normalized.model = Object.keys(modelClone).length
    ? modelClone
    : {
        fixture: fixtureId,
        predicted: normalizedSelection,
        ...(hasProb ? { model_prob: probNum } : {}),
      };

  return normalized;
}

function looksLikeValueBetItem(it) {
  if (!it || typeof it !== "object") return false;
  const fixture = it.fixture_id ?? it.id ?? it.fixtureId ?? it?.fixture?.id ?? null;
  const selection = it.pick ?? it.selection ?? it.selection_label ?? it.pick_code ?? null;
  if (fixture == null) return false;
  if (selection == null) return false;
  return String(selection).trim() !== "";
}

function looksLikeModelCandidate(it) {
  if (!it || typeof it !== "object") return false;
  const model = extractModelContainer(it);
  const fixture = coerceFixtureId(
    it.fixture_id,
    it.fixtureId,
    it.fixture,
    it.id,
    it.match_id,
    it.matchId,
    model.fixture_id,
    model.fixtureId,
    model.fixture,
    model.id
  );
  if (fixture == null) return false;
  const selection = normalizeModelSelection(extractModelRawSelection(it, model));
  return String(selection || "").trim() !== "";
}

function parseCombinedPayload(raw) {
  const extracted = extractArray(raw);
  const queue = Array.isArray(extracted) ? [...extracted] : [];
  const objects = [];

  while (queue.length) {
    const item = queue.shift();
    if (item == null) continue;
    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }
    if (typeof item === "string") {
      const parsed = safeJsonParse(item);
      if (parsed && typeof parsed === "object") {
        queue.push(parsed);
      }
      continue;
    }
    if (typeof item === "object") {
      objects.push(item);
    }
  }

  if (!objects.length && raw && typeof raw === "object") {
    objects.push(raw);
  }

  const meaningful = objects.filter((it) => looksLikeValueBetItem(it) || looksLikeModelCandidate(it));
  const inputCount = meaningful.length;
  const normalized = [];
  let valueShape = 0;
  let modelShape = 0;

  for (const candidate of meaningful) {
    if (looksLikeValueBetItem(candidate)) {
      const normalizedValue = normalizeValueBetEntry(candidate);
      if (normalizedValue) {
        normalized.push(normalizedValue);
        valueShape += 1;
        continue;
      }
    }
    if (looksLikeModelCandidate(candidate)) {
      const normalizedModel = normalizeModelEntry(candidate);
      if (normalizedModel) {
        normalized.push(normalizedModel);
        modelShape += 1;
      }
    }
  }

  let shape = "value_bets";
  if (modelShape && !valueShape) shape = "model";
  else if (modelShape && valueShape) shape = modelShape >= valueShape ? "model" : "value_bets";

  if (!normalized.length) {
    const hasModelCandidates = meaningful.some(looksLikeModelCandidate);
    if (hasModelCandidates) shape = "model";
  }

  return { shape, inputCount, normalized };
}
function rankOf(it) {
  const c = Number(it?.confidence_pct);
  const p = Number(it?.model_prob);
  const evlb = Number(it?._ev_lb);
  const ev = Number(it?._ev);
  return [
    - (Number.isFinite(c) ? c : -1),
    - (Number.isFinite(p) ? p : -1),
    - (Number.isFinite(evlb) ? evlb : -1),
    - (Number.isFinite(ev) ? ev : -1),
  ];
}
function top3Combined(items) {
  const byRank = [...items].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  const out = []; const seenFixtures = new Set();
  for (const it of byRank) {
    const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? it?.fixture?.id ?? null;
    if (fid != null && seenFixtures.has(fid)) continue;
    out.push(it);
    if (fid != null) seenFixtures.add(fid);
    if (out.length >= 3) break;
  }
  return out;
}

/* ---------- settle rules ---------- */

function parseOUThreshold(it) {
  const s = (it.selection_label || it.pick || it.selection || it.pick_code || "").toString().toUpperCase();
  const m = s.match(/(O|U|OVER|UNDER)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m) return parseFloat(m[2]);
  const m2 = String(it.market || it.market_label || "").match(/OU\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m2) return parseFloat(m2[1]);
  return 2.5;
}
function pickSide(it) {
  const p = (it.selection_label || it.pick || it.selection || it.pick_code || "").toString().toUpperCase();
  if (p.startsWith("O") || p.startsWith("OVER")) return "OVER";
  if (p.startsWith("U") || p.startsWith("UNDER")) return "UNDER";
  if (p.includes("YES")) return "YES";
  if (p.includes("NO")) return "NO";
  if (p === "1" || p.includes("HOME")) return "HOME";
  if (p === "2" || p.includes("AWAY")) return "AWAY";
  if (p === "X" || p.includes("DRAW")) return "DRAW";
  if (p.includes("/")) return p; // HT/FT
  return p;
}
function winnerFromScore(h, a) { if (h > a) return "HOME"; if (a > h) return "AWAY"; return "DRAW"; }
function decideOutcomeFromFinals(it, finals) {
  if (!finals || typeof finals !== "object") return "PENDING";
  const market = (it.market || it.market_label || "").toUpperCase();
  const side = pickSide(it);
  const ftH = Number(finals.ft_home ?? finals.home ?? NaN);
  const ftA = Number(finals.ft_away ?? finals.away ?? NaN);
  const htH = Number(finals.ht_home ?? NaN);
  const htA = Number(finals.ht_away ?? NaN);
  const ftWinner = winnerFromScore(ftH, ftA);
  const htWinner = Number.isFinite(htH) && Number.isFinite(htA) ? winnerFromScore(htH, htA) : null;

  if (!Number.isFinite(ftH) || !Number.isFinite(ftA)) return "PENDING";

  if (market.includes("1X2") || market === "1X2") {
    if (side === "HOME") return ftWinner === "HOME" ? "WIN" : "LOSE";
    if (side === "DRAW") return ftWinner === "DRAW" ? "WIN" : "LOSE";
    if (side === "AWAY") return ftWinner === "AWAY" ? "WIN" : "LOSE";
  }
  if (market.includes("OU") || market.includes("OVER/UNDER") || market.includes("OVER") || market.includes("UNDER")) {
    const total = ftH + ftA; const thr = parseOUThreshold(it);
    if (side === "OVER") return total > thr ? "WIN" : "LOSE";
    if (side === "UNDER") return total < thr ? "WIN" : "LOSE";
  }
  if (market.includes("BTTS") || market.includes("BOTH") || market.includes("GG/NG")) {
    const btts = ftH > 0 && ftA > 0;
    if (side === "YES") return btts ? "WIN" : "LOSE";
    if (side === "NO") return btts ? "LOSE" : "WIN";
  }
  if (market.includes("HT-FT") || market.includes("HT/FT")) {
    if (htWinner == null) return "PENDING";
    const parts = side.split("/").map((s) => s.trim());
    if (parts.length === 2) {
      const [htPick, ftPick] = parts;
      const okHT =
        htPick === "HOME" ? htWinner === "HOME" :
        htPick === "AWAY" ? htWinner === "AWAY" :
        htPick === "DRAW" ? htWinner === "DRAW" : false;
      const okFT =
        ftPick === "HOME" ? ftWinner === "HOME" :
        ftPick === "AWAY" ? ftWinner === "AWAY" :
        ftPick === "DRAW" ? ftWinner === "DRAW" : false;
      return okHT && okFT ? "WIN" : "LOSE";
    }
  }
  return "PENDING";
}

function normalizeName(s) { return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\s+/g," ").trim(); }
function makePairKey(home, away) { return `${normalizeName(home)}|${normalizeName(away)}`; }

async function fetchFixturesByIds(ids) {
  if (!ids || !ids.length) return {};
  const path = `/fixtures?ids=${ids.join(",")}`;
  const j = await afxGetJson(path, { priority: "P1" });
  if (!j) return {};
  const map = {};
  for (const row of j?.response || []) {
    const fid = row?.fixture?.id;
    const ftH = row?.goals?.home, ftA = row?.goals?.away;
    const htH = row?.score?.halftime?.home, htA = row?.score?.halftime?.away;
    const status = row?.fixture?.status?.short;
    if (fid != null) {
      map[fid] = {
        ft_home: ftH, ft_away: ftA, ht_home: htH, ht_away: htA,
        status, winner: winnerFromScore(Number(ftH), Number(ftA)),
        home_name: row?.teams?.home?.name, away_name: row?.teams?.away?.name,
        provider: "api-football(ids)",
      };
    }
  }
  return map;
}
async function fetchFixturesByDate(ymd) {
  if (!ymd) return {};
  const path = `/fixtures?date=${ymd}&timezone=UTC`;
  const j = await afxGetJson(path, { priority: "P1" });
  if (!j) return {};
  const byPair = {};
  for (const row of j?.response || []) {
    const home = row?.teams?.home?.name, away = row?.teams?.away?.name;
    const keyPair = makePairKey(home, away);
    const ftH = row?.goals?.home, ftA = row?.goals?.away;
    const htH = row?.score?.halftime?.home, htA = row?.score?.halftime?.away;
    const status = row?.fixture?.status?.short;
    byPair[keyPair] = {
      ft_home: ftH, ft_away: ftA, ht_home: htH, ht_away: htA,
      status, winner: winnerFromScore(Number(ftH), Number(ftA)),
      home_name: home, away_name: away, fixture_id: row?.fixture?.id,
      provider: "api-football(date)",
    };
  }
  return byPair;
}
function ymdShift(ymd, deltaDays) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0,10);
}
async function ensureFinalsFor(ymd, items) {
  const fids = Array.from(new Set(items.map(it => it.fixture_id ?? it.id ?? it.fixtureId).filter(x => x != null)));
  const byId = await fetchFixturesByIds(fids);
  const byPair = {};
  if (Object.keys(byId).length < Math.ceil(fids.length * 0.6)) {
    for (const dd of [0, -1, 1]) {
      const add = await fetchFixturesByDate(dd === 0 ? ymd : ymdShift(ymd, dd));
      Object.assign(byPair, add);
    }
  }
  return { byId, byPair };
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const tzYmd = ymdInTZ("Europe/Belgrade");
    const ymd = url.searchParams.get("ymd") || tzYmd;
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const base = `${proto}://${req.headers.host}`;
    const debug = url.searchParams.get("debug") === "1";
    const days = ymd ? 1 : Math.max(1, Math.min(14, parseInt(url.searchParams.get("days") || "1", 10)));

    const ymds = ymd ? [ymd] : Array.from({ length: days }, (_, i) => {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
      return ymdInTZ("Europe/Belgrade", d);
    });

    const reports = [];
    const kvFlavors = kvBackends();

    for (const theDay of ymds) {
      const dayOptions = [
        { label: "combined", key: `vb:day:${theDay}:combined` },
        { label: "union", key: `vb:day:${theDay}:union` },
        { label: "last", key: `vb:day:${theDay}:last` },
      ];
      const slotOptions = [
        { label: "slot:am", slot: "am", key: `vb:day:${theDay}:am` },
        { label: "slot:pm", slot: "pm", key: `vb:day:${theDay}:pm` },
        { label: "slot:late", slot: "late", key: `vb:day:${theDay}:late` },
      ];
      const tried = [...dayOptions.map((opt) => opt.label), ...slotOptions.map((opt) => opt.label)];
      const triedKeys = [];
      let slotTried = [];
      const hasNormalized = (payload) => Array.isArray(payload?.normalized) && payload.normalized.length > 0;
      const loadSource = async (key) => {
        if (!kvFlavors.length) {
          triedKeys.push(`${key}@none`);
          const fallbackRaw = await kvGetJSON(key);
          return { parsed: parseCombinedPayload(fallbackRaw), flavor: null };
        }
        let chosenValue = null;
        let chosenFlavor = null;
        let fallbackValue = null;
        let fallbackFlavor = null;
        for (const backend of kvFlavors) {
          const attempt = await kvGetJSONFromBackend(key, backend);
          triedKeys.push(`${key}@${backend.flavor}`);
          if (attempt.count > 0 && chosenValue == null) {
            chosenValue = attempt.value;
            chosenFlavor = backend.flavor;
          }
          if (fallbackValue == null && attempt.value != null) {
            fallbackValue = attempt.value;
            fallbackFlavor = backend.flavor;
          }
        }
        const value = chosenValue ?? fallbackValue ?? null;
        const flavor = chosenValue != null ? chosenFlavor : fallbackValue != null ? fallbackFlavor : null;
        return { parsed: parseCombinedPayload(value), flavor };
      };

      const combinedOption = dayOptions[0];
      const fetchCombined = async () => loadSource(combinedOption.key);

      let combinedResult = await fetchCombined();
      let parsed = combinedResult.parsed;
      let flavorPicked = combinedResult.flavor;
      if (!hasNormalized(parsed)) {
        // 1a) probaj rebuild (on po potrebi zove score-sync)
        await fetch(`${base}/api/cron/rebuild?ymd=${encodeURIComponent(theDay)}`, { cache: "no-store" })
          .then(r => r.text())
          .catch(() => {});
        combinedResult = await fetchCombined();
        parsed = combinedResult.parsed;
        flavorPicked = combinedResult.flavor;
      }
      if (!hasNormalized(parsed)) {
        // 1b) kao poslednji fallback, pokušaj score-sync → rebuild
        await fetch(`${base}/api/score-sync?ymd=${encodeURIComponent(theDay)}`, { cache: "no-store" })
          .then(r => r.text())
          .catch(() => {});
        await fetch(`${base}/api/cron/rebuild?ymd=${encodeURIComponent(theDay)}`, { cache: "no-store" })
          .then(r => r.text())
          .catch(() => {});
        combinedResult = await fetchCombined();
        parsed = combinedResult.parsed;
        flavorPicked = combinedResult.flavor;
      }

      let chosenOption = combinedOption;
      if (!hasNormalized(parsed)) {
        for (const fallback of dayOptions.slice(1)) {
          const fallbackResult = await loadSource(fallback.key);
          const fallbackParsed = fallbackResult.parsed;
          if (hasNormalized(fallbackParsed)) {
            chosenOption = fallback;
            parsed = fallbackParsed;
            flavorPicked = fallbackResult.flavor;
            break;
          }
          if (!hasNormalized(parsed)) {
            chosenOption = fallback;
            parsed = fallbackParsed;
            flavorPicked = fallbackResult.flavor;
          }
        }
      }

      if (!hasNormalized(parsed)) {
        slotTried = slotOptions.map((opt) => opt.slot);
        const aggregated = [];
        let aggregatedInput = 0;
        let slotFlavor = null;
        let slotShape = null;
        for (const slotOpt of slotOptions) {
          const slotResult = await loadSource(slotOpt.key);
          const slotParsed = slotResult.parsed;
          const normalized = Array.isArray(slotParsed.normalized) ? slotParsed.normalized : [];
          const slotInputRaw = Number(slotParsed.inputCount ?? 0);
          const slotInput = Number.isFinite(slotInputRaw) && slotInputRaw > 0 ? slotInputRaw : normalized.length;
          aggregatedInput += slotInput;
          if (normalized.length) {
            aggregated.push(...normalized);
            if (slotFlavor == null && slotResult.flavor) slotFlavor = slotResult.flavor;
            if (slotShape == null && slotParsed.shape) slotShape = slotParsed.shape;
          } else if (slotFlavor == null && slotInput > 0 && slotResult.flavor) {
            slotFlavor = slotResult.flavor;
          }
        }
        const dedupedSlots = dedupeBySignature(aggregated);
        const aggregatedInputCount = aggregated.length > 0 ? aggregated.length : aggregatedInput;
        parsed = {
          shape: slotShape || parsed.shape || "value_bets",
          inputCount: aggregatedInputCount,
          normalized: dedupedSlots,
        };
        if (slotFlavor != null) flavorPicked = slotFlavor;
        chosenOption = { label: "slot:aggregate", key: `vb:day:${theDay}:slots` };
      }

      const sourceKey = chosenOption.key;
      const sourceLabel = chosenOption.label;
      const normalizedCombined = Array.isArray(parsed.normalized) ? parsed.normalized : [];
      const items = dedupeBySignature(normalizedCombined);
      const inputShape = parsed.shape === "model" ? "model" : "value_bets";
      const inputCountRaw = Number(parsed.inputCount ?? 0);
      const inputCount = Number.isFinite(inputCountRaw) ? inputCountRaw : 0;
      const normalizedCount = items.length;

      // 2) finalni rezultati
      const { byId, byPair } = await ensureFinalsFor(theDay, items);

      let settled = 0, won = 0, lost = 0, voided = 0, pending = 0;
      let staked = 0, returned = 0;
      let matchedById = 0, matchedByName = 0;

      const settledItems = [];

      for (const it of items) {
        const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? null;
        const odds = Number(it?.odds?.price ?? 1) || 1;
        const home = it.home?.name || it.home || it?.teams?.home || "";
        const away = it.away?.name || it.away || it?.teams?.away || "";
        const keyPair = makePairKey(home, away);

        let finals = null;
        let outcome = "PENDING";
        let reason = "none";

        if (fid != null && byId[fid]) {
          finals = byId[fid];
          outcome = decideOutcomeFromFinals(it, finals);
          reason = "id";
          matchedById++;
        }
        if (outcome === "PENDING" && (byPair[keyPair] || byPair[makePairKey(away, home)])) {
          finals = byPair[keyPair] || byPair[makePairKey(away, home)];
          outcome = decideOutcomeFromFinals(it, finals);
          reason = "nameMatch";
          matchedByName++;
        }

        if (outcome === "WIN") { staked += 1; returned += odds; settled += 1; won += 1; }
        else if (outcome === "LOSE") { staked += 1; returned += 0; settled += 1; lost += 1; }
        else if (outcome === "VOID" || outcome === "PUSH") { settled += 1; voided += 1; }
        else { pending += 1; }

        settledItems.push({ ...it, outcome, finals: finals || null, _day: theDay, _source: sourceLabel });
      }

      const roi = staked > 0 ? (returned - staked) / staked : 0;

      const historyPayload = {
        ymd: theDay,
        counts: { total: items.length, settled, won, lost, voided, pending },
        roi: { staked, returned, roi },
        items: settledItems,
        meta: {
          builtAt: new Date().toISOString(),
          finals_by_id: Object.keys(byId).length,
          matchedById, matchedByName,
          source: sourceLabel,
          source_key: sourceKey,
          tried,
          triedKeys,
          slotTried,
          flavorPicked: flavorPicked ?? null,
          input_shape: inputShape,
          input_count: inputCount,
          normalized_count: normalizedCount,
        },
      };

      await kvSetJSON(`hist:${theDay}`, historyPayload);
      await kvSetJSON(`hist:day:${theDay}`, historyPayload);

      reports.push({
        ymd: theDay,
        totals: historyPayload.counts,
        roi: historyPayload.roi,
        ...(debug
          ? {
              meta: historyPayload.meta,
              triedKeys,
              slotTried,
              flavorPicked: flavorPicked ?? null,
              input_count: inputCount,
              normalized_count: normalizedCount,
            }
          : {}),
      });
    }

    res.status(200).json({ ok: true, days: ymds.length, report: reports });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
