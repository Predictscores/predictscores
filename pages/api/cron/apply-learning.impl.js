// pages/api/cron/apply-learning.impl.js
// Builds history KV records from learned value-bet snapshots while guarding against missing data.

let sharedKvBackendsRef = null;
let readKeyFromBackendsRef = null;
let writeKeyToBackendsRef = null;

/* ---------- KV helpers ---------- */
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
function kvBackends() {
  if (typeof sharedKvBackendsRef === "function") {
    try {
      const shared = sharedKvBackendsRef();
      if (shared && shared.length) return shared;
    } catch (err) {
      // defer error handling to caller via trace logging
    }
  }
  const { url, token } = kvEnv();
  if (url && token) {
    return [{ flavor: "default", url: url.replace(/\/+$/, ""), token }];
  }
  return [];
}

async function fallbackReadKeyFromBackends(key, options = {}) {
  const { backends = kvBackends() } = options || {};
  for (const backend of Array.isArray(backends) ? backends : []) {
    if (!backend || !backend.url || !backend.token) continue;
    try {
      const url = `${backend.url}/get/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${backend.token}` },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const raw = json?.result ?? json?.value ?? null;
      return { value: raw };
    } catch (err) {
      // ignore and continue to next backend
    }
  }
  return { value: null };
}

async function fallbackWriteKeyToBackends(key, value, options = {}) {
  const { backends = kvBackends() } = options || {};
  const saves = [];
  for (const backend of Array.isArray(backends) ? backends : []) {
    if (!backend || !backend.url || !backend.token) continue;
    try {
      const bodyValue = typeof value === "string" ? value : JSON.stringify(value);
      const url = `${backend.url}/set/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${backend.token}`,
        },
        body: JSON.stringify({ value: bodyValue }),
      });
      saves.push({ flavor: backend.flavor || "default", ok: res.ok, status: res.status });
    } catch (err) {
      saves.push({ flavor: backend.flavor || "default", ok: false, error: String(err?.message || err) });
    }
  }
  return saves;
}

/* ---------- parsing helpers ---------- */
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
function normalizeMarketLabel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^h2h$/i.test(raw)) return "1X2";
  if (/^1x2$/i.test(raw)) return "1X2";
  if (/^match\s*(winner|odds|result)$/i.test(raw)) return "1X2";
  if (/^full\s*time\s*result$/i.test(raw)) return "1X2";
  if (/^(moneyline|ml)$/i.test(raw)) return "1X2";
  if (/^(three[-\s]?way|win[-\s]?draw[-\s]?win)$/i.test(raw)) return "1X2";
  return raw;
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
function dedupeByFixtureStrongest(items = []) {
  const bestByFixture = new Map();
  const loose = [];
  const list = Array.isArray(items) ? items : [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const key = fixtureKeyForDedupe(entry);
    if (key == null) {
      loose.push({ entry, index });
      return;
    }
    const candidates = [
      Number(entry.prob),
      Number(entry.model_prob),
      Number(entry?.model?.model_prob),
    ];
    let probScore = -Infinity;
    for (const candidate of candidates) {
      const num = Number(candidate);
      if (Number.isFinite(num)) {
        probScore = num;
        break;
      }
    }
    const prev = bestByFixture.get(key);
    if (!prev || probScore > prev.prob || (probScore === prev.prob && index < prev.index)) {
      bestByFixture.set(key, { entry, prob: probScore, index });
    }
  });
  const ordered = Array.from(bestByFixture.values())
    .sort((a, b) => a.index - b.index)
    .map((row) => row.entry);
  loose.sort((a, b) => a.index - b.index);
  return [...ordered, ...loose.map((row) => row.entry)];
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
function normalizeValueBetEntry(entry, sourceSlot) {
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
    if (normalized.id == null) normalized.id = fixtureId;
    if (normalized.fixture == null || typeof normalized.fixture !== "object") normalized.fixture = fixtureId;
    if (typeof normalized.fixture === "object" && normalized.fixture && normalized.fixture.id == null) {
      normalized.fixture.id = fixtureId;
    }
  }
  const modelBase = entry.model && typeof entry.model === "object" ? { ...entry.model } : {};
  if (fixtureId != null && modelBase.fixture == null) modelBase.fixture = fixtureId;
  const marketCandidates = [
    entry.market_label,
    entry.market,
    entry.market_key,
    entry.marketName,
    entry.marketname,
    entry.market_display,
    entry.marketDisplay,
    entry.market_slug,
    entry.marketSlug,
    entry.market_type,
    entry.marketType,
  ];
  let market = "";
  let canonicalMarket = "";
  let explicit1x2 = false;
  for (const candidate of marketCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      const normalizedLabel = normalizeMarketLabel(candidate);
      if (normalizedLabel === "1X2") {
        canonicalMarket = "1X2";
        market = "1X2";
        if (String(candidate).trim().toLowerCase() === "1x2") {
          explicit1x2 = true;
        }
        break;
      }
      if (!market) {
        market = candidate.trim();
        if (market.toLowerCase() === "1x2") {
          explicit1x2 = true;
          canonicalMarket = "1X2";
          break;
        }
      }
    }
  }
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
  const mappedSelection = normalizeModelSelection(rawSelection);
  if (mappedSelection && ["home", "away", "draw"].includes(mappedSelection)) {
    normalizedSelection = mappedSelection;
    canonicalMarket = canonicalMarket || "1X2";
    selectionLabel = mappedSelection === "home" ? "HOME" : mappedSelection === "away" ? "AWAY" : "DRAW";
  }
  const finalSelection = selectionLabel || (normalizedSelection != null ? String(normalizedSelection).toUpperCase() : "");
  if (finalSelection) {
    normalized.selection = finalSelection;
    normalized.selection_label = finalSelection;
    normalized.pick = finalSelection;
  }
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
  if (prob == null && canonicalMarket === "1X2" && entry.model_probs && typeof entry.model_probs === "object") {
    const key = normalizedSelection === "home" ? "home" : normalizedSelection === "away" ? "away" : normalizedSelection === "draw" ? "draw" : null;
    if (key && entry.model_probs[key] != null) {
      const num = Number(entry.model_probs[key]);
      if (Number.isFinite(num)) prob = num;
    }
  }
  if (prob != null) {
    normalized.model_prob = prob;
    normalized.prob = prob;
    if (modelBase.model_prob == null) modelBase.model_prob = prob;
  }
  if (Object.keys(modelBase).length) normalized.model = modelBase;
  if (finalSelection && typeof finalSelection === "string") {
    const lowered = finalSelection.toLowerCase();
    if (!normalized.predicted) {
      normalized.predicted = lowered === "home" ? "home" : lowered === "away" ? "away" : lowered === "draw" ? "draw" : lowered;
    }
    if (normalized.model && typeof normalized.model === "object" && !normalized.model.predicted) {
      normalized.model.predicted = normalized.predicted;
    }
  }
  if (canonicalMarket === "1X2") {
    normalized.market = "1X2";
    normalized.market_label = "1X2";
    normalized.market_key = "1x2";
  }
  normalized.__explicit_1x2 = Boolean(explicit1x2);
  if (sourceSlot && !normalized.source_slot) normalized.source_slot = sourceSlot;
  return normalized;
}
function normalizeModelEntry(entry, sourceSlot) {
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
  const marketCandidates = [
    entry.market_key,
    entry.market,
    entry.market_label,
    entry.marketKey,
    entry.marketName,
    entry.market_display,
    entry.marketDisplay,
    entry.market_slug,
    entry.marketSlug,
    entry.market_type,
    entry.marketType,
  ];
  let explicit1x2 = false;
  for (const candidate of marketCandidates) {
    if (typeof candidate === "string" && candidate.trim().toLowerCase() === "1x2") {
      explicit1x2 = true;
      break;
    }
  }
  const normalized = {
    ...entry,
    fixture_id: fixtureId,
    fixtureId,
    market: "1X2",
    market_label: "1X2",
    market_key: "1x2",
    selection: displayLabel,
    selection_label: displayLabel,
    pick: displayLabel,
    predicted: normalizedSelection,
  };
  normalized.__explicit_1x2 = Boolean(explicit1x2);
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
  if (sourceSlot && !normalized.source_slot) normalized.source_slot = sourceSlot;
  return normalized;
}
function parseCombinedPayload(raw, { sourceSlot } = {}) {
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
      const normalizedValue = normalizeValueBetEntry(candidate, sourceSlot);
      if (normalizedValue) {
        normalized.push(normalizedValue);
        valueShape += 1;
        continue;
      }
    }
    if (looksLikeModelCandidate(candidate)) {
      const normalizedModel = normalizeModelEntry(candidate, sourceSlot);
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
const H2H_POSITIVE_PATTERNS = [
  /MATCH\s*(RESULT|ODDS|WINNER)/i,
  /FULL\s*TIME\s*RESULT/i,
  /FT\s*RESULT/i,
  /WIN[-\s]?DRAW[-\s]?WIN/i,
  /THREE[-\s]?WAY/i,
  /TO\s+WIN\s+MATCH/i,
  /MONEYLINE/i,
  /\bML\b/i,
  /H2H/i,
  /1X2/i,
];
const H2H_NEGATIVE_PATTERNS = [
  /OVER/i,
  /UNDER/i,
  /TOTAL/i,
  /HANDICAP/i,
  /SPREAD/i,
  /DOUBLE/i,
  /DRAW\s*NO\s*BET/i,
  /\bDNB\b/i,
  /ASIAN/i,
  /TEAM\s+TOTAL/i,
  /TEAM\s+GOALS/i,
  /POINT/i,
  /CARD/i,
  /CORNER/i,
  /HT\/?FT/i,
  /HALF/i,
  /PERIOD/i,
  /BOTH/i,
  /BTTS/i,
  /GG/i,
  /PROP/i,
  /SPECIAL/i,
  /SCORER/i,
  /OUTRIGHT/i,
  /FUTURE/i,
];
function hasPattern(patterns, value) {
  const str = String(value ?? "");
  if (!str) return false;
  return patterns.some((re) => re.test(str));
}
function isLikelyH2H(entry) {
  if (!entry || typeof entry !== "object") return false;
  const fields = [
    entry.market,
    entry.market_label,
    entry.market_key,
    entry.marketName,
    entry.marketname,
    entry.market_display,
    entry.marketDisplay,
    entry.market_slug,
    entry.marketSlug,
    entry.marketType,
    entry.market_type,
    entry.marketGroup,
    entry.market_group,
    entry.type,
    entry.bet_type,
    entry.category,
  ];
  let positive = false;
  let negative = false;
  for (const field of fields) {
    if (typeof field !== "string") continue;
    const trimmed = field.trim();
    if (!trimmed) continue;
    const normalized = normalizeMarketLabel(trimmed);
    if (normalized === "1X2") {
      positive = true;
      continue;
    }
    if (hasPattern(H2H_POSITIVE_PATTERNS, trimmed)) {
      positive = true;
    }
    if (hasPattern(H2H_NEGATIVE_PATTERNS, trimmed)) {
      negative = true;
    }
  }
  if (positive) return true;
  if (negative) return false;
  const selectionCandidates = [
    entry.selection,
    entry.selection_label,
    entry.pick,
    entry.pick_code,
    entry.predicted,
    entry.model?.predicted,
  ];
  for (const candidate of selectionCandidates) {
    if (candidate == null) continue;
    const str = String(candidate).trim();
    if (!str) continue;
    if (str.includes("/")) return false;
    const normalizedSelection = normalizeModelSelection(str);
    if (["home", "away", "draw"].includes(normalizedSelection)) return true;
    const upper = str.toUpperCase();
    if (upper === "1" || upper === "2" || upper === "X") return true;
    if (upper === "HOME" || upper === "AWAY" || upper === "DRAW") return true;
  }
  return false;
}
function finalizeH2HEntry(entry, fixtureId, fillCounts) {
  const clone = { ...entry };
  const effectiveFixture = fixtureId ?? clone.fixture_id ?? clone.id ?? clone.fixtureId;
  if (effectiveFixture != null) {
    clone.fixture_id = effectiveFixture;
    if (clone.fixtureId == null) clone.fixtureId = effectiveFixture;
    if (clone.id == null) clone.id = effectiveFixture;
    if (clone.model && typeof clone.model === "object" && clone.model.fixture == null) {
      clone.model.fixture = effectiveFixture;
    }
  }
  populateNormalizedTeams(clone, fillCounts);
  return clone;
}
function filterH2HOnly(items = [], fillCounts, options = {}) {
  const requestedSlot = typeof options?.slot === "string" ? options.slot.trim() : "";
  const out = [];
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const fixtureId = coerceFixtureId(item.fixture_id, item.fixtureId, item.fixture, item.id, item?.fixture?.id);
    if (fixtureId == null) continue;
    if (!isLikelyH2H(item)) continue;
    const prepared = finalizeH2HEntry(item, fixtureId, fillCounts);
    if (requestedSlot && !prepared.slot) {
      prepared.slot = requestedSlot.toLowerCase();
    }
    out.push(prepared);
  }
  return out;
}
async function readSnapshot(key, { sourceSlot } = {}, context = {}) {
  const { kvFlavors, trace } = context;
  const contextYmd = typeof context?.ymd === "string" ? context.ymd : null;
  const contextSlot = sourceSlot || (typeof context?.slot === "string" ? context.slot : null);
  const traceMeta = {};
  if (contextYmd) traceMeta.ymd = contextYmd;
  if (contextSlot) traceMeta.slot = contextSlot;
  const readKey = typeof context?.readKey === "function" ? context.readKey : readKeyFromBackendsRef;
  let items = [];
  let ok = false;

  if (!Array.isArray(kvFlavors) || kvFlavors.length === 0) {
    if (trace && typeof trace.push === "function") {
      trace.push({ kv: "get", key, ok: false, size: 0, skipped: "no_backends", ...traceMeta });
    }
    return { items };
  }

  if (typeof readKey !== "function") {
    if (trace && typeof trace.push === "function") {
      trace.push({ kv: "get", key, ok: false, size: 0, skipped: "no_reader", ...traceMeta });
    }
    return { items };
  }

  try {
    const read = await readKey(key, { backends: kvFlavors });
    try {
      const parsed = parseCombinedPayload(read?.value, { sourceSlot });
      if (parsed && Array.isArray(parsed.normalized)) {
        items = parsed.normalized;
      }
    } catch (parseErr) {
      trace.push({ error: { phase: "parse", key, message: String(parseErr?.message || parseErr), ...traceMeta } });
    }
    ok = Array.isArray(items) && items.length > 0;
  } catch (err) {
    trace.push({ error: { phase: "read", key, message: String(err?.message || err), ...traceMeta } });
  }

  trace.push({ kv: "get", key, ok, size: Array.isArray(items) ? items.length : 0, ...traceMeta });
  return { items: Array.isArray(items) ? items : [] };
}
async function loadSnapshotsForDay(ymd, options = {}, context = {}) {
  const requestedSlot = typeof options?.slot === "string" ? options.slot.trim().toLowerCase() : "";
  if (requestedSlot) {
    const slotKey = `vb:day:${ymd}:${requestedSlot}`;
    const { items } = await readSnapshot(slotKey, { sourceSlot: requestedSlot }, context);
    const deduped = dedupeByFixtureStrongest(items);
    const traceMeta = { requestedSlot, ymd, size: deduped.length, slots: { [requestedSlot]: items.length } };
    if (context?.trace && typeof context.trace.push === "function") {
      context.trace.push(traceMeta);
    }
    return { items: deduped, meta: { source: slotKey, slot: requestedSlot } };
  }
  const attempts = [`vb:day:${ymd}:union`, `vb:day:${ymd}:combined`];
  for (const key of attempts) {
    const { items } = await readSnapshot(key, {}, context);
    if (items.length > 0) {
      return { items, meta: { source: key } };
    }
  }
  const lastKey = `vb:day:${ymd}:last`;
  {
    const { items } = await readSnapshot(lastKey, { sourceSlot: "last" }, context);
    if (items.length > 0) {
      const deduped = dedupeByFixtureStrongest(items);
      return { items: deduped, meta: { source: lastKey, slot: "last" } };
    }
  }
  let aggregated = [];
  const slotSizes = {};
  for (const slot of ["am", "pm", "late"]) {
    const { items } = await readSnapshot(`vb:day:${ymd}:${slot}`, { sourceSlot: slot }, context);
    slotSizes[slot] = items.length;
    if (items.length) {
      aggregated = aggregated.concat(items);
    }
  }
  const combined = dedupeByFixtureStrongest(aggregated);
  const tracePayload = { slots: slotSizes, size: combined.length, ymd };
  if (context?.trace && typeof context.trace.push === "function") {
    context.trace.push(tracePayload);
  }
  return { items: combined, meta: { source: "slots", slotSizes } };
}

function createKvClient(kvFlavors) {
  const backends = Array.isArray(kvFlavors) ? kvFlavors : [];
  async function writeValue(key, value) {
    if (!backends.length) {
      const err = new Error("kv_not_configured");
      err.code = "KV_NOT_CONFIGURED";
      throw err;
    }
    if (typeof writeKeyToBackendsRef !== "function") {
      const err = new Error("kv_writer_unavailable");
      err.code = "KV_WRITE_UNAVAILABLE";
      throw err;
    }
    const saves = await writeKeyToBackendsRef(key, value, { backends });
    const ok = Array.isArray(saves) ? saves.some((attempt) => attempt?.ok) : false;
    if (!ok) {
      const err = new Error(`kv_write_failed:${key}`);
      err.code = "KV_WRITE_FAILED";
      err.saves = saves;
      throw err;
    }
    return { ok, saves };
  }

  return {
    async set(key, value) {
      return writeValue(key, value);
    },
    async setJSON(key, value) {
      return writeValue(key, value);
    },
  };
}

async function persistHistory(ymd, history, trace, kvFlavors, options = {}) {
  const slot = typeof options?.slot === "string" && options.slot ? options.slot : "";
  const kvClient = options?.kvClient || null;
  const payload = Array.isArray(history) ? history : [];
  const size = payload.length;
  const listKey = `hist:${ymd}`;
  const dayKey = `hist:day:${ymd}`;
  const meta = { ymd };
  if (slot) meta.slot = slot;
  const traceLog = trace && typeof trace.push === "function" ? trace : null;

  const hasBackends = Array.isArray(kvFlavors) && kvFlavors.length > 0;
  if (!kvClient && !hasBackends) {
    if (traceLog) {
      traceLog.push({ kv: "set", key: listKey, size, ok: false, skipped: "no_backends", ...meta });
      traceLog.push({ kv: "set", key: dayKey, size, ok: false, skipped: "no_backends", ...meta });
    }
    return;
  }

  const kv = kvClient || createKvClient(kvFlavors);
  const listMeta = { ...meta, scope: "list" };
  const dayMeta = { ...meta, scope: "day" };

  await setJsonWithTrace(kv, listKey, payload, size, traceLog || trace, listMeta);
  await setJsonWithTrace(kv, dayKey, payload, size, traceLog || trace, dayMeta);
}

async function setJsonWithTrace(kv, key, value, size, trace, meta = {}) {
  const payload = Array.isArray(value) ? value : [];
  const payloadSize = Array.isArray(payload) ? payload.length : typeof size === "number" ? size : 0;
  const traceLog = trace && typeof trace.push === "function" ? trace : null;

  try {
    const setter =
      typeof kv?.setJSON === "function"
        ? kv.setJSON.bind(kv)
        : typeof kv?.set === "function"
        ? kv.set.bind(kv)
        : null;
    if (!setter) {
      throw new Error("kv_set_unavailable");
    }
    const result = await setter(key, payload);
    if (traceLog) {
      const entry = { kv: "set", key, size: payloadSize, ok: true, ...meta };
      if (result && typeof result === "object" && result.saves !== undefined) {
        entry.saves = result.saves;
      }
      traceLog.push(entry);
    }
    return result;
  } catch (err) {
    if (traceLog) {
      traceLog.push({
        kv: "set",
        key,
        size: payloadSize,
        ok: false,
        error: String(err?.message || err),
        ...meta,
      });
    }
    return null;
  }
}

export { persistHistory, setJsonWithTrace };


function coerceId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) return numeric;
    return trimmed;
  }
  return null;
}

function coerceName(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "object") {
    const candidates = [
      value.name,
      value.full,
      value.fullName,
      value.fullname,
      value.display,
      value.displayName,
      value.nickname,
      value.short,
      value.shortName,
      value.team,
      value.title,
    ];
    for (const candidate of candidates) {
      const result = coerceName(candidate);
      if (result) return result;
    }
  }
  return "";
}

function firstValidId(candidates = []) {
  for (const candidate of candidates) {
    const id = coerceId(candidate);
    if (id !== null && id !== undefined) {
      if (typeof id === "string" && !id.trim()) continue;
      return id;
    }
  }
  return null;
}

function firstValidName(candidates = []) {
  for (const candidate of candidates) {
    const name = coerceName(candidate);
    if (name) return name;
  }
  return "";
}

function extractLeagueMeta(entry) {
  const leagueId = firstValidId([
    entry?.league_id,
    entry?.leagueId,
    entry?.league?.id,
    entry?.league?.league_id,
    entry?.fixture?.league?.id,
    entry?.fixture?.league?.league_id,
    entry?.competition_id,
    entry?.competitionId,
  ]);
  const leagueName = firstValidName([
    entry?.league_name,
    entry?.leagueName,
    entry?.league?.name,
    entry?.league?.league_name,
    entry?.fixture?.league?.name,
    entry?.fixture?.league?.league_name,
    entry?.competition_name,
    entry?.competitionName,
  ]);
  if (leagueId == null || !leagueName) return null;
  return { id: leagueId, name: leagueName };
}

function normalizeTeamCandidate(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") {
    const id = firstValidId([raw.id, raw.team_id, raw.teamId]);
    const name = firstValidName([raw.name, raw.team_name, raw]);
    if (!name) return null;
    return { id: id ?? null, name };
  }
  const name = firstValidName([raw]);
  if (!name) return null;
  return { id: null, name };
}

function deriveTeamFromSources(entry, side) {
  const root = side === "home" ? "home" : "away";
  const sources = [
    () => entry?.teams?.[root],
    () => entry?.fixture?.teams?.[root],
    () => {
      const name = firstValidName([entry?.[`${root}_name`], entry?.[root]]);
      if (!name) return null;
      return { id: null, name };
    },
    () => entry?.fixture?.[root],
    () => {
      const name = firstValidName([entry?.model?.[`${root}_team`]]);
      if (!name) return null;
      return { id: null, name };
    },
  ];
  for (const getter of sources) {
    try {
      const candidate = normalizeTeamCandidate(typeof getter === "function" ? getter() : getter);
      if (candidate && candidate.name) {
        return { id: candidate.id ?? null, name: candidate.name };
      }
    } catch (err) {
      // ignore malformed sources
    }
  }
  return null;
}

function applyTeamCandidate(existing, candidate) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  if (!candidate || !candidate.name) return base;
  if (base.id == null) base.id = candidate.id ?? null;
  if (base.team_id == null) base.team_id = candidate.id ?? null;
  if (base.teamId == null) base.teamId = candidate.id ?? null;
  if (!coerceName(base.name)) base.name = candidate.name;
  if (!coerceName(base.team_name)) base.team_name = candidate.name;
  if (!coerceName(base.full)) base.full = candidate.name;
  return base;
}

function populateNormalizedTeams(target, fillCounts) {
  if (!target || typeof target !== "object") return;
  const homeCandidate = deriveTeamFromSources(target, "home");
  const awayCandidate = deriveTeamFromSources(target, "away");
  if (!homeCandidate && !awayCandidate) return;

  const teams = target.teams && typeof target.teams === "object" ? { ...target.teams } : {};
  if (homeCandidate) {
    teams.home = applyTeamCandidate(teams.home, homeCandidate);
    if (fillCounts && typeof fillCounts.home === "number") fillCounts.home += 1;
  }
  if (awayCandidate) {
    teams.away = applyTeamCandidate(teams.away, awayCandidate);
    if (fillCounts && typeof fillCounts.away === "number") fillCounts.away += 1;
  }
  target.teams = teams;

  if (target.fixture && typeof target.fixture === "object") {
    const fixtureClone = { ...target.fixture };
    const fixtureTeams = fixtureClone.teams && typeof fixtureClone.teams === "object" ? { ...fixtureClone.teams } : {};
    if (homeCandidate) fixtureTeams.home = applyTeamCandidate(fixtureTeams.home, homeCandidate);
    if (awayCandidate) fixtureTeams.away = applyTeamCandidate(fixtureTeams.away, awayCandidate);
    fixtureClone.teams = fixtureTeams;
    target.fixture = fixtureClone;
  }
}

function extractTeamMeta(entry, side) {
  const root = side === "home" ? "home" : "away";
  const upper = root.charAt(0).toUpperCase() + root.slice(1);
  const id = firstValidId([
    entry?.teams?.[root]?.id,
    entry?.teams?.[root]?.team_id,
    entry?.teams?.[root]?.teamId,
    entry?.fixture?.teams?.[root]?.id,
    entry?.fixture?.teams?.[root]?.team_id,
    entry?.fixture?.[root]?.id,
    entry?.fixture?.[root]?.team_id,
    entry?.fixture?.[root]?.teamId,
    entry?.fixture?.[`team_${root}_id`],
    entry?.fixture?.[`team${upper}Id`],
    entry?.[`team_${root}_id`],
    entry?.[`team${upper}Id`],
    entry?.[`${root}TeamId`],
    entry?.[`teams_${root}_id`],
    entry?.[`fixture_${root}_id`],
    entry?.[`fixture`]?.[`teams_${root}_id`],
  ]);
  const name = firstValidName([
    entry?.teams?.[root]?.name,
    entry?.teams?.[root]?.team_name,
    entry?.teams?.[root],
    entry?.teams?.[`${root}_name`],
    entry?.teams?.[`${root}Name`],
    entry?.fixture?.teams?.[root]?.name,
    entry?.fixture?.teams?.[root],
    entry?.fixture?.[root]?.name,
    entry?.fixture?.[root],
    entry?.fixture?.[`team_${root}_name`],
    entry?.fixture?.[`team${upper}Name`],
    entry?.[`team_${root}_name`],
    entry?.[`team${upper}Name`],
    entry?.[`teams_${root}`],
    entry?.[`teams_${root}_name`],
    entry?.[`teams_${root}Name`],
    entry?.[root],
    entry?.[`${root}_team`],
    entry?.[`${root}Team`],
    entry?.[`${upper}Team`],
    entry?.[`${root}_name`],
    entry?.[`team_${root}`],
  ]);
  if (!name) return null;
  return { id: id ?? null, name };
}

function normalizeHistorySlot(value) {
  if (!value) return "";
  const text = String(value).trim().toLowerCase();
  if (!text) return "";
  if (text === "am" || text === "pm" || text === "late") return text;
  if (text === "morning") return "am";
  if (text === "afternoon") return "pm";
  if (text === "early") return "late";
  return "";
}

function extractSlotValue(entry) {
  if (!entry || typeof entry !== "object") return "";
  const candidates = [
    entry.slot,
    entry.slot_key,
    entry.slotKey,
    entry.slot_name,
    entry.slotName,
    entry.history_slot,
    entry.meta?.slot,
    entry.meta?.slot_key,
    entry.meta?.slotName,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeHistorySlot(candidate);
    if (normalized) return normalized;
  }
  return "";
}

function extractKickoffValue(entry) {
  const candidates = [
    entry?.kickoff,
    entry?.kickoff_utc,
    entry?.kickoff_iso,
    entry?.kickoffUtc,
    entry?.kickoffISO,
    entry?.fixture?.kickoff,
    entry?.fixture?.kickoff_utc,
    entry?.fixture?.date,
    entry?.fixture?.datetime,
    entry?.fixture?.start,
    entry?.datetime_local?.starting_at?.date_time,
    entry?.time?.starting_at?.date_time,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate instanceof Date && Number.isFinite(candidate.getTime?.())) {
      return candidate.toISOString();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      if (Math.abs(candidate) > 1e12) {
        return new Date(candidate).toISOString();
      }
      if (Math.abs(candidate) > 1e6) {
        return new Date(candidate * 1000).toISOString();
      }
    }
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

function extractModelProbability(entry) {
  if (!entry || typeof entry !== "object") return null;
  const candidates = [
    entry.model_prob,
    entry.modelProbability,
    entry.model_prob_pct,
    entry.prob,
    entry.probability,
    entry.model?.model_prob,
    entry.model?.prob,
    entry.model?.probability,
    entry.model?.model_probability,
  ];
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }
  if (entry.model_probs && typeof entry.model_probs === "object") {
    const rawSelection = normalizeModelSelection(
      entry.model?.predicted ?? entry.predicted ?? entry.selection ?? entry.pick
    );
    const key = rawSelection === "home" ? "home" : rawSelection === "away" ? "away" : rawSelection === "draw" ? "draw" : null;
    if (key && entry.model_probs[key] != null) {
      const num = Number(entry.model_probs[key]);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function normalizeHistorySelection(entry) {
  if (!entry || typeof entry !== "object") return "";
  const candidates = [
    entry.selection,
    entry.selection_label,
    entry.pick,
    entry.pick_code,
    entry.predicted,
    entry.model?.predicted,
    entry.model?.selection,
    extractModelRawSelection(entry),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeModelSelection(candidate);
    if (normalized && ["home", "away", "draw"].includes(normalized)) {
      return normalized;
    }
  }
  return "";
}

function enforceHistoryRequirements(items = [], trace) {
  const sanitized = [];
  let dropped = 0;
  const reasons = {
    noMarket: 0,
    noFixture: 0,
    noTeams: 0,
    noSelection: 0,
    invalid: 0,
    assumedMarket: 0,
  };

  for (const original of items || []) {
    if (!original || typeof original !== "object") {
      dropped += 1;
      reasons.invalid += 1;
      continue;
    }

    const marketCandidates = [
      original.market_key,
      original.market,
      original.market_label,
      original.marketKey,
      original.marketName,
      original.market_display,
      original.marketDisplay,
      original.market_slug,
      original.marketSlug,
      original?.model?.market_key,
      original?.model?.market,
      original?.model?.market_label,
      original?.model?.marketKey,
      original?.model?.marketName,
    ];

    const explicitFlag = original.__explicit_1x2;
    let has1x2 = explicitFlag === true;
    const explicitKnown = typeof explicitFlag === "boolean";
    if (!has1x2) {
      for (const candidate of marketCandidates) {
        if (typeof candidate !== "string") continue;
        if (candidate.trim().toLowerCase() === "1x2" && !explicitKnown) {
          has1x2 = true;
          break;
        }
      }
    }

    if (!has1x2) {
      const normalizedSelection = normalizeHistorySelection(original);
      if (normalizedSelection && ["home", "away", "draw"].includes(normalizedSelection)) {
        const hasTeams = Boolean(extractTeamMeta(original, "home")) && Boolean(extractTeamMeta(original, "away"));
        if (isLikelyH2H(original) || hasTeams) {
          has1x2 = true;
          reasons.assumedMarket += 1;
        }
      }
    }

    if (!has1x2) {
      dropped += 1;
      reasons.noMarket += 1;
      continue;
    }

    const fixtureId = coerceFixtureId(
      original.fixture_id,
      original.fixtureId,
      original.fixture,
      original.id,
      original?.fixture?.id,
      original.match_id,
      original.matchId
    );

    if (fixtureId == null) {
      dropped += 1;
      reasons.noFixture += 1;
      continue;
    }

    const normalized = finalizeH2HEntry(original, fixtureId);
    const normalizedSelection = normalizeHistorySelection({ ...normalized, fixture_id: fixtureId }) || "";

    if (!normalizedSelection) {
      dropped += 1;
      reasons.noSelection += 1;
      continue;
    }

    const homeTeam = extractTeamMeta(normalized, "home");
    const awayTeam = extractTeamMeta(normalized, "away");
    if (!homeTeam || !awayTeam) {
      dropped += 1;
      reasons.noTeams += 1;
      continue;
    }

    const predictedCandidates = [
      normalized.predicted,
      original.predicted,
      original.model?.predicted,
      original.selection,
      original.pick,
    ];
    let predicted = "";
    for (const candidate of predictedCandidates) {
      const normalizedCandidate = normalizeModelSelection(candidate);
      if (normalizedCandidate && ["home", "away", "draw"].includes(normalizedCandidate)) {
        predicted = normalizedCandidate;
        break;
      }
    }
    if (!predicted) predicted = normalizedSelection;

    const homeName = coerceName(homeTeam.name);
    const awayName = coerceName(awayTeam.name);
    if (!homeName || !awayName) {
      dropped += 1;
      reasons.noTeams += 1;
      continue;
    }

    const kickoff = extractKickoffValue(original) || extractKickoffValue(normalized);
    const prob = extractModelProbability(original);
    const slot = extractSlotValue(original);

    const prepared = {
      fixture_id: fixtureId,
      selection: normalizedSelection,
      predicted,
      home_name: homeName,
      away_name: awayName,
      market_key: "1x2",
      market: "1x2",
      market_label: "1X2",
      source: "combined",
    };
    if (kickoff) prepared.kickoff = kickoff;
    if (prob != null) prepared.model_prob = prob;
    if (slot) prepared.slot = slot;

    sanitized.push(prepared);
  }

  if (trace && typeof trace.push === "function") {
    trace.push({
      history_requirements: {
        kept: sanitized.length,
        dropped,
        reasons,
      },
    });
  }

  return sanitized;
}
function ymdInTZ(tz = "Europe/Belgrade", d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const dd = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${dd}`;
}

function safeParseRequestSearchParams(req, trace) {
  const rawUrl = typeof req?.url === "string" ? req.url : "";
  if (!rawUrl) return null;
  try {
    const host = req?.headers?.host || "localhost";
    const parsed = new URL(rawUrl, `http://${host}`);
    return parsed.searchParams;
  } catch (err) {
    if (trace && typeof trace.push === "function") {
      trace.push({ query: "params", source: "url", error: String(err?.message || err) });
    }
  }
  return null;
}

function collectRequestParamCandidates(req, name, searchParams) {
  const candidates = [];
  const queryValue = req?.query?.[name];
  if (Array.isArray(queryValue)) {
    for (const value of queryValue) {
      const trimmed = String(value ?? "").trim();
      if (trimmed) {
        candidates.push({ value: trimmed, source: "query" });
      }
    }
  } else if (queryValue !== undefined && queryValue !== null) {
    const trimmed = String(queryValue).trim();
    if (trimmed) {
      candidates.push({ value: trimmed, source: "query" });
    }
  }
  if (searchParams && typeof searchParams.getAll === "function") {
    const urlValues = searchParams.getAll(name) || [];
    for (const value of urlValues) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) {
        candidates.push({ value: trimmed, source: "url" });
      }
    }
  }
  return candidates;
}

function resolveRequestedYmd(req, fallbackYmd, trace, searchParams = null) {
  const candidates = collectRequestParamCandidates(req, "ymd", searchParams);
  const chosen = candidates.find((entry) => entry?.value?.length);
  if (!chosen) {
    return fallbackYmd;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chosen.value)) {
    if (trace && typeof trace.push === "function") {
      trace.push({ query: "ymd", source: chosen.source, value: chosen.value, error: "invalid_format" });
    }
    return fallbackYmd;
  }
  return chosen.value;
}

const VALID_REQUEST_SLOTS = new Set(["am", "pm", "late", "combined", "union"]);

function resolveRequestedSlot(req, trace, searchParams = null) {
  const candidates = collectRequestParamCandidates(req, "slot", searchParams);
  const chosen = candidates.find((entry) => entry?.value?.length);
  if (!chosen) return null;
  const normalized = chosen.value.toLowerCase();
  if (normalized === "auto") {
    return null;
  }
  if (!VALID_REQUEST_SLOTS.has(normalized)) {
    if (trace && typeof trace.push === "function") {
      trace.push({ query: "slot", source: chosen.source, value: chosen.value, error: "invalid_slot" });
    }
    return null;
  }
  return normalized;
}

function isTraceRequestedFromParams(req, searchParams = null) {
  const candidates = collectRequestParamCandidates(req, "trace", searchParams);
  if (!candidates.length) return false;
  return candidates.some((entry) => entry.value === "1");
}

function parseRequestParams(req, trace) {
  const fallbackYmd = ymdInTZ("UTC");
  const searchParams = safeParseRequestSearchParams(req, trace);
  const ymd = resolveRequestedYmd(req, fallbackYmd, trace, searchParams);
  const slot = resolveRequestedSlot(req, trace, searchParams);
  const traceRequested = isTraceRequestedFromParams(req, searchParams);
  return { ymd, slot, traceRequested };
}

function isTraceRequested(req) {
  const queryKeys = ["trace", "_trace"];
  for (const key of queryKeys) {
    const value = req?.query?.[key];
    if (Array.isArray(value)) {
      if (value.some((entry) => {
        const normalized = String(entry).trim().toLowerCase();
        return normalized === "1" || normalized === "true";
      })) {
        return true;
      }
    } else if (value !== undefined) {
      const normalized = String(value).trim().toLowerCase();
      if (normalized === "1" || normalized === "true") return true;
    }
  }

  const rawUrl = typeof req?.url === "string" ? req.url : "";
  if (rawUrl) {
    try {
      const host = req?.headers?.host || "localhost";
      const parsed = new URL(rawUrl, `http://${host}`);
      for (const key of queryKeys) {
        const param = parsed.searchParams.get(key);
        if (typeof param === "string") {
          const normalized = param.trim().toLowerCase();
          if (normalized === "1" || normalized === "true") return true;
        }
      }
    } catch (err) {
      // ignore URL parsing errors for trace detection
    }
  }

  const headerKeys = ["x-trace", "x-debug-trace", "trace"];
  for (const key of headerKeys) {
    const value = req?.headers?.[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.some((entry) => {
        const normalized = String(entry).trim().toLowerCase();
        return normalized === "1" || normalized === "true";
      })) {
        return true;
      }
    } else {
      const normalized = String(value).trim().toLowerCase();
      if (normalized === "1" || normalized === "true") return true;
    }
  }

  return false;
}

export async function runApplyLearning(req, res) {
  if (req.query && req.query.probe === "1") {
    return res.status(200).json({ ok: true, probe: true });
  }

  res.setHeader("Cache-Control", "no-store");
  const trace = [];
  const { ymd: initialYmd, slot, traceRequested } = parseRequestParams(req, trace);
  const _trace = traceRequested ? trace : [];
  const probeParam = Array.isArray(req?.query?.probe)
    ? req.query.probe.find((value) => String(value).trim().length > 0)
    : req?.query?.probe;
  if (String(probeParam ?? "").trim() === "1") {
    return res.status(200).json({ ok: true, probe: true });
  }

  let currentPhase = "init";
  let ymd = initialYmd;
  let historyItems = [];

  try {
    currentPhase = "import";
    try {
      const kvHelpers = await import("../../../lib/kv-helpers.js");
      sharedKvBackendsRef = typeof kvHelpers?.kvBackends === "function" ? kvHelpers.kvBackends : null;
      readKeyFromBackendsRef = typeof kvHelpers?.readKeyFromBackends === "function" ? kvHelpers.readKeyFromBackends : null;
      writeKeyToBackendsRef = typeof kvHelpers?.writeKeyToBackends === "function" ? kvHelpers.writeKeyToBackends : null;
    } catch (importErr) {
      sharedKvBackendsRef = null;
      readKeyFromBackendsRef = null;
      writeKeyToBackendsRef = null;
      trace.push({ error: { phase: "import", message: String(importErr?.message || importErr) } });
    }

    if (typeof readKeyFromBackendsRef !== "function") {
      readKeyFromBackendsRef = fallbackReadKeyFromBackends;
    }
    if (typeof writeKeyToBackendsRef !== "function") {
      writeKeyToBackendsRef = fallbackWriteKeyToBackends;
    }

    currentPhase = "load";
    let kvFlavors = [];
    try {
      kvFlavors = kvBackends();
    } catch (kvErr) {
      trace.push({ error: { phase: "kv_init", message: String(kvErr?.message || kvErr) } });
      kvFlavors = [];
    }
    const context = { kvFlavors, trace, readKey: readKeyFromBackendsRef, ymd, slot };
    const { items } = await loadSnapshotsForDay(ymd, { slot }, context);

    currentPhase = "normalize";
    const teamFillCounts = { home: 0, away: 0 };
    const filtered = filterH2HOnly(items, teamFillCounts, { slot });
    if (trace && typeof trace.push === "function") {
      trace.push({ normalize: "teams", filled: { home: teamFillCounts.home, away: teamFillCounts.away } });
    }
    const deduped = dedupeByFixtureStrongest(filtered);
    historyItems = enforceHistoryRequirements(deduped, trace);

    currentPhase = "persist";
    await persistHistory(ymd, historyItems, trace, kvFlavors, { slot });

    const payload = {
      ok: true,
      ymd,
      slot,
      count: historyItems.length,
    };
    if (traceRequested) {
      payload._trace = trace;
    }
    return res.status(200).json(payload);
  } catch (err) {
    const errorPayload = {
      phase: currentPhase,
      message: err?.message || String(err),
      stack: err?.stack || null,
    };
    const payload = {
      ok: false,
      ymd,
      slot,
      count: 0,
      trace: _trace || [],
      error: errorPayload,
    };
    if (traceRequested) {
      payload._trace = trace;
    }
    return res.status(200).json(payload);
  }
}
