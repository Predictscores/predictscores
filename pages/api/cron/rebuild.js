// pages/api/cron/rebuild.js
// Punjenje ključeva za UI sa 15 najboljih (Football) i Top 3 (Combined), uz no-overwrite-when-empty.
// - union iz vbl:<YMD>:{am,pm,late}
// - ako prazno → /api/score-sync?ymd=<YMD>, pa ponovo
// - ako prazno → /api/score-sync?days=3, pa ponovo
// - ako prazno → fallback na vb:day:<YMD>:last (lista ili pointer)
// - ako prazno → pogledaj susedne dane (YMD-1, YMD+1) i filtriraj kickoff u lokalni <YMD>
// - piši samo ako ima >0 stavki; nikad ne prepisuj prazninom
// - vb:day:<YMD>:last  = Top 15 (LISTA)
// - vb:day:<YMD>:combined = Top 3 (LISTA)

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
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`KV pipeline HTTP ${r.status}: ${t}`);
  }
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

function ymdInTZ(tz = "Europe/Belgrade", d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const dd = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${dd}`;
}
function shiftYmd(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0,10);
}

/* ---------- ranking helpers ---------- */

function dedupeBySignature(items = []) {
  const out = []; const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? "";
    const mkt = it.market ?? it.market_label ?? "";
    const sel = it.pick ?? it.selection ?? it.selection_label ?? "";
    const sig = `${fid}::${mkt}::${sel}`;
    if (!seen.has(sig)) { seen.add(sig); out.push(it); }
  }
  return out;
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
function sortByRank(items) {
  return [...items].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
}
function topN(items, n) {
  const sorted = sortByRank(items);
  return sorted.slice(0, Math.max(0, Math.min(n, sorted.length)));
}
function top3(items) { return topN(items, 3); }
function top15(items) { return topN(items, 15); }

/* ---------- IO helpers ---------- */

async function readArrayMaybeJSON(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim().startsWith("[")) { try { return JSON.parse(val); } catch {} }
  return [];
}
async function readArrayKey(key) { return readArrayMaybeJSON(await kvGetJSON(key)); }

async function buildUnionFromSlots(ymd) {
  const slots = ["am", "pm", "late"];
  const cmds = slots.map(s => ["GET", `vbl:${ymd}:${s}`]);
  const out = await kvPipeline(cmds);
  const chunks = [];
  for (let i = 0; i < slots.length; i++) {
    const raw = out?.[i]?.result ?? null;
    if (!raw) continue;
    const arr = await readArrayMaybeJSON(raw);
    if (arr.length) chunks.push(...arr); // OBAVEZNO spread
  }
  return dedupeBySignature(chunks);
}
async function tryHit(url) { try { await fetch(url, { cache: "no-store" }).then(r => r.text()); } catch {} }

function localYmdFromUTC(iso, tz = "Europe/Belgrade") {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const y = parts.find(p => p.type === "year")?.value;
    const m = parts.find(p => p.type === "month")?.value;
    const dd = parts.find(p => p.type === "day")?.value;
    return `${y}-${m}-${dd}`;
  } catch { return null; }
}
function inLocalDay(it, ymd, tz = "Europe/Belgrade") {
  const utc = it?.kickoff_utc || it?.kickoffUTC || it?.kickoffUtc || null;
  if (utc) return localYmdFromUTC(utc, tz) === ymd;
  const k = (it?.kickoff || "").toString();
  return k.length >= 10 ? k.slice(0,10) === ymd : false;
}

async function getUnionFromLast(ymd) {
  const lastVal = await kvGetJSON(`vb:day:${ymd}:last`);
  if (Array.isArray(lastVal) && lastVal.length) return dedupeBySignature(lastVal);
  if (typeof lastVal === "string") {
    const deref = await readArrayKey(String(lastVal));
    if (deref.length) return dedupeBySignature(deref);
  }
  return [];
}
async function getUnionFromAdjacentDaysFiltered(ymd) {
  const days = [shiftYmd(ymd, -1), shiftYmd(ymd, +1)];
  let combined = [];
  for (const d of days) {
    const arr = await buildUnionFromSlots(d);
    if (arr.length) combined.push(...arr.filter(it => inLocalDay(it, ymd, "Europe/Belgrade")));
  }
  return dedupeBySignature(combined);
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymd = url.searchParams.get("ymd") || ymdInTZ("Europe/Belgrade");
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const base = `${proto}://${req.headers.host}`;

    // Sačuvaj stare vrednosti da ih ne pregaziš prazninom
    const oldLast = await kvGetJSON(`vb:day:${ymd}:last`);
    const oldCombined = await kvGetJSON(`vb:day:${ymd}:combined`);

    // 1) union iz slotova
    let union = await buildUnionFromSlots(ymd);

    // 2) auto score-sync za taj YMD
    if (!union.length) {
      await tryHit(`${base}/api/score-sync?ymd=${encodeURIComponent(ymd)}`);
      union = await buildUnionFromSlots(ymd);
    }

    // 3) score-sync sa days (neki tokovi pune samo sa ?days)
    if (!union.length) {
      await tryHit(`${base}/api/score-sync?days=3`);
      union = await buildUnionFromSlots(ymd);
    }

    // 4) fallback na :last (lista ili pointer)
    if (!union.length) {
      union = await getUnionFromLast(ymd);
    }

    // 5) fallback na susedne dane (filtrirano po lokalnom YMD)
    if (!union.length) {
      union = await getUnionFromAdjacentDaysFiltered(ymd);
    }

    // Ako nema ničega — ne diraj postojeće vrednosti
    if (!union.length) {
      const finalLast = Array.isArray(oldLast) ? oldLast : [];
      const finalCombined = Array.isArray(oldCombined) ? oldCombined : [];
      return res.status(200).json({
        ok: true,
        ymd,
        mutated: false,
        counts: {
          union: 0,
          last: Array.isArray(finalLast) ? finalLast.length : 0,
          combined: Array.isArray(finalCombined) ? finalCombined.length : 0,
        },
        note: "no candidates → keys NOT mutated",
      });
    }

    // Imamo unose → pripremi Top 15 i Top 3
    const unionDedupe = dedupeBySignature(union);
    const lastTop15 = top15(unionDedupe);     // Football tab traži 15 najboljih
    const combinedTop3 = top3(unionDedupe);   // Combined tab 3 najbolja

    // Upis (LISTE, ne pointeri)
    await kvSetJSON(`vb:day:${ymd}:union`, unionDedupe);
    await kvSetJSON(`vb:day:${ymd}:last`, lastTop15);
    await kvSetJSON(`vb:day:${ymd}:combined`, combinedTop3);

    return res.status(200).json({
      ok: true,
      ymd,
      mutated: true,
      counts: {
        union: unionDedupe.length,
        last: lastTop15.length,
        combined: combinedTop3.length,
      },
      note: "keys updated (last=Top15, combined=Top3)",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
