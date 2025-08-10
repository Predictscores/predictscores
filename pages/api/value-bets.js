// FILE: pages/api/value-bets.js
export const config = { api: { bodyParser: false } };

const API_BASE = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY || '';
const TZ = 'Europe/Belgrade';

function yn(x) { return Number.isFinite(+x) ? +x : 0; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function bucket(p) { if (p >= 0.9) return 'TOP'; if (p >= 0.75) return 'High'; if (p >= 0.5) return 'Moderate'; return 'Low'; }

function safeISO(dt) {
  try { return new Date(dt).toISOString(); } catch { return null; }
}

function baseModel(f) {
  // vrlo lagan model da se UI ne isprazni: koristi league rank (ako postoji) + home adv
  const home = 0.45, draw = 0.25, away = 0.30;
  let pick = '1', p = home;
  if (away > home && away > draw) { pick = '2'; p = away; }
  else if (draw > home && draw > away) { pick = 'X'; p = draw; }
  return { pick, prob: p };
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: { 'x-apisports-key': API_KEY },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, json, raw: text };
}

export default async function handler(req, res) {
  const debug = req.url.includes('debug=1');
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;

  const debugLog = { date: today, attempts: [] };

  let fixtures = [];
  // Primarni pokušaj: svi mečevi sa današnjim datumom (API-Football)
  const r1 = await apiGet('/fixtures', { date: today, timezone: TZ });
  debugLog.attempts.push({ step: 'fixtures?date', status: r1.status, ok: r1.ok, count: r1.json?.response?.length ?? 0 });

  if (r1.ok && Array.isArray(r1.json?.response)) {
    fixtures = r1.json.response;
  }

  // Ako i dalje prazno, probaj from-to raspon unutar dana
  if (!fixtures.length) {
    const from = `${today}`;
    const to = `${today}`;
    const r2 = await apiGet('/fixtures', { from, to, timezone: TZ });
    debugLog.attempts.push({ step: 'fixtures?from-to', status: r2.status, ok: r2.ok, count: r2.json?.response?.length ?? 0 });
    if (r2.ok && Array.isArray(r2.json?.response)) fixtures = r2.json.response;
  }

  // Ako baš ništa — isporuči prazan set, ali sa debugom
  if (!fixtures.length) {
    if (debug) {
      return res.status(200).json({ value_bets: [], generated_at: new Date().toISOString(), debug: debugLog });
    }
    return res.status(200).json({ value_bets: [], generated_at: new Date().toISOString() });
  }

  // Pretvori u naš format
  const picks = fixtures.map(f => {
    const homeName = f?.teams?.home?.name || 'Home';
    const awayName = f?.teams?.away?.name || 'Away';
    const leagueName = f?.league?.name || 'League';
    const fixtureTime = f?.fixture?.date || null;

    const mdl = baseModel(f);
    const confPct = Math.round(clamp(mdl.prob, 0, 1) * 100);

    return {
      fixture_id: f?.fixture?.id ?? null,
      market: '1X2',
      selection: mdl.pick,
      type: 'FALLBACK',            // dok ne spojimo market odds
      model_prob: mdl.prob,
      market_odds: null,
      edge: null,
      datetime_local: {
        starting_at: {
          date_time: fixtureTime, // ISO (provider vraća ISO)
        }
      },
      teams: {
        home: { id: f?.teams?.home?.id ?? null, name: homeName },
        away: { id: f?.teams?.away?.id ?? null, name: awayName },
      },
      league: {
        id: f?.league?.id ?? null,
        name: leagueName,
      },
      confidence_pct: confPct,
      confidence_bucket: bucket(mdl.prob),
      _score: confPct, // najjednostavnije rangiranje
    };
  });

  // Rangiraj i skrati (top 10)
  const out = picks.sort((a, b) => (b?._score ?? 0) - (a?._score ?? 0)).slice(0, 10);

  if (debug) {
    return res.status(200).json({
      value_bets: out,
      generated_at: new Date().toISOString(),
      debug: debugLog
    });
  }
  return res.status(200).json({ value_bets: out, generated_at: new Date().toISOString() });
}
