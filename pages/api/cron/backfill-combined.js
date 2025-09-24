// pages/api/cron/backfill-combined.js
// Backfills vb:day:<YMD>:combined from vb:day:<YMD>:union.

const { CRON_KEY = "" } = process.env;

function kvBackends() {
  const out = [];
  const aUraw = process.env.KV_REST_API_URL || process.env.KV_URL;
  const aT = process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN;
  const bUraw = process.env.UPSTASH_REDIS_REST_URL;
  const bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aUraw && aT) out.push({ flavor: "vercel-kv", url: aUraw.replace(/\/+$/, ""), tok: aT });
  if (bUraw && bT) out.push({ flavor: "upstash-redis", url: bUraw.replace(/\/+$/, ""), tok: bT });
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
function extractArray(payload, depth = 0) {
  if (payload == null || depth > 3) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
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
  ];
  for (const key of preferredKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }
  for (const key of preferredKeys) {
    const candidate = payload[key];
    if (candidate && typeof candidate === "object") {
      const nested = extractArray(candidate, depth + 1);
      if (nested.length) return nested;
    }
  }
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === "object") {
      const nested = extractArray(value, depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}
async function kvGETFromBackend(key, backend) {
  try {
    const u = `${backend.url}/get/${encodeURIComponent(key)}`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${backend.tok}` }, cache: "no-store" });
    if (!r.ok) return { flavor: backend.flavor, items: [] };
    const j = await r.json().catch(() => null);
    let v = j?.result ?? j?.value ?? null;
    if (v == null) return { flavor: backend.flavor, items: [] };
    const parsed = safeJsonParse(v);
    if (typeof parsed !== "undefined") v = parsed;
    const items = extractArray(v);
    return { flavor: backend.flavor, items };
  } catch {
    return { flavor: backend.flavor, items: [] };
  }
}
async function kvSET(key, val, trace = []) {
  const saves = [];
  for (const b of kvBackends()) {
    try {
      const body = typeof val === "string" ? val : JSON.stringify(val);
      const u = `${b.url}/set/${encodeURIComponent(key)}`;
      const r = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${b.tok}` },
        body: JSON.stringify({ value: body }),
      });
      saves.push({ key, flavor: b.flavor, ok: r.ok });
    } catch (e) {
      saves.push({ key, flavor: b.flavor, ok: false, error: String(e?.message || e) });
    }
  }
  trace.push({ kv: "set", key, saves });
  return saves;
}
function checkCronKey(req, expected) {
  if (!expected) return false;
  const q = String(req.query.key || "");
  const h = String(req.headers["x-cron-key"] || "");
  const auth = String(req.headers["authorization"] || "");
  if (q && q === expected) return true;
  if (h && h === expected) return true;
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7) === expected) return true;
  return false;
}

export default async function handler(req, res) {
  try {
    if (!checkCronKey(req, CRON_KEY)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const ymd = String(req.query?.ymd || req.body?.ymd || "").trim();
    if (!ymd) {
      return res.status(400).json({ ok: false, error: "missing_ymd" });
    }
    const debugMode = String(req.query?.debug || req.body?.debug || "") === "1";
    const combinedKey = `vb:day:${ymd}:combined`;
    const sources = [
      combinedKey,
      `vb:day:${ymd}:am`,
      `vb:day:${ymd}:pm`,
      `vb:day:${ymd}:late`,
      `vb:day:${ymd}:union`,
    ];
    const collected = [];
    const perKeyCounts = {};
    const knownFlavors = ["vercel-kv", "upstash-redis"];
    const backends = kvBackends();
    for (const key of sources) {
      perKeyCounts[key] = { "vercel-kv": 0, "upstash-redis": 0 };
      let chosen = [];
      for (const backend of backends) {
        const { flavor, items } = await kvGETFromBackend(key, backend);
        const count = Array.isArray(items) ? items.length : 0;
        if (knownFlavors.includes(flavor)) {
          perKeyCounts[key][flavor] = count;
        } else {
          perKeyCounts[key][flavor] = count;
        }
        if (!chosen.length && count > 0) {
          chosen = items;
        }
      }
      if (chosen.length) {
        collected.push(...chosen);
      }
    }
    const total_before_dedupe = collected.length;
    const seen = new Set();
    const merged = [];
    for (const item of collected) {
      const rawFixtureId = item?.model?.fixture ?? item?.fixture_id ?? item?.fixture;
      const dedupeKey = rawFixtureId !== undefined && rawFixtureId !== null ? String(rawFixtureId) : "";
      if (dedupeKey) {
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
      }
      merged.push(item);
    }
    const total_after_dedupe = merged.length;
    const wrote = total_after_dedupe > 0;
    if (wrote) {
      await kvSET(combinedKey, merged);
    }
    const response = {
      ok: true,
      ymd,
      wrote,
      total_before_dedupe,
      total_after_dedupe,
    };
    response.totalBeforeDedupe = total_before_dedupe;
    response.totalAfterDedupe = total_after_dedupe;
    if (debugMode) {
      response.perKeyCounts = perKeyCounts;
      response.debug = {
        perKeyCounts,
        totalBeforeDedupe: total_before_dedupe,
        totalAfterDedupe: total_after_dedupe,
        wrote,
      };
    }
    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
