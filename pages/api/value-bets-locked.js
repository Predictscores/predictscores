// pages/api/value-bets-locked.js
// Adapter za stari UI: čita vbl_* iz KV i garantuje da je `pick` STRING,
// te dodaje top-level `home`/`away`/`league_name`/`league_country`.

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
function labelForPick(code) {
  if (code === "1") return "Home";
  if (code === "2") return "Away";
  if (code === "X") return "Draw";
  return String(code || "");
}

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const ymd = ymdInTZ();

    // Čitaj iz KV (nema NIKAKVOG fallback-a na rebuild)
    const full = await kvGet(`vbl_full:${ymd}:${slot}`);   // puniji
    const slim = await kvGet(`vbl:${ymd}:${slot}`);        // kraći
    let items = Array.isArray(full) ? full : (Array.isArray(slim) ? slim : []);

    // Normalizuj shape za stari front
    items = items.map(it => {
      // pick uvek string
      const raw = it?.pick;
      let code = it?.pick_code;
      let pickStr = "";

      if (typeof raw === "string") {
        if (["1","X","2"].includes(raw)) { code = code || raw; pickStr = labelForPick(code); }
        else { pickStr = raw; }
      } else if (raw && typeof raw === "object") {
        code = code || raw.code;
        pickStr = raw.label || it?.selection_label || labelForPick(code);
      } else {
        pickStr = it?.selection_label || labelForPick(code);
      }

      return {
        ...it,
        pick: pickStr,                                      // <<< front više ne vidi [object Object]
        pick_code: code || it?.pick_code || null,
        home: it.home || it?.teams?.home || "",
        away: it.away || it?.teams?.away || "",
        league_name: it.league_name || it?.league?.name || "",
        league_country: it.league_country || it?.league?.country || "",
      };
    });

    return res.status(200).json({
      ok: true,
      slot,
      value_bets: items,      // ono što Football tab očekuje
      // (za svaki slučaj dodaj i "football" polje – neke verzije UI-a ga čitaju)
      football: items,
      source: `vb-locked:kv·ymd:${ymd}`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
