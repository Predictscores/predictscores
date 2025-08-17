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

    async function kvGet(key) {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      }).catch(() => null);
      if (!r || !r.ok) return null;
      const j = await r.json().catch(() => null);
      return j?.result ?? null;
    }

    const rev = await kvGet(`vb:day:${today}:rev`);
    const last = await kvGet(`vb:day:${today}:last`);

    return res.status(200).json({
      ok: true,
      env: {
        KV_REST_API_URL: mask(KV_URL),
        KV_REST_API_TOKEN: mask(KV_TOKEN),
        TZ,
      },
      today,
      rev,
      last_type: last && typeof last,
      last_preview:
        last && typeof last === "string"
          ? `${last.slice(0, 40)}...`
          : last && last.value_bets
          ? `array(${last.value_bets.length})`
          : last,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
