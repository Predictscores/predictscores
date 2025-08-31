// pages/api/value-bets-locked.js
// Adapter za stari Football tab. Čita vbl_* iz KV, bez fallbacka.
// Garantuje pick/selection = string i home/away na vrhu.

export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO;

async function kvGet(key) {
  if (!KV_URL || (!KV_TOKEN && !KV_TOKEN_RO)) return null;
  const token = KV_TOKEN_RO || KV_TOKEN;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.result === "undefined") return null;
    try { return JSON.parse(j.result); } catch { return j.result; }
  } catch { return null; }
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function hourInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  return Number(fmt.formatToParts(d).find(p => p.type === "hour").value);
}
function autoSlot(tz = TZ) {
  const h = hourInTZ(new Date(), tz);
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}
function labelForPick(code){ return code==="1"?"Home":code==="2"?"Away":code==="X"?"Draw":String(code||""); }

function normalize(it) {
  const raw = it?.pick;
  let code = it?.pick_code;
  let pickStr = "";
  if (typeof raw === "string") {
    pickStr = ["1","X","2"].includes(raw) ? labelForPick(raw) : raw;
  } else if (raw && typeof raw === "object") {
    code = code || raw.code;
    pickStr = raw.label || it?.selection_label || labelForPick(code);
  } else {
    pickStr = it?.selection_label || labelForPick(code);
  }
  const home = it.home || it?.teams?.home || "";
  const away = it.away || it?.teams?.away || "";
  const league_name = it.league_name || it?.league?.name || "";
  const league_country = it.league_country || it?.league?.country || "";
  const price = it?.odds?.price ?? it?.price ?? null;

  return {
    ...it,
    pick: pickStr,
    pick_code: code || it?.pick_code || null,
    selection: pickStr,
    selection_code: code || it?.pick_code || null,
    selection_label: it?.selection_label || pickStr,
    home, away,
    league_name, league_country,
    price,
    books_count: it?.odds?.books_count ?? it?.books_count ?? null,
  };
}

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();

    const full = await kvGet(`vbl_full:${ymd}:${slot}`);
    const slim = await kvGet(`vbl:${ymd}:${slot}`);
    const base = Array.isArray(full) ? full : (Array.isArray(slim) ? slim : []);
    const items = base.map(normalize);

    return res.status(200).json({
      ok: true,
      slot,
      value_bets: items,
      football: items,
      items,
      source: `vb-locked:kv:${Array.isArray(base) ? "hit" : "miss"}·ymd:${ymd}`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
