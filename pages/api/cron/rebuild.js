// pages/api/cron/rebuild.js
// Gradi dnevni union iz vbl:<YMD>:{am,pm,late}, snima ga u vb:day:<YMD>:union,
// UVEK postavlja vb:day:<YMD>:last kao LISTU (isti taj union, radi kompatibilnosti sa UI),
// i snima Top 3 snapshot u vb:day:<YMD>:combined.

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
    if (Array.isArray(arr) && arr.length) chunks.push(...arr); // ispravka: spread, nema ".arr"
  }
  return dedupeBySignature(chunks);
}

async function buildUnionWithFallback(ymd) {
  // 1) probaj iz slotova
  let union = await buildUnionFromSlots(ymd);
  if (union.length > 0) return union;

  // 2) fallback: ako postoji vb:day:<YMD>:last kao lista — uzmi je;
  //    ako je string/pointer, dereferenciraj pa uzmi listu
  const lastRaw = await kvGetJSON(`vb:day:${ymd}:last`);
  if (Array.isArray(lastRaw) && lastRaw.length) {
    return dedupeBySignature(lastRaw);
  }
  if (typeof lastRaw === "string") {
    // može biti pointer ka vbl:<YMD>:slot
    const deref = await readArrayKey(String(lastRaw));
    if (Array.isArray(deref) && deref.length) {
      return dedupeBySignature(deref);
    }
  }
  return [];
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymd = url.searchParams.get("ymd") || new Date().toISOString().slice(0, 10);

    // 1) napravi union (sa fallbackom)
    const union = await buildUnionWithFallback(ymd);

    // 2) snimi union
    await kvSetJSON(`vb:day:${ymd}:union`, union);

    // 3) UVEK postavi :last kao LISTU (kompatibilnost sa UI koji čita listu)
    await kvSetJSON(`vb:day:${ymd}:last`, union);

    // 4) Top 3 (Combined) snapshot
    const combined = top3Combined(union);
    await kvSetJSON(`vb:day:${ymd}:combined`, combined);

    res.status(200).json({
      ok: true,
      ymd,
      counts: { union: union.length, combined: combined.length, last: union.length },
      hint: "UI čita vb:day:<YMD>:last kao LISTU; Combined = vb:day:<YMD>:combined; learning koristi vb:day:<YMD>:union.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
