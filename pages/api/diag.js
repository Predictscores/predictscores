// FILE: pages/api/diag.js

export default async function handler(req, res) {
  try {
    const now = new Date().toISOString();
    const branch = process.env.VERCEL_GIT_COMMIT_REF || 'unknown-branch';
    const commit = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown-sha';

    // Check if key exists (don’t echo full value)
    const hasSportMonks = !!process.env.SPORTMONKS_KEY;
    const hasOdds = !!process.env.ODDS_API_KEY;

    // Simple SportMonks fetch test for today
    let sportmonksResult = null;
    try {
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const url = `https://soccer.sportmonks.com/api/v2.0/fixtures/date/${encodeURIComponent(
        date
      )}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(
        process.env.SPORTMONKS_KEY || ''
      )}&tz=UTC`;

      const resp = await fetch(url);
      const text = await resp.text();
      sportmonksResult = {
        fetch_url: url,
        status: resp.status,
        ok: resp.ok,
        snippet: text.slice(0, 1000), // first 1k chars
      };
    } catch (e) {
      sportmonksResult = { error: e.message };
    }

    return res.status(200).json({
      timestamp: now,
      deploy: {
        branch,
        commit: commit.slice(0, 7),
      },
      env: {
        hasSportMonks,
        hasOdds,
      },
      sportmonksTest: sportmonksResult,
      note: 'If sportmonksTest.ok is false or status is 400/401, there is either bad date formatting or auth issue on SPORTMONKS_KEY.',
    });
  } catch (err) {
    return res.status(500).json({ error: 'diag failed', details: err.message });
  }
}
