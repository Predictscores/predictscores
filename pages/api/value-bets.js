// pages/api/value-bets-locked.js
// KV-only adapter za Combined/Football tab. NEMA fallbacka na rebuild.
// Podržava ?full=1 (vraća vbl_full), inače vbl. pick/selection su STRING; home/away top-level.

export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";
const KV_URL = process.env.KV_REST_API_URL;
const KV_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_RW = process.env.KV_REST_API_TOKEN || KV_RO;

async function kvGet(key) {
  if (!KV_URL || (!KV_RW && !KV_RO)) return null;
  const token = KV_RO || KV_RW;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.result === "undefined") return null;
    try { return JSON.parse(j.result); } catch { return j.result; }
  } catch {
    return null;
  }
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(d);
}
function hourInTZ(d = new Date(), tz = TZ) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  return Number(f.formatToParts(d).find(p => p.type === "hour").value);
}
function autoSlot(tz = TZ) { const h = hourInTZ(new Date(), tz); if (h < 10) return "late"; if (h < 15) return "am"; return "pm"
; }
function labelFor(k) { return k === "1" ? "Home" : k === "2" ? "Away" : k === "X" ? "Draw" : String(k || ""); }

function normalize(it) {
  const raw = it?.pick; let code = it?.pick_code; let pickStr = "";
  if (typeof raw === "string") {
    pickStr = ["1","X","2"].includes(raw) ? labelFor(raw) : raw;
  } else if (raw && typeof raw === "object") {
    code = code || raw.code;
    pickStr = raw.label || it?.selection_label || labelFor(code);
  } else {
    pickStr = it?.selection_label || labelFor(code);
  }
  const home = it.home || it?.teams?.home || "";
  const away = it.away || it?.teams?.away || "";
  const league_name = it.league_name || it?.league?.name || "";
  const league_country = it.league_country || it?.league?.country || "";
  const price = it?.odds?.price ?? it?.price ?? null;
  const books_count = it?.odds?.books_count ?? it?.books_count ?? null;

  return {
    ...it,
    pick: pickStr,
    pick_code: code || it?.pick_code || null,
    selection: pickStr,
    selection_code: code || it?.pick_code || null,
    selection_label: it?.selection_label || pickStr,
    home, away,
    league_name, league_country,
    price, books_count,
  };
}

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const full = String(req.query.full || "") === "1";
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();

    const keyFull = `vbl_full:${ymd}:${slot}`;
    const keySlim = `vbl:${ymd}:${slot}`;

    // ako traže slim, prvo slim pa fallback na full; ako traže full, samo full
    let arr = full ? await kvGet(keyFull) : await kvGet(keySlim);
    if (!Array.isArray(arr) && !full) arr = await kvGet(keyFull);

    const base = Array.isArray(arr) ? arr : [];
    const items = base.map(normalize);

    return res.status(200).json({
      ok: true,
      slot, ymd,
      value_bets: items,  // Combined/Football čitaju ovo
      football: items,    // alias
      items,              // alias
      source: `vb-locked:kv:${items.length ? "hit" : "miss"}·${full ? "full" : "slim"}`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
