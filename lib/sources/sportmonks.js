// FILE: lib/sources/sportmonks.js

const BASE = 'https://api.sportmonks.com/v3/football';

/**
 * Fetch next up to `limit` upcoming fixtures (state_id = 1)
 */
export async function fetchUpcomingFixtures(limit = 10, retries = 3, baseDelay = 500) {
  const apiKey = process.env.SPORTMONKS_KEY;
  if (!apiKey) throw new Error("Missing SPORTMONKS_KEY env var");

  const buildUrl = () =>
    `${BASE}/fixtures` +
    `?api_token=${encodeURIComponent(apiKey)}` +
    `&filters=fixtureStates:1` +
    `&include=participants;league` +
    `&sort=starting_at` +
    `&page[size]=${limit}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(buildUrl());
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    // retry logic on 5xx...
    if (res.status >= 500 && res.status < 600 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, baseDelay * (attempt + 1)));
      continue;
    }
    throw new Error(`SportMonks upcoming fetch failed ${res.status}: ${text}`);
  }
  throw new Error("Exhausted SportMonks upcoming retries");
}
