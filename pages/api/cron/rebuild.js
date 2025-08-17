// pages/api/cron/rebuild.js
// Rebuild pinned liste: pozove generator (/api/value-bets), isfiltrira/skrati i upiše
// i rev ključ i "last" pointer u KV tako da /value-bets-locked odmah vidi snapshot.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const VB_LIMIT = parseInt(process.env.VB_LIMIT || "25", 10);

function fmtDate(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d).replace(/\//g, "-");
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KV_TOKEN}`,
    },
    body: JSON.stringify({ value: typeof value === "string" ? value : JSON.stringify(value) }),
  });
  await r.json().catch(()=>null);
  return true;
}

function perLeagueCap(list, maxPerLeague = 2) {
  const kept = [];
  const cnt = new Map();
  for (const p of list) {
    const lg = p?.league?.name || p?.league_name || "Unknown";
    const n = cnt.get(lg) || 0;
    // UEFA izuzetak – može više po brief-u:
    const isUEFA = /UEFA|Champions|Europa|Conference/i.test(lg);
    if (!isUEFA && n >= maxPerLeague) continue;
    kept.push(p);
    cnt.set(lg, n + 1);
    if (kept.length >= VB_LIMIT) break;
  }
  return kept;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const today = fmtDate(new Date(), TZ);

    // (opciono) time-guard: radi rebuild samo posle 10:00 lokalno
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
    const h = parseInt(parts.hour, 10);
    if (h < 10) {
      return res.status(200).json({ ok: true, snapshot_for: today, count: 0, rev: await kvGet(`vb:day:${today}:rev`) || 0, note: "before-10" });
    }

    // Pozovi generator (isti host) – ovo pravi AF pozive
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const base = `${proto}://${host}`;

    const gen = await fetch(`${base}/api/value-bets`, { cache: "no-store" }).then(r => r.json()).catch(()=>null);
    const list = Array.isArray(gen?.value_bets) ? gen.value_bets : [];

    // Sort/filter (po potrebi) i skrati na VB_LIMIT + max 2 po ligi (UEFA izuzetak)
    const chosen = perLeagueCap(list, 2).slice(0, VB_LIMIT);

    // REV brojač
    const revKey = `vb:day:${today}:rev`;
    const currentRev = Number(await kvGet(revKey) || 0);
    const rev = currentRev + 1;
    await kvSet(revKey, String(rev));

    // Upis snapshot-a pod rev i pod "last" pointer
    await kvSet(`vb:day:${today}:rev:${rev}`, chosen);
    await kvSet(`vb:day:${today}:last`, chosen);

    return res.status(200).json({ ok: true, snapshot_for: today, count: chosen.length, rev });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
