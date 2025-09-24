// pages/api/learning-compare.js

export const config = { api: { bodyParser: false } };

function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL;
  const aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL;
  const bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}

async function kvGET(key, trace = []) {
  for (const b of kvBackends()) {
    try {
      const url = `${b.url}/get/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const value = json && ("result" in json ? json.result : json.value);
      if (value == null) continue;
      trace.push({ get: key, ok: true, flavor: b.flavor, hit: true });
      return value;
    } catch {}
  }
  trace.push({ get: key, ok: true, hit: false });
  return null;
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

function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}

const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
function pickSlotAuto(now){ const h=hourInTZ(now, TZ); return h<10?"late":h<15?"am":"pm"; }

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSamples(samples) {
  if (!samples || typeof samples !== "object") return null;
  const out = {};
  if (samples.calib != null) out.calib = toNumber(samples.calib);
  if (samples.evmin != null) out.evmin = toNumber(samples.evmin);
  if (samples.league != null) out.league = toNumber(samples.league);
  return Object.keys(out).length ? out : null;
}

function mapDiffs(picks) {
  const entries = [];
  for (const pick of picks) {
    if (!pick || typeof pick !== "object") continue;
    const baseline = toNumber(pick.baseline_edge_pp);
    const learned = toNumber(pick.learned_edge_pp);
    if (baseline == null && learned == null) continue;
    const delta = (learned != null && baseline != null)
      ? learned - baseline
      : (learned != null ? learned : 0) - (baseline != null ? baseline : 0);
    entries.push({
      fixture_id: pick.fixture_id ?? null,
      market: pick.market ?? null,
      pick_code: pick.pick_code ?? null,
      baseline_edge_pp: baseline,
      learned_edge_pp: learned,
      delta_edge_pp: Number.isFinite(delta) ? Number(delta.toFixed(3)) : null,
      ev_guard_used: toNumber(pick.ev_guard_used),
      samples_bucket: normalizeSamples(pick.samples),
      buckets: pick.buckets || null,
      passes_ev: typeof pick.passes_ev === "boolean" ? pick.passes_ev : null,
    });
  }
  return entries
    .sort((a, b) => Math.abs(b.delta_edge_pp || 0) - Math.abs(a.delta_edge_pp || 0))
    .slice(0, 15);
}

export default async function handler(req, res) {
  const trace = [];
  try {
    const now = new Date();
    const ymd = String(req.query.ymd || "").trim() || ymdInTZ(now, TZ);
    let slot = String(req.query.slot || "").toLowerCase();
    if (!["late", "am", "pm"].includes(slot)) slot = pickSlotAuto(now);

    const key = `vb:shadow:${ymd}:${slot}`;
    const raw = await kvGET(key, trace);
    const doc = kvToObject(raw);
    if (!doc) {
      return res.status(200).json({
        ok: true,
        ymd,
        slot,
        items: [],
        meta: { missing: true },
        debug: { trace },
      });
    }

    const picksMeta = Array.isArray(doc?.meta?.picks) ? doc.meta.picks : [];
    const diffs = mapDiffs(picksMeta);
    const meta = {
      ymd,
      slot,
      shadow_mode: Boolean(doc?.meta?.shadow_mode),
      flags: doc?.meta?.flags || null,
      generated_at: doc?.meta?.generated_at || null,
      baseline_count: Array.isArray(doc?.baseline) ? doc.baseline.length : null,
      learned_count: Array.isArray(doc?.learned) ? doc.learned.length : null,
    };

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      items: diffs,
      meta,
      debug: { trace },
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
