// pages/api/cron/rebuild.js
// Robusno punjenje dnevnih ključeva za UI (Football/Combined) uz "no-overwrite-when-empty":
// - Gradi union iz vbl:<YMD>:{am,pm,late}
// - Ako prazno → /api/score-sync?ymd=<YMD>, pa ponovo
// - Ako prazno → /api/score-sync?days=3, pa ponovo
// - Ako prazno → fallback na vb:day:<YMD>:last (lista ili pointer)
// - Ako prazno → pogleda susedne dane (YMD-1, YMD+1) i zadrži mečeve čiji kickoff_utc po Europe/Belgrade upada u <YMD>
// - Na kraju: piše vb:day:<YMD>:union/last/combined SAMO ako ima >0 stavki. Ako nema → NE dira postojeće ključeve.

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

/* ---------- helpers ---------- */

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

    // Sačuvaj stare vrednosti (da ih NE pregaziš prazninom)
    const oldLast = await kvGetJSON(`vb:day:${ymd}:last`);
    const oldCombined = await kvGetJSON(`vb:day:${ymd}:combined`);

    // 1) slotovi za YMD
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

    // 6) PISANJE: samo ako ima > 0 stavki (no-overwrite-when-empty)
    let mutated = false;
    if (union.length > 0) {
      await kvSetJSON(`vb:day:${ymd}:union`, union);
      await kvSetJSON(`vb:day:${ymd}:last`, union);       // LISTA (UI očekuje listu)
      const combined = top3Combined(union);
      await kvSetJSON(`vb:day:${ymd}:combined`, combined);
      mutated = true;
    }

    // Brojke za odgovor (uvek)
    const finalLast = mutated ? union : (Array.isArray(oldLast) ? oldLast : []);
    const finalCombined = mutated ? top3Combined(union) : (Array.isArray(oldCombined) ? oldCombined : []);
    return res.status(200).json({
      ok: true,
      ymd,
      mutated,
      counts: {
        union: union.length,
        last: Array.isArray(finalLast) ? finalLast.length : 0,
        combined: Array.isArray(finalCombined) ? finalCombined.length : 0,
      },
      note: mutated ? "keys updated" : "no candidates → keys NOT mutated",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
