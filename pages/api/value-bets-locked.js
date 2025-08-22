// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(() => null);
  return js && typeof js === "object" && "result" in js ? js.result : js;
}
async function kvGetJSON(key) {
  const raw = await kvGetRaw(key);
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

export default async function handler(req, res) {
  try {
    const ymd = ymdInTZ();
    const lastKey = `vb:day:${ymd}:last`;
    const metaKey = `vb:meta:${ymd}:last_meta`;
    const payload = (await kvGetJSON(lastKey)) || [];
    const meta    = (await kvGetJSON(metaKey)) || {};

    if (!Array.isArray(payload)) {
      return res.status(200).json({ ok: true, items: [], built_at: null, source: "last", ymd });
    }

    // Enrichment iz insights
    const withInsights = await Promise.all(payload.map(async (p) => {
      const fixtureId = p.fixture_id ?? p.fixture?.id ?? p.id;
      const insight = await kvGetJSON(`vb:insight:${fixtureId}`);
      const bullets  = insight?.bullets || [];
      const h2hLine  = insight?.h2hLine || null;

      const zasto = bullets.length ? `Zašto: ${bullets.join(". ")}.` : (p.explain?.summary || p.explain || "");
      const forma = h2hLine ? `Forma: H2H ${h2hLine}` : null;

      const explain = {
        ...(p.explain || {}),
        text: [zasto, forma].filter(Boolean).join("\n")
      };

      return { ...p, explain };
    }));

    return res.status(200).json({
      ok: true,
      ymd,
      source: "last",
      built_at: meta?.built_at || null,
      items: withInsights
    });
  } catch (e) {
    return res.status(200).json({ ok: false, items: [], error: String(e?.message || e) });
  }
}
