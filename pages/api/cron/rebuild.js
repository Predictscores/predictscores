// pages/api/cron/rebuild.js
// Svrha: zaključaj dnevni set u vbl:<YMD>:<slot> tačno onako kako želi UI.
// Umesto "širine", ovde pozivamo /api/value-bets sa istim parametrima kao /api/football:
//   - limit=15
//   - max_per_league (iz ENV, default 2)
//   - trusted=1 (po ENV; ako nema named kvota, /api/value-bets već ima fallback na aggregate)
//   - ban regex (širok; možeš pregaziti BAN_LEAGUES u ENV)
//   - markets=1X2,Match Winner
//
// Posle ovoga Combined uzima TOP 3 iz zaključanog (vbl), a Football tab prikazuje 15 iz istog seta.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// default ban – Women/U-lige/Youth/Reserves/PL2 itd.
const BAN_DEFAULT =
  "(Women|Womens|Girls|Fem|U1[0-9]|U2[0-9]|U-?1[0-9]|U-?2[0-9]|Under-?\\d+|Reserve|Reserves|B Team|B-Team|II|Youth|Academy|Development|Premier League 2|PL2|Friendly|Friendlies|Club Friendly|Test|Trial)";

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd  || "") || ymdInTZ(new Date(), TZ));

    // isti parametri kao /api/football
    const ban           = encodeURIComponent(process.env.BAN_LEAGUES || BAN_DEFAULT);
    const trusted       = encodeURIComponent(String(process.env.ODDS_TRUSTED_ONLY || "1") === "1" ? "1" : "0");
    const maxPerLeague  = encodeURIComponent(clampInt(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10));
    const markets       = encodeURIComponent("1X2,Match Winner");

    const url = `${baseUrl(req)}/api/value-bets?slot=${slot}&ymd=${ymd}`
              + `&limit=15&max_per_league=${maxPerLeague}`
              + `&trusted=${trusted}&ban=${ban}&markets=${markets}`;

    // 1) povuci finalni spisak za slot
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      return res.status(200).json({ ok: false, slot, ymd, count: 0, football: [], source: "value-bets:error" });
    }
    const j = await r.json().catch(() => null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

    // 2) upiši u locked ključ (vbl:<YMD>:<slot>) kao JSON string top-level niza
    const key = `vbl:${ymd}:${slot}`;
    await kvSetJSON(key, arr);

    return res.status(200).json({
      ok: true,
      slot,
      ymd,
      count: arr.length,
      football: arr,
      source: `rebuild->${j?.source || "value-bets"}`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ============== storage helpers ============== */

async function kvSetJSON(key, arr) {
  const valueJSON = JSON.stringify(Array.isArray(arr) ? arr : []);
  // primary: KV
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: valueJSON }),
      });
      if (r.ok) return true;
    } catch {}
  }
  // fallback: Upstash
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UP_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: valueJSON }),
      });
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

/* ============== misc helpers ============== */

function baseUrl(req) {
  const host = String(req.headers?.host || "").trim();
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}
function normalizeSlot(s) {
  const x = String(s || "").toLowerCase();
  return ["am", "pm", "late"].includes(x) ? x : "pm";
}
function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return (s.split(",")[0] || s).trim();
}
function normalizeYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}
function clampInt(v, defVal, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defVal;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
