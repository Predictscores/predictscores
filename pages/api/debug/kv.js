// pages/api/debug/kv.js
// Brzi debug KV okruženja i inspekcija ključa (?key=...).

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

function kvEnvInfo() {
  const { url, token } = kvEnv();
  return { url: url ? `${url.slice(0, 32)}…` : null, hasToken: Boolean(token) };
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.searchParams.get("key");

    const value = key ? await kvGetJSON(key) : null;
    const isArray =
      Array.isArray(value) ? value.length : (typeof value === "string" ? (value.trim().startsWith("[") && value.trim().endsWith("]") ? "string-looks-like-array" : false) : false);

    res.status(200).json({
      ok: true,
      kv: kvEnvInfo(),
      inspectedKey: key || null,
      isArray,
      value:
        typeof value === "string" && value.length > 500
          ? value.slice(0, 500) + "…"
          : value,
      hint:
        "Za dan: ?key=vb:day:YYYY-MM-DD:last (treba da bude LISTA). Ako je string/pointer, pozovi /api/score-sync?ymd=YYYY-MM-DD ili /api/history-check?days=3.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
