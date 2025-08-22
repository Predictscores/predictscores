// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGetJSON(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(() => null);
  const val = js && "result" in js ? js.result : js;
  try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return null; }
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

export default async function handler(req, res) {
  try {
    const ymd = ymdInTZ();
    const items = (await kvGetJSON(`vb:day:${ymd}:last`)) || [];
    const meta  = (await kvGetJSON(`vb:meta:${ymd}:last_meta`)) || {};

    if (!Array.isArray(items)) {
      return res.status(200).json({ ok: true, ymd, source: "last", built_at: null, items: [] });
    }

    const enriched = await Promise.all(items.map(async (p) => {
      const fixtureId = p?.fixture_id ?? p?.fixture?.id ?? p?.id;
      const insight = fixtureId ? await kvGetJSON(`vb:insight:${fixtureId}`) : null;
      const bullets = insight?.bullets || [];
      const h2hLine = insight?.h2hLine || null;

      const zasto = bullets.length
        ? `Zašto: ${bullets.join(". ")}.`
        : (p?.explain?.summary || p?.explain || "");

      const forma = h2hLine ? `Forma: H2H ${h2hLine}` : null;

      const explain = {
        ...(p?.explain && typeof p.explain === "object" ? p.explain : {}),
        text: [zasto, forma].filter(Boolean).join("\n")
      };

      return { ...p, explain };
    }));

    return res.status(200).json({
      ok: true,
      ymd,
      source: "last",
      built_at: meta?.built_at || null,
      items: enriched
    });
  } catch (e) {
    return res.status(200).json({ ok: false, ymd: null, source: "last", built_at: null, items: [], error: String(e?.message || e) });
  }
}
