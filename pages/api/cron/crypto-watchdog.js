// pages/api/cron/crypto-watchdog.js
// Watchdog proxy: triggers the crypto builder endpoint and reports its status.

const UPSTREAM_PATH = "/api/cron/crypto-build";

export default async function handler(req, res) {
  const expected = process.env.CRON_KEY || "";
  if (!checkCronKey(req, expected)) {
    return res.status(401).json({ ok: false, reason: "bad key" });
  }
  if (!expected) {
    return res.status(500).json({ ok: false, error: "cron_key_missing" });
  }

  const baseUrl = resolveBaseUrl(req);
  const url = new URL(UPSTREAM_PATH, baseUrl);
  url.searchParams.set("key", expected);
  url.searchParams.set("debug", "1");

  try {
    const response = await fetch(url.toString(), {
      headers: { "x-watchdog": "crypto" },
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (response.ok) {
      return res.status(200).json({
        ok: true,
        upstream: body,
        status: response.status,
        url: `${url.pathname}${url.search}`,
      });
    }

    return res.status(200).json({
      ok: false,
      upstream: {
        status: response.status,
        body,
      },
      url: `${url.pathname}${url.search}`,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

function checkCronKey(req, expected) {
  if (!expected) return false;
  const q = String(req?.query?.key || "");
  const h = String(req?.headers?.["x-cron-key"] || "");
  const auth = String(req?.headers?.["authorization"] || "");
  if (q && q === expected) return true;
  if (h && h === expected) return true;
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7) === expected) return true;
  return false;
}

function resolveBaseUrl(req) {
  const protoHeader =
    req?.headers?.["x-forwarded-proto"] || req?.headers?.["x-forwarded-protocol"] || req?.protocol || "https";
  const proto = String(protoHeader).split(",")[0].trim() || "https";
  const hostHeader = req?.headers?.["x-forwarded-host"] || req?.headers?.host || "";
  const host = String(hostHeader).split(",")[0].trim();
  if (!host) {
    return "http://localhost:3000";
  }
  return `${proto}://${host}`;
}
