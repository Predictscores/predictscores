// pages/api/cron/rebuild.js
// Cilj: NIKADA ne ostavljati UI bez predloga zbog praznog rebuild-a.
// - Gradi union iz vbl:<YMD>:{am,pm,late}
// - Ako prazno: automatski poziva /api/score-sync?ymd=<YMD> pa ponovi
// - Ako opet prazno: proba /api/score-sync?days=3 pa ponovi
// - Ako opet prazno: fallback na vb:day:<YMD>:last (lista ili pointer)
// - Ako opet prazno: proba sutrašnje slotove i filtrira na lokalni <YMD>
// - Na kraju: ključeve upisuje SAMO ako ima > 0 stavki; inače NE menja postojeće (no-overwrite-when-empty)

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
    if (arr.length) chunks.push(...arr); // OBAVEZNO spread; nikakav ".arr"
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

/* ---------- handler ---------- */

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymd = url.searchParams.get("ymd") || ymdInTZ("Europe/Belgrade");
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const base = `${proto}://${req.headers.host}`;

    // Sačuvaj stare vrednosti da ih NE pregaziš kad je union prazan:
    const oldLast = await kvGetJSON(`vb:day:${ymd}:last`);
    const oldCombined = await kvGetJSON(`vb:day:${ymd}:combined`);

    // 1) probaj slotove za YMD
    let union = await buildUnionFromSlots(ymd);

    // 2) ako prazno → auto score-sync za taj YMD
    if (!union.length) {
      await tryHit(`${base}/api/score-sync?ymd=${encodeURIComponent(ymd)}`);
      union = await buildUnionFromSlots(ymd);
    }

    // 3) ako prazno → probaj i varijantu sa days (neki tokovi pune samo sa ?days)
    if (!union.length) {
      await tryHit(`${base}/api/score-sync?days=3`);
      union = await buildUnionFromSlots(ymd);
    }

    // 4) ako prazno → fallback na vb:day:<YMD>:last (lista ili pointer)
    if (!union.length) {
      if (Array.isArray(oldLast) && oldLast.length) {
        union = dedupeBySignature(oldLast);
      } else if (typeof oldLast === "string") {
        const deref = await readArrayKey(String(oldLast));
        if (deref.length) union = dedupeBySignature(deref);
      }
    }

    // 5) ako prazno → sutrašnji slotovi filtrirani na lokalni današnji YMD
    if (!union.length) {
      const ymdPlus = shiftYmd(ymd, +1);
      const fromTomorrow = await buildUnionFromSlots(ymdPlus);
      const filtered = fromTomorrow.filter(it => inLocalDay(it, ymd, "Europe/Belgrade"));
      if (filtered.length) union = dedupeBySignature(filtered);
    }

    // 6) PISANJE: samo ako ima > 0 stavki. Ako nema — NIŠTA se ne menja (no-overwrite-when-empty).
    let mutated = false;
    if (union.length > 0) {
      await kvSetJSON(`vb:day:${ymd}:union`, union);
      await kvSetJSON(`vb:day:${ymd}:last`, union);       // LISTA (UI očekuje listu)
      const combined = top3Combined(union);
      await kvSetJSON(`vb:day:${ymd}:combined`, combined);
      mutated = true;
    }

    // Brojke za odgovor (bez obzira da li smo pisali ili ne):
    const finalLast = mutated ? union : (Array.isArray(oldLast) ? oldLast : []);
    const finalCombined = mutated ? top3Combined(union) : (Array.isArray(oldCombined) ? oldCombined : []);
    const resp = {
      ok: true,
      ymd,
      mutated, // true ako smo ažurirali ključeve; false ako smo ih ostavili netaknute
      counts: {
        union: union.length,
        last: Array.isArray(finalLast) ? finalLast.length : 0,
        combined: Array.isArray(finalCombined) ? finalCombined.length : 0,
      },
      note: mutated ? "keys updated" : "no candidates → keys NOT mutated (preserved previous values)",
    };

    res.status(200).json(resp);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
