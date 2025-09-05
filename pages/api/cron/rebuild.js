// pages/api/cron/rebuild.js
// Ovaj endpoint NE generiše pickove, već nakon što slotovi postoje u KV pod vbl:<YMD>:{am,pm,late},
// održava dnevni union i snima snapshot Top 3 u vb:day:<YMD>:combined.
// Ako dobije ?slot=am|pm|late, postavi vb:day:<YMD>:last kao POINTER na odgovarajući vbl:<...> ključ.

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
  // isti duh kao Combined: prioritet confidence_pct, zatim model_prob, zatim _ev_lb, pa _ev
  const c = Number(it?.confidence_pct);    // veće je bolje
  const p = Number(it?.model_prob);
  const evlb = Number(it?._ev_lb);
  const ev = Number(it?._ev);
  // negiramo zbog sortiranja asc kasnije (manje → gore)
  return [
    - (Number.isFinite(c) ? c : -1),
    - (Number.isFinite(p) ? p : -1),
    - (Number.isFinite(evlb) ? evlb : -1),
    - (Number.isFinite(ev) ? ev : -1),
  ];
}
function top3Combined(items) {
  // po defaultu preferiramo različite fixture_id-e (pošto UI Combined obično bira 3 različita meča)
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

async function buildUnion(ymd) {
  const slots = ["am", "pm", "late"];
  const chunks = [];
  const cmds = slots.map((s) => ["GET", `vbl:${ymd}:${s}`]);
  const out = await kvPipeline(cmds);
  for (let i = 0; i < slots.length; i++) {
    const raw = out?.[i]?.result ?? null;
    if (!raw) continue;
    const arr =
      typeof raw === "string" && raw.trim().startsWith("[")
        ? JSON.parse(raw)
        : Array.isArray(raw)
        ? raw
        : [];
    if (arr.length) chunks.push(...arr);
  }
  return dedupeBySignature(chunks);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymd = url.searchParams.get("ymd") || new Date().toISOString().slice(0, 10);
    const slot = url.searchParams.get("slot"); // "am" | "pm" | "late" (opciono)

    // 1) napravi/refreshuj union za dan
    const union = await buildUnion(ymd);
    await kvSetJSON(`vb:day:${ymd}:union`, union);

    // 2) snimi Combined (Top 3) snapshot
    const combined = top3Combined(union);
    await kvSetJSON(`vb:day:${ymd}:combined`, combined);

    // 3) po želji, postavi :last kao POINTER na aktuelni slot (ako je prosleđen)
    if (slot && ["am", "pm", "late"].includes(slot)) {
      await kvSet(`vb:day:${ymd}:last`, `vbl:${ymd}:${slot}`);
    }

    res.status(200).json({
      ok: true,
      ymd,
      counts: { union: union.length, combined: combined.length },
      hint: "History koristi samo vb:day:<YMD>:combined; learn koristi vb:day:<YMD>:union.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
