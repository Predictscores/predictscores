// FILE: lib/sources/sportmonks.js

const BASE = 'https://api.sportmonks.com/v3/football';

/**
 * Fetch next up to `limit` upcoming fixtures (state_id = 1 → Not Started).
 * Includes participants & league so možemo odmah mapirati timove.
 */
export async function fetchUpcomingFixtures(limit = 10, retries = 3, baseDelay = 500) {
  const apiKey = process.env.SPORTMONKS_KEY;
  if (!apiKey) throw new Error("Missing SPORTMONKS_KEY env var");

  // Stavke filteri: state_id:1 znači “Not Started”
  const buildUrl = () =>
    `${BASE}/fixtures` +
    `?api_token=${encodeURIComponent(apiKey)}` +
    `&filters=state_id:1` +
    `&include=participants;league` +
    `&sort=starting_at` +
    `&page[size]=${limit}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(buildUrl());
    const text = await res.text();
    if (res.ok) {
      return JSON.parse(text);
    }
    // Retry na 5xx greške
    if (res.status >= 500 && res.status < 600 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, baseDelay * (attempt + 1)));
      continue;
    }
    throw new Error(`SportMonks upcoming fetch failed ${res.status}: ${text}`);
  }
  throw new Error("Unreachable: exhausted SportMonks upcoming retries");
}
