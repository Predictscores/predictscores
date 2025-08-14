// FILE: pages/api/cron/scheduler.js
export const config = { api: { bodyParser: false } };

/**
 * Dispatcher za Hobby (max 2 Vercel cron joba):
 * - Na svakih 5 min proverava Beograd vreme.
 * - Uz KV "lock" ključeve (NX + EX) obezbeđuje da se svaka meta-tačka okine SAMO jednom.
 * - Ne troši AF pozive (poziva tvoje interne API-je).
 *
 * ENV očekivanja:
 *  - KV_REST_API_URL / KV_URL / UPSTASH_REDIS_REST_URL
 *  - KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN
 *  - CRON_SCHEDULER_OFF=1 (opciono, gasi dispatcher)
 */

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const WINDOW_MIN = Number(process.env.SCHEDULER_MINUTE_WINDOW || 4); // dozvoljeni prozor (min) zbog 5-min crona

// Upstash REST (bez dodatnih dependencija)
function kvCreds() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.KV_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_READ_ONLY_TOKEN;
  return { url, token };
}

async function kvSetNX(key, ttlSec = 86400) {
  const { url, token } = kvCreds();
  if (!url || !token) return false;

  // Upstash REST: POST {["SET", key, "1", "NX", "EX", ttl]}
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["SET", key, "1", "NX", "EX", ttlSec]),
  }).catch(() => null);

  if (!r) return false;
  const j = await r.json().catch(() => ({}));
  // Rezultat: { result: "OK" } kada je set uspeo (NX = true), ili null kada već postoji
  return j?.result === "OK";
}

function belgradeNowParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const s = fmt.format(now); // "YYYY-MM-DD HH:MM"
  const [date, hm] = s.split(" ");
  const [H, M] = hm.split(":").map((x) => Number(x));
  return { date, H, M, hm };
}

function mins(h, m) {
  return h * 60 + m;
}
function diffNowTo(targetHM, H, M) {
  const [tH, tM] = targetHM.split(":").map((x) => Number(x));
  return mins(H, M) - mins(tH, tM); // >0 znači posle targeta
}

async function triggerInternal(req, path) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  const origin = `${proto}://${host}`;
  const url = `${origin}${path}`;
  return fetch(url, { headers: { "x-internal-cron": "1" } });
}

export default async function handler(req, res) {
  try {
    if (String(process.env.CRON_SCHEDULER_OFF || "") === "1") {
      return res.status(200).json({ ok: true, skipped: "CRON_SCHEDULER_OFF=1" });
    }

    const { date, H, M, hm } = belgradeNowParts();
    const slots = [
      // insights-build
      { time: "08:05", key: "insights", path: "/api/insights-build" },
      { time: "13:05", key: "insights", path: "/api/insights-build" },
      // locked-floats
      { time: "14:30", key: "locked", path: "/api/locked-floats" },
      { time: "17:30", key: "locked", path: "/api/locked-floats" },
      // learning-build
      { time: "22:30", key: "learning", path: "/api/learning-build" },
    ];

    const matches = [];
    for (const s of slots) {
      const d = diffNowTo(s.time, H, M);
      // pogodak ako smo u intervalu [0 .. WINDOW_MIN]
      if (d >= 0 && d <= WINDOW_MIN) {
        matches.push(s);
      }
    }

    const fired = [];
    for (const m of matches) {
      const lockKey = `cron:${m.key}:${date}:${m.time}`;
      // TTL dovoljno dug da pokrije eventualno kašnjenje (npr. 1 dan)
      const got = await kvSetNX(lockKey, 26 * 3600);
      if (got) {
        await triggerInternal(req, m.path);
        fired.push({ ...m, lockKey });
      }
    }

    return res.status(200).json({
      ok: true,
      now: { tz: TZ, hm, date },
      windowMin: WINDOW_MIN,
      matched: matches,
      triggered: fired,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
        }
