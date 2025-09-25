// pages/api/cron/apply-learning.js
// Builds history KV records from learned value-bet snapshots while guarding against missing data.
import kvHelpers from "../../../lib/kv-helpers";

export const config = { runtime: "nodejs" };
export const dynamic = "force-dynamic";

const {
  kvBackends: sharedKvBackends,
  readKeyFromBackends,
  writeKeyToBackends,
} = kvHelpers;

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
  const shared = sharedKvBackends();
  if (shared && shared.length) return shared;
  const { url, token } = kvEnv();
  if (url && token) {
    return [{ flavor: "default", url: url.replace(/\/+$/, ""), token }];
  }
  return [];
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
  for (const candidate of marketCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      const normalizedLabel = normalizeMarketLabel(candidate);
      if (normalizedLabel === "1X2") {
        canonicalMarket = "1X2";
        market = "1X2";
        break;
      }
      if (!market) {
        market = candidate.trim();
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
function finalizeH2HEntry(entry, fixtureId) {
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
  const selectionSource = clone.selection || clone.selection_label || clone.pick || "";
  if (selectionSource) {
    const label = String(selectionSource).trim().toUpperCase();
    if (label) {
      clone.selection = label;
      clone.selection_label = label;
      clone.pick = label;
    }
  }
  const predicted = normalizeModelSelection(clone.predicted || clone.model?.predicted || clone.selection);
  if (predicted && ["home", "away", "draw"].includes(predicted)) {
    clone.predicted = predicted;
    if (clone.model && typeof clone.model === "object") {
      if (!clone.model.predicted) clone.model.predicted = predicted;
    }
  }
  clone.market = "1X2";
  clone.market_label = "1X2";
  clone.market_key = "1x2";
  return clone;
}
function filterH2HOnly(items = []) {
  const out = [];
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const fixtureId = coerceFixtureId(item.fixture_id, item.fixtureId, item.fixture, item.id, item?.fixture?.id);
    if (fixtureId == null) continue;
    if (!isLikelyH2H(item)) continue;
    out.push(finalizeH2HEntry(item, fixtureId));
  }
  return out;
}
async function readSnapshot(key, { sourceSlot } = {}, context) {
  const { kvFlavors, trace } = context;
  let items = [];
  let ok = false;

  if (!Array.isArray(kvFlavors) || kvFlavors.length === 0) {
    trace.push({ kv: "get", key, ok: false, size: 0 });
    return { items };
  }

  try {
    const read = await readKeyFromBackends(key, { backends: kvFlavors });
    try {
      const parsed = parseCombinedPayload(read?.value, { sourceSlot });
      if (parsed && Array.isArray(parsed.normalized)) {
        items = parsed.normalized;
      }
    } catch (parseErr) {
      trace.push({ error: { phase: "parse", key, message: String(parseErr?.message || parseErr) } });
    }
    ok = Array.isArray(items) && items.length > 0;
  } catch (err) {
    trace.push({ error: { phase: "read", key, message: String(err?.message || err) } });
  }

  trace.push({ kv: "get", key, ok, size: Array.isArray(items) ? items.length : 0 });
  return { items: Array.isArray(items) ? items : [] };
}
async function loadSnapshotsForDay(ymd, context) {
  const attempts = [`vb:day:${ymd}:union`, `vb:day:${ymd}:combined`];
  for (const key of attempts) {
    const { items } = await readSnapshot(key, {}, context);
    if (items.length > 0) {
      return { items, meta: { source: key } };
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
  context.trace.push({ slots: slotSizes, size: combined.length });
  return { items: combined, meta: { source: "slots", slotSizes } };
}

function createKvClient(kvFlavors) {
  const backends = Array.isArray(kvFlavors) ? kvFlavors : [];
  return {
    async setJSON(key, value) {
      if (!backends.length) {
        const err = new Error("kv_not_configured");
        err.code = "KV_NOT_CONFIGURED";
        throw err;
      }
      const saves = await writeKeyToBackends(key, value, { backends });
      const ok = Array.isArray(saves) ? saves.some((attempt) => attempt?.ok) : false;
      if (!ok) {
        const err = new Error(`kv_write_failed:${key}`);
        err.code = "KV_WRITE_FAILED";
        err.saves = saves;
        throw err;
      }
      return { ok, saves };
    },
  };
}

async function persistHistory(ymd, history, trace, kvFlavors) {
  const size = Array.isArray(history) ? history.length : 0;
  const listKey = `hist:${ymd}`;
  const dayKey = `hist:day:${ymd}`;
  if (!Array.isArray(kvFlavors) || kvFlavors.length === 0) {
    trace.push({ kv: "set", key: listKey, size, ok: false, skipped: "no_backends" });
    trace.push({ kv: "set", key: dayKey, size, ok: false, skipped: "no_backends" });
    return;
  }
  const kv = createKvClient(kvFlavors);
  await setJsonWithTrace(kv, listKey, history, size, trace);
  await setJsonWithTrace(kv, dayKey, { ymd, items: history }, size, trace);
}

async function setJsonWithTrace(kv, key, value, size, trace) {
  try {
    await kv.setJSON(key, value);
    trace.push({ kv: "set", key, size, ok: true });
  } catch (err) {
    trace.push({ kv: "set", key, size, ok: false, error: String(err?.message || err) });
  }
}


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

function extractTeamMeta(entry, side) {
  const root = side === "home" ? "home" : "away";
  const upper = root.charAt(0).toUpperCase() + root.slice(1);
  const id = firstValidId([
    entry?.teams?.[root]?.id,
    entry?.teams?.[root]?.team_id,
    entry?.teams?.[root]?.teamId,
    entry?.fixture?.teams?.[root]?.id,
    entry?.fixture?.teams?.[root]?.team_id,
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
  if (id == null || !name) return null;
  return { id, name };
}

function mergeTeam(existing, required) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  if (base.id == null) base.id = required.id;
  if (base.team_id == null) base.team_id = required.id;
  if (base.teamId == null) base.teamId = required.id;
  if (!base.name) base.name = required.name;
  if (!base.team_name) base.team_name = required.name;
  if (!base.full && required.name) base.full = required.name;
  return base;
}

function enforceHistoryRequirements(items = [], trace) {
  const sanitized = [];
  let dropped = 0;
  for (const original of items || []) {
    if (!original || typeof original !== "object") {
      dropped += 1;
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
    const normalized = finalizeH2HEntry(original, fixtureId);
    const marketLabel = String(
      normalized.market || normalized.market_label || normalized.market_key || ""
    ).trim();
    const selectionLabel = String(
      normalized.selection || normalized.selection_label || normalized.pick || ""
    ).trim();
    if (!marketLabel || !selectionLabel) {
      dropped += 1;
      continue;
    }
    const league = extractLeagueMeta(normalized);
    if (!league) {
      dropped += 1;
      continue;
    }
    const homeTeam = extractTeamMeta(normalized, "home");
    const awayTeam = extractTeamMeta(normalized, "away");
    if (!homeTeam || !awayTeam) {
      dropped += 1;
      continue;
    }
    const prepared = { ...normalized };
    prepared.league_id = prepared.league_id ?? league.id;
    prepared.leagueId = prepared.leagueId ?? league.id;
    prepared.league = {
      ...(prepared.league && typeof prepared.league === "object" ? prepared.league : {}),
      id: league.id,
      name: league.name,
    };
    if (!prepared.league_name) prepared.league_name = league.name;
    if (!prepared.league?.name) prepared.league.name = league.name;
    const teams = prepared.teams && typeof prepared.teams === "object" ? { ...prepared.teams } : {};
    teams.home = mergeTeam(teams.home, homeTeam);
    teams.away = mergeTeam(teams.away, awayTeam);
    prepared.teams = teams;
    if (prepared.fixture && typeof prepared.fixture === "object") {
      const fixtureClone = { ...prepared.fixture };
      const fixtureTeams = fixtureClone.teams && typeof fixtureClone.teams === "object" ? { ...fixtureClone.teams } : {};
      fixtureTeams.home = mergeTeam(fixtureTeams.home, homeTeam);
      fixtureTeams.away = mergeTeam(fixtureTeams.away, awayTeam);
      fixtureClone.teams = fixtureTeams;
      if (fixtureClone.league && typeof fixtureClone.league === "object") {
        fixtureClone.league = { ...fixtureClone.league, id: league.id, name: league.name };
      }
      prepared.fixture = fixtureClone;
    }
    if (!prepared.home && homeTeam.name) prepared.home = homeTeam.name;
    if (!prepared.home_team && homeTeam.name) prepared.home_team = homeTeam.name;
    if (!prepared.home_team_name && homeTeam.name) prepared.home_team_name = homeTeam.name;
    if (!prepared.away && awayTeam.name) prepared.away = awayTeam.name;
    if (!prepared.away_team && awayTeam.name) prepared.away_team = awayTeam.name;
    if (!prepared.away_team_name && awayTeam.name) prepared.away_team_name = awayTeam.name;
    if (prepared.team_home_id == null) prepared.team_home_id = homeTeam.id;
    if (prepared.team_away_id == null) prepared.team_away_id = awayTeam.id;
    if (prepared.home_id == null) prepared.home_id = homeTeam.id;
    if (prepared.away_id == null) prepared.away_id = awayTeam.id;
    sanitized.push(prepared);
  }
  if (trace && dropped) {
    trace.push({ filter: "history_requirements", dropped, kept: sanitized.length });
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

function resolveRequestedYmd(req, fallbackYmd, trace) {
  const queryCandidate = req?.query?.ymd;
  const fromQuery = typeof queryCandidate === "string" ? queryCandidate.trim() : String(queryCandidate || "").trim();
  if (fromQuery) return fromQuery;
  const rawUrl = typeof req?.url === "string" ? req.url : "";
  if (rawUrl) {
    try {
      const host = req?.headers?.host || "localhost";
      const parsed = new URL(rawUrl, `http://${host}`);
      const fromUrl = parsed.searchParams.get("ymd");
      if (typeof fromUrl === "string" && fromUrl.trim()) {
        return fromUrl.trim();
      }
    } catch (err) {
      if (trace && typeof trace.push === "function") {
        trace.push({ query: "ymd", source: "url", error: String(err?.message || err) });
      }
    }
  }
  return fallbackYmd;
}
function isDebugEnabled(req) {
  const fromQuery = req?.query?.debug;
  if (Array.isArray(fromQuery)) {
    if (fromQuery.some((value) => String(value).trim() === "1")) return true;
    if (fromQuery.some((value) => String(value).toLowerCase().trim() === "true")) return true;
  } else if (fromQuery !== undefined) {
    const value = String(fromQuery).trim();
    if (value === "1" || value.toLowerCase() === "true") return true;
  }
  const rawUrl = typeof req?.url === "string" ? req.url : "";
  if (rawUrl) {
    try {
      const host = req?.headers?.host || "localhost";
      const parsed = new URL(rawUrl, `http://${host}`);
      const debugParam = parsed.searchParams.get("debug");
      if (typeof debugParam === "string") {
        const trimmed = debugParam.trim();
        if (trimmed === "1" || trimmed.toLowerCase() === "true") return true;
      }
    } catch (err) {
      // ignore parse errors for debug detection
    }
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const trace = [];
  const debug = isDebugEnabled(req);
  const probeParam = Array.isArray(req?.query?.probe)
    ? req.query.probe.find((value) => String(value).trim().length > 0)
    : req?.query?.probe;
  if (String(probeParam ?? "").trim() === "1") {
    res.status(200).json({ ok: true, probe: true });
    return;
  }
  let currentPhase = "init";
  let ymd = null;
  let historyItems = [];
  try {
    currentPhase = "resolve_ymd";
    const tzYmd = ymdInTZ("Europe/Belgrade");
    ymd = resolveRequestedYmd(req, tzYmd, trace);

    currentPhase = "load";
    let kvFlavors = [];
    try {
      kvFlavors = kvBackends();
    } catch (kvErr) {
      trace.push({ error: { phase: "kv_init", message: String(kvErr?.message || kvErr) } });
      kvFlavors = [];
    }
    const context = { kvFlavors, trace };
    const { items } = await loadSnapshotsForDay(ymd, context);

    currentPhase = "normalize";
    const filtered = filterH2HOnly(items);
    const deduped = dedupeByFixtureStrongest(filtered);
    historyItems = enforceHistoryRequirements(deduped, trace);

    currentPhase = "persist";
    await persistHistory(ymd, historyItems, trace, kvFlavors);

    res.status(200).json({
      ok: true,
      ymd,
      count: historyItems.length,
      trace: debug ? trace : [],
    });
  } catch (err) {
    const errorPayload = {
      phase: currentPhase,
      message: err?.message || String(err),
      stack: err?.stack || null,
    };
    res.status(200).json({
      ok: false,
      ymd,
      count: 0,
      trace: debug ? trace : [],
      error: errorPayload,
    });
  }
}

// Preserve CommonJS compatibility for Jest tests and legacy imports.
if (typeof module !== "undefined") {
  module.exports = handler;
  module.exports.config = config;
  module.exports.dynamic = dynamic;
}
