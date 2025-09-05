// pages/api/score-sync.js
// Svrha: priprema kandidata za history/settle tako da :last bude LISTA.
// Više ne puca na pointer; sam napravi union i normalizuje :last.
// Radi za 1–14 dana unazad ili za konkretan ?ymd=YYYY-MM-DD.

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
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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
async function kvSetJSON(key, obj) {
  return kvSet(key, JSON.stringify(obj));
}

function isPointerString(x) {
  return (
    typeof x === "string" &&
    /^vb:day:\d{4}-\d{2}-\d{2}:(am|pm|late|union)$/.test(x)
  );
}
function dedupeBySignature(items = []) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? "";
    const mkt = it.market ?? it.market_label ?? "";
    const sel = it.pick ?? it.selection ?? it.selection_label ?? "";
    const sig = `${fid}::${mkt}::${sel}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(it);
    }
  }
  return out;
}

async function readDayListLastOrNull(ymd) {
  const lastKey = `vb:day:${ymd}:last`;
  const last = await kvGetJSON(lastKey);
  if (Array.isArray(last)) return last;

  if (isPointerString(last)) {
    const deref = await kvGetJSON(String(last));
    if (Array.isArray(deref)) return deref;
  }

  if (typeof last === "string") {
    const s = last.trim();
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }
  return null;
}

async function buildDayUnion(ymd) {
  const slots = ["am", "pm", "late"];
  const chunks = [];
  for (const slot of slots) {
    const arr = await kvGetJSON(`vbl:${ymd}:${slot}`);
    if (Array.isArray(arr) && arr.length) chunks.push(...arr);
  }
  return dedupeBySignature(chunks);
}

async function writeDayLastAsList(ymd, list) {
  const arr = dedupeBySignature(Array.isArray(list) ? list : []);
  await kvSetJSON(`vb:day:${ymd}:last`, arr);
  await kvSetJSON(`vb:day:${ymd}:union`, arr);
  return arr.length;
}

async function ensureDayLastIsList(ymd) {
  const existing = await readDayListLastOrNull(ymd);
  if (existing && existing.length) {
    await kvSetJSON(`vb:day:${ymd}:union`, dedupeBySignature(existing));
    return existing.length;
  }
  const union = await kvGetJSON(`vb:day:${ymd}:union`);
  if (Array.isArray(union) && union.length) {
    return writeDayLastAsList(ymd, union);
  }
  const built = await buildDayUnion(ymd);
  return writeDayLastAsList(ymd, built);
}

function kvEnvInfo() {
  const { url, token } = kvEnv();
  return { url: url ? `${url.slice(0, 32)}…` : null, hasToken: Boolean(token) };
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymdParam = url.searchParams.get("ymd");
    const days = Math.max(1, Math.min(14, parseInt(url.searchParams.get("days") || "1", 10)));

    const today = new Date();
    const ymds = [];
    if (ymdParam) {
      ymds.push(ymdParam);
    } else {
      for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        ymds.push(d.toISOString().slice(0, 10));
      }
    }

    const byDay = [];
    let totalCandidates = 0;

    for (const ymd of ymds) {
      const ensured = await ensureDayLastIsList(ymd);
      const last = await readDayListLastOrNull(ymd);
      const count = Array.isArray(last) ? last.length : 0;
      totalCandidates += count;
      byDay.push({ ymd, ensured, candidates: count });
    }

    res.status(200).json({
      ok: true,
      totalCandidates,
      days: ymds.length,
      byDay,
      kv: kvEnvInfo(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
