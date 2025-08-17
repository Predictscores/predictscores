// =============================================
// Sigurna dijagnostika (maskira tajne)
// Proverava da li rute vide isti KV i postojeće ključeve
// =============================================

function mask(s) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= 12) return str;
  return `${str.slice(0, 6)}...${str.slice(-6)}`;
}

function unwrapKV(raw) {
  let v = raw;
  try {
    if (typeof v === "string") {
      const p = JSON.parse(v);
      if (p && typeof p === "object" && "value" in p) {
        v = p.value;
      } else {
        v = p;
      }
    }
    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
      v = JSON.parse(v);
    }
  } catch (_) {}
  return v;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const KV_URL = process.env.KV_REST_API_URL || "";
    const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";
    const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    async function kvGetRaw(key) {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      }).catch(() => null);
      if (!r || !r.ok) return null;
      const j = await r.json().catch(() => null);
      return j?.result ?? null;
    }

    const revRaw = await kvGetRaw(`vb:day:${today}:rev`);
    const lastRaw = await kvGetRaw(`vb:day:${today}:last`);

    const rev = unwrapKV(revRaw);
    const last = unwrapKV(lastRaw);

    return res.status(200).json({
      ok: true,
      env: {
        KV_REST_API_URL: mask(KV_URL),
        KV_REST_API_TOKEN: mask(KV_TOKEN),
        TZ,
      },
      today,
      rev_raw_type: typeof revRaw,
      rev_raw_preview:
        typeof revRaw === "string" ? `${revRaw.slice(0, 60)}...` : revRaw,
      rev_unwrapped: rev,
      last_raw_type: typeof lastRaw,
      last_raw_preview:
        typeof lastRaw === "string" ? `${lastRaw.slice(0, 60)}...` : lastRaw,
      last_unwrapped_type: typeof last,
      last_unwrapped_preview: Array.isArray(last?.value_bets)
        ? `array(${last.value_bets.length})`
        : typeof last === "string"
        ? `${last.slice(0, 60)}...`
        : last,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
