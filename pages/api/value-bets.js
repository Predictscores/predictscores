// pages/api/value-bets.js
// Izvor za "meke" value-bets po slotu. Kada je REFRESH_ODDS_DISABLED=1, NE pravi spoljne pozive
// (npr. ka API-Football), već vraća samo ono što je u internom cache-u ili locked feedu.

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const DISABLED = String(process.env.REFRESH_ODDS_DISABLED || "").trim() === "1";

// Upstash (isti kao u value-bets-locked)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvGet(key) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      cache: "no-store",
    });
    const j = await r.json().catch(() => null);
    if (j && j.result) {
      try { return JSON.parse(j.result); } catch { return j.result; }
    }
    return null;
  }
  globalThis.__VB ||= Object.create(null);
  return globalThis.__VB[key] ?? null;
}

async function kvSet(key, value, ttlSeconds = 60 * 30) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value, ttl: ttlSeconds }),
    }).catch(()=>{});
    return true;
  }
  globalThis.__VB ||= Object.create(null);
  globalThis.__VB[key] = value;
  return true;
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return s.split(",")[0] || s; // YYYY-MM-DD
}

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase(); // am|pm|late
    const ymd = ymdInTZ();

    // 1) prvo probaj interni cache value-bets-a po slotu (ako ga koristiš)
    const cacheKey = `vb:${ymd}:${slot}`;
    let value_bets = await kvGet(cacheKey);

    // 2) ako je disabled, vrati samo postojeće (ili fallback na locked), bez ikakvih spoljnih poziva
    if (DISABLED) {
      if (!Array.isArray(value_bets) || !value_bets.length) {
        const locked = await kvGet(`vbl:${ymd}:${slot}`);
        value_bets = Array.isArray(locked) ? locked : [];
      }
      return res.status(200).json({ ok: true, disabled: true, slot, value_bets, source: "cache-only" });
    }

    // 3) NORMALNI MOD (nije disabled): ovde bi išli tvoji postojeći spoljašnji pozivi (fixtures/odds)
    //    Pošto želiš "bez trošenja" dok ne sredimo sve ostalo, zadržaćemo cache-only i u normalnom modu
    //    ako već ima podataka. Ako nema, vrati prazan (sigurno).
    if (!Array.isArray(value_bets)) value_bets = [];

    // (opciono) minimalan pokušaj osvežavanja iz locked-a, da se bar nešto vidi
    if (value_bets.length === 0) {
      const locked = await kvGet(`vbl:${ymd}:${slot}`);
      value_bets = Array.isArray(locked) ? locked : [];
      if (value_bets.length) await kvSet(cacheKey, value_bets, 60 * 10);
    }

    return res.status(200).json({ ok: true, disabled: false, slot, value_bets, source: "cache-first" });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e), value_bets: [] });
  }
}
