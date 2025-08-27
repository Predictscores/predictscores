// pages/api/value-bets.js
// Minimalni "seed" value-bets po slotu.
// - Kada je REFRESH_ODDS_DISABLED=1 -> cache-only (nema spoljnih poziva)
// - Kada je REFRESH_ODDS_DISABLED=0 -> povlači SAMO fixtures (1 poziv), BEZ /odds,
//   pa rebuild može da zaključava slotove bez rafala API poziva.

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const DISABLED = String(process.env.REFRESH_ODDS_DISABLED || "").trim() === "1";

// API-Football
const AF_BASE = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL;

// Upstash (isti obrazac kao u value-bets-locked)
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
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
function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
function slotOf(date, tz = TZ) {
  // late: 00:00–09:59 ; am: 10:00–14:59 ; pm: 15:00–23:59 (po Srbiji)
  const ds = new Date(date.toLocaleString("en-US", { timeZone: tz }));
  const h = ds.getHours();
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}

async function afJson(path, qs) {
  const url = new URL(AF_BASE.replace(/\/$/, "") + "/" + path.replace(/^\//, ""));
  if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: {
      "x-apisports-key": AF_KEY,
      "x-rapidapi-key": AF_KEY, // ako koristiš rapidapi alias
    },
    cache: "no-store",
  });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    const raw = await r.text().catch(()=> "");
    return { ok:false, status:r.status, raw };
  }
  const j = await r.json();
  return { ok:r.ok, status:r.status, data:j };
}

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase(); // am|pm|late
    const ymd  = ymdInTZ();

    const cacheKey = `vb:${ymd}:${slot}`;
    let value_bets = await kvGet(cacheKey);

    // DISABLED => cache only (ili locked fallback)
    if (DISABLED) {
      if (!Array.isArray(value_bets) || !value_bets.length) {
        const locked = await kvGet(`vbl:${ymd}:${slot}`);
        value_bets = Array.isArray(locked) ? locked : [];
      }
      return res.status(200).json({ ok:true, disabled:true, slot, value_bets, source:"cache-only" });
    }

    // NORMAL MODE => seed iz fixtures (1 poziv), bez /odds
    if (!Array.isArray(value_bets) || value_bets.length === 0) {
      // Povuci današnje + malo sutra (da pokrije prelaze)
      const from = ymd;
      const to   = ymdInTZ(addDays(new Date(), 1));
      const fx = await afJson("/fixtures", { from, to, timezone: TZ });
      const list = Array.isArray(fx?.data?.response) ? fx.data.response : [];

      // Mapiraj u naš "value-bets" shape (bez kvota)
      const mapped = list.map(f => {
        const dt = f?.fixture?.date || null;
        const d  = dt ? new Date(dt) : null;
        const s  = d ? slotOf(d, TZ) : null;

        return {
          fixture_id: f?.fixture?.id ?? null,
          teams: {
            home: { id: f?.teams?.home?.id ?? null, name: f?.teams?.home?.name ?? null },
            away: { id: f?.teams?.away?.id ?? null, name: f?.teams?.away?.name ?? null },
          },
          league: {
            id: f?.league?.id ?? null,
            name: f?.league?.name ?? null,
            country: f?.league?.country ?? null,
            season: f?.league?.season ?? null,
          },
          datetime_local: { starting_at: { date_time: dt }},
          market: null,
          market_label: null,
          selection: null,
          type: "FIXTURE-SEED",
          model_prob: null,
          market_odds: null,
          implied_prob: null,
          edge: null,
          edge_pp: null,
          ev: null,
          movement_pct: 0,
          confidence_pct: 0,
          bookmakers_count: 0,
          bookmakers_count_trusted: 0,
          explain: { summary: "Fixture seed", bullets: [] },
          __slot: s
        };
      }).filter(x => x.__slot === slot); // zadrži samo traženi slot

      value_bets = mapped;
      // kratak TTL cache-a da rebuild može da pročita bez dodatnog poziva
      await kvSet(cacheKey, value_bets, 60 * 10);
    }

    return res.status(200).json({ ok:true, disabled:false, slot, value_bets, source:"fixtures-only" });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e), value_bets: [] });
  }
}
