// FILE: lib/sources/sportmonks.js

const BASE = 'https://api.sportmonks.com/v3/football';

/**
 * Fetch fixtures for a given date, with retry/backoff.
 * Uses v3 endpoint and includes participants & league.
 */
export async function fetchSportmonksFixtures(date, retries = 3, baseDelay = 500) {
  const apiKey = process.env.SPORTMONKS_KEY;
  if (!apiKey) throw new Error("Missing SPORTMONKS_KEY env var");

  const buildUrl = () =>
    `${BASE}/fixtures/date/${encodeURIComponent(date)}` +
    `?api_token=${encodeURIComponent(apiKey)}` +
    `&include=participants,league` +
    `&tz=UTC`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = buildUrl();
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) {
        // retry on 5xx
        if (res.status >= 500 && res.status < 600 && attempt < retries - 1) {
          console.warn(`SportMonks ${res.status} on attempt ${attempt + 1}, retrying...`);
          await new Promise((r) => setTimeout(r, baseDelay * (attempt + 1)));
          continue;
        }
        throw new Error(`SportMonks fetch failed ${res.status}: ${text}`);
      }
      return JSON.parse(text);
    } catch (e) {
      const isTransient = /503|500|incorrect request/i.test(e.message);
      if (attempt === retries - 1 || !isTransient) {
        throw new Error(`SportMonks final error: ${e.message}`);
      }
      console.warn(`SportMonks attempt ${attempt + 1} error (transient), retrying: ${e.message}`);
      await new Promise((r) => setTimeout(r, baseDelay * (attempt + 1)));
    }
  }

  throw new Error("Unreachable: exhausted SportMonks retries");
}
