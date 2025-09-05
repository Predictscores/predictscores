// pages/api/cron/rebuild.js
// Automatski napravi dnevni union i Combined tako da UI (Football/Combined tab) NIKAD ne ostane prazan.
// Redosled:
// 1) probaj iz vbl:<YMD>:{am,pm,late}
// 2) ako prazno → pozovi /api/score-sync?ymd=<YMD> i ponovi (jer score-sync može da popuni podatke)
// 3) ako i dalje prazno → fallback na vb:day:<YMD>:last (lista ili pointer na vbl:*)
// Na kraju UVEK postavi:
//   vb:day:<YMD>:union  = union (lista)
//   vb:day:<YMD>:last   = union (LISTA, radi UI kompatibilnosti)
//   vb:day:<YMD>:combined = Top 3 iz union-a

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
  if (typeof val === "string" && val.trim().startsWith("[")) {
    try { return JSON.parse(val); } catch {}
  }
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
    if (arr.length) chunks.push(...arr); // ← obavezno spread; nema ".arr"
  }
  return dedupeBySignature(chunks);
}

async function tryScoreSync(base, ymd) {
  try {
    const r = await fetch(`${base}/api/score-sync?ymd=${encodeURIComponent(ymd)}`, { cache: "no-store" });
    await r.text(); // nije bitan sadržaj
  } catch {}
}

async function getUnionFromLast(ymd) {
  // last može biti LISTA ili STRING (pointer ka vbl:<YMD>:slot)
  const lastVal = await kvGetJSON(`vb:day:${ymd}:last`);
  if (Array.isArray(lastVal)) return dedupeBySignature(lastVal);
  if (typeof lastVal === "string") {
    const arr = await readArrayKey(String(lastVal));
    if (arr.length) return dedupeBySignature(arr);
  }
  return [];
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymd = url.searchParams.get("ymd") || ymdInTZ("Europe/Belgrade");
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const base = `${proto}://${req.headers.host}`;

    // 1) probaj union iz slotova
    let union = await buildUnionFromSlots(ymd);

    // 2) ako je prazan → pozovi score-sync pa probaj opet slotove
    if (!union.length) {
      await tryScoreSync(base, ymd);
      union = await buildUnionFromSlots(ymd);
    }

    // 3) ako i dalje prazan → uzmi iz :last (lista ili pointer)
    if (!union.length) {
      union = await getUnionFromLast(ymd);
    }

    // 4) upiši union, last(=lista), combined
    await kvSetJSON(`vb:day:${ymd}:union`, union);
    await kvSetJSON(`vb:day:${ymd}:last`, union);       // LISTA — kompatibilno sa UI
    const combined = top3Combined(union);
    await kvSetJSON(`vb:day:${ymd}:combined`, combined);

    res.status(200).json({
      ok: true,
      ymd,
      counts: { union: union.length, last: union.length, combined: combined.length },
      note: "Ako union ostane 0, proveri da li score-sync za taj YMD generiše kandidatae ili koristi drugi dan (UTC vs CEST).",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
