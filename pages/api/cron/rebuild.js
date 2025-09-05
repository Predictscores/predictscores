// pages/api/cron/rebuild.js
// Održava dnevni union iz vbl:<YMD>:{am,pm,late} i snima Top 3 snapshot u vb:day:<YMD>:combined.
// Ako union ispadne prazan, koristi fallback iz vb:day:<YMD>:last (pointer ili lista).
// Opcioni ?slot=am|pm|late postavlja vb:day:<YMD>:last kao POINTER na odgovarajući vbl:<...> ključ.

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

async function kvGet(key) {
  const out = await kvPipeline([["GET", key]]);
  return out?.[0]?.result ?? null;
}
async function kvSet(key, val) {
  const out = await kvPipeline([["SET", key, val]]);
  return out?.[0]?.result ?? "OK";
}
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

function dedupeBySignature(items = []) {
  const out = [];
  const seen = new Set();
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
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  });
  const out = [];
  const seenFixtures = new Set();
  for (const it of byRank) {
    const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? it?.fixture?.id ?? null;
    if (fid != null && seenFixtures.has(fid)) continue;
    out.push(it);
    if (fid != null) seenFixtures.add(fid);
    if (out.length >= 3) break;
  }
  return out;
}

function isPointerToSlot(x, ymd) {
  return typeof x === "string" && new RegExp(`^vbl:${ymd}:(am|pm|late)$`).test(x);
}

async function readArrayKey(key) {
  const val = await kvGetJSON(key);
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim().startsWith("[")) {
    try { return JSON.parse(val); } catch {}
  }
  return [];
}

async function buildUnionFromSlots(ymd) {
  const slots = ["am", "pm", "late"];
  const cmds = slots.map(s => ["GET", `vbl:${ymd}:${s}`]);
  const out = await kvPipeline(cmds);
  const chunks = [];
  for (let i = 0; i < slots.length; i++) {
    const raw = out?.[i]?.result ?? null;
    if (!raw) continue;
    let arr = [];
    if (Array.isArray(raw)) arr = raw;
    else if (typeof raw === "string" && raw.trim().startsWith("[")) { try { arr = JSON.parse(raw); } catch {} }
    if (Array.isArray(arr) && arr.length) chunks.push(...arr); // ⬅️ ispravka: nema ".arr"
  }
  return dedupeBySignature(chunks);
}

async function buildUnionWithFallback(ymd) {
  let union = await buildUnionFromSlots(ymd);
  if (union.length > 0) return union;

  // fallback iz :last (pointer ili lista)
  const last = await kvGet(`vb:day:${ymd}:last`);
  if (isPointerToSlot(last, ymd)) {
    const list = await readArrayKey(String(last));
    union = dedupeBySignature(list);
  } else {
    const maybeList = await kvGetJSON(`vb:day:${ymd}:last`);
    if (Array.isArray(maybeList)) union = dedupeBySignature(maybeList);
  }
  return union;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymd = url.searchParams.get("ymd") || new Date().toISOString().slice(0, 10);
    const slot = url.searchParams.get("slot"); // am|pm|late (opciono)

    // 1) napravi union (sa fallbackom na :last)
    const union = await buildUnionWithFallback(ymd);
    await kvSetJSON(`vb:day:${ymd}:union`, union);

    // 2) Top 3 (Combined) snapshot
    const combined = top3Combined(union);
    await kvSetJSON(`vb:day:${ymd}:combined`, combined);

    // 3) (opciono) postavi :last kao POINTER na slot
    if (slot && ["am", "pm", "late"].includes(slot)) {
      await kvSet(`vb:day:${ymd}:last`, `vbl:${ymd}:${slot}`);
    }

    res.status(200).json({
      ok: true,
      ymd,
      counts: { union: union.length, combined: combined.length },
      hint: "History koristi vb:day:<YMD>:combined; learning koristi vb:day:<YMD>:union.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
