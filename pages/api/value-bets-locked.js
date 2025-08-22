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
  try {
    const js = await r.json();
    return "result" in js ? js.result : js;
  } catch { return null; }
}
async function kvGetJSON(key) {
  const raw = await kvGetRaw(key);
  if (raw == null) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

// pomoæna: od bullets formira "Zašto" i "Forma" redove
function buildExplainText(p) {
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const summary = typeof p?.explain?.summary === "string" ? p.explain.summary : "";

  // bullets mogu imati razne linije; izdvoj "Forma:" i "H2H" u drugi red,
  // ostalo (bez "Forma"/"H2H") ide u Zašto.
  const formaLine = bullets.find(b => /^h2h|^h2h \(l5\)|^forma:/i.test(b?.trim?.() || "") ) || null;
  const whyList   = bullets.filter(b => !/^h2h|^h2h \(l5\)|^forma:/i.test(b?.trim?.() || "") );

  const zasto = whyList.length
    ? `Zašto: ${whyList.join(". ")}.`
    : (summary ? `Zašto: ${summary.replace(/\.$/,"")}.` : "");

  const forma = formaLine
    ? `Forma: ${formaLine.replace(/^forma:\s*/i,"").replace(/^h2h\s*/i,"H2H ").replace(/^h2h \(l5\):\s*/i,"H2H (L5): ")}`
    : "";

  const parts = [zasto, forma].filter(Boolean);
  return parts.join("\n");
}

export default async function handler(req, res) {
  try {
    const ymd  = ymdInTZ();
    const last = (await kvGetJSON(`vb:day:${ymd}:last`)) || [];
    const meta = (await kvGetJSON(`vb:meta:${ymd}:last_meta`)) || {};

    if (!Array.isArray(last)) {
      return res.status(200).json({ ok: true, ymd, source: "last", built_at: null, items: [] });
    }

    // popuni explain.text ako ga nema
    const items = last.map(p => {
      const explain = typeof p?.explain === "object" && p.explain ? { ...p.explain } : {};
      if (!explain.text || !explain.text.trim()) {
        const text = buildExplainText(p);
        if (text) explain.text = text;
      }
      return { ...p, explain };
    });

    return res.status(200).json({
      ok: true, ymd, source: "last",
      built_at: meta?.built_at || null,
      items
    });
  } catch (e) {
    return res.status(200).json({ ok: false, ymd: null, source: "last", built_at: null, items: [], error: String(e?.message || e) });
  }
}
