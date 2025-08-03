// pages/api/football.js

/**
 * Kombinovani fudbalski predikcioni endpoint.
 * Izvlači sa:
 *   - API-Football (api-football / api-sports.io)
 *   - Sportmonks
 * Pravi konsenzus: za svaki meč i market (npr. 1X2, BTTS, HT/FT) uzima se pick koji se slaže u najmanje 2 izvora.
 * Confidence je prosečna confidence vrednost iz složenih izvora.
 * Fallback stub je prisutan ako nema konsenzusa.
 */

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const SPORTMONKS_KEY = process.env.SPORTMONKS_KEY;

const STUB_PREDICTIONS = [
  {
    match: 'FC Dynamo vs Red Stars',
    prediction: '1X2: 1',
    odds: '1.95',
    confidence: 85,
    sources: ['stub'],
  },
  {
    match: 'River City vs Blue United',
    prediction: 'BTTS: Yes',
    odds: '1.72',
    confidence: 78,
    sources: ['stub'],
  },
  {
    match: 'Valley Rangers vs Mountain FC',
    prediction: 'HT/FT: X/2',
    odds: '3.10',
    confidence: 66,
    sources: ['stub'],
  },
];

// helper: group by match+market+pick
function keyFor(p) {
  return `${p.match}||${p.market}||${p.pick}`;
}

function deriveConsensus(preds) {
  const map = {};
  preds.forEach((p) => {
    const k = keyFor(p);
    if (!map[k]) {
      map[k] = { ...p, count: 0, confidences: [], odds: [], sources: [] };
    }
    map[k].count += 1;
    map[k].confidences.push(p.confidence || 0);
    if (p.odds !== undefined && p.odds !== null) map[k].odds.push(p.odds);
    map[k].sources.push(p.source);
  });

  const results = [];
  Object.values(map).forEach((entry) => {
    if (entry.count < 2) return; // need at least 2 sources agreeing
    const avgConfidence =
      entry.confidences.reduce((a, b) => a + b, 0) / (entry.confidences.length || 1);
    const odds = entry.odds.length ? entry.odds[0] : null;
    results.push({
      match: entry.match,
      prediction: `${entry.market}: ${entry.pick}`,
      odds,
      confidence: Math.round(avgConfidence),
      sources: Array.from(new Set(entry.sources)),
    });
  });

  // sort by confidence desc
  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, 3);
}

// ---- Fetchers ----

async function fetchFromAPIFootball() {
  if (!API_FOOTBALL_KEY) return [];
  try {
    // 1. fetch upcoming fixtures (next 10)
    const fixturesRes = await fetch(
      'https://v3.football.api-sports.io/fixtures?next=10',
      {
        headers: {
          'x-apisports-key': API_FOOTBALL_KEY,
        },
      }
    );
    if (!fixturesRes.ok) return [];
    const fxJson = await fixturesRes.json();
    const fixtures = (fxJson.response || []).map((f) => f.fixture).filter(Boolean);
    const preds = [];

    // for each fixture, get predictions
    await Promise.all(
      (fxJson.response || []).map(async (item) => {
        try {
          const fixture = item.fixture;
          const teams = item.teams;
          const matchName = `${teams.home.name} vs ${teams.away.name}`;

          const predRes = await fetch(
            `https://v3.football.api-sports.io/predictions?fixture=${fixture.id}`,
            {
              headers: {
                'x-apisports-key': API_FOOTBALL_KEY,
              },
            }
          );
          if (!predRes.ok) return;
          const predJson = await predRes.json();
          const arr = predJson.response || [];
          if (!arr.length) return;

          const predictionBlock = arr[0].predictions || {};

          // 1X2
          if (predictionBlock['1x2']) {
            const pickKey = predictionBlock['1x2'].winner; // 'home'|'draw'|'away'
            let pickLabel = null;
            if (pickKey === 'home') pickLabel = '1';
            else if (pickKey === 'draw') pickLabel = 'X';
            else if (pickKey === 'away') pickLabel = '2';
            if (pickLabel) {
              const rawConfidence = predictionBlock['1x2'].percentage?.[pickKey] ?? null;
              const oddsObj = predictionBlock['1x2'].odds || {};
              const odds = oddsObj[pickKey] || null;
              preds.push({
                match: matchName,
                market: '1X2',
                pick: pickLabel,
                odds,
                confidence: rawConfidence ? Math.round(rawConfidence) : 0,
                source: 'api-football',
              });
            }
          }

          // BTTS
          if (predictionBlock['both_to_score']) {
            const pickKey = predictionBlock['both_to_score'].winner; // 'yes'/'no'
            const pickLabel = pickKey === 'yes' ? 'Yes' : 'No';
            const rawConfidence =
              predictionBlock['both_to_score'].percentage?.[pickKey] ?? null;
            const oddsObj = predictionBlock['both_to_score'].odds || {};
            const odds = oddsObj[pickKey] || null;
            preds.push({
              match: matchName,
              market: 'BTTS',
              pick: pickLabel,
              odds,
              confidence: rawConfidence ? Math.round(rawConfidence) : 0,
              source: 'api-football',
            });
          }

          // HT/FT
          if (predictionBlock['half_time_full_time']) {
            const pickKey = predictionBlock['half_time_full_time'].winner; // e.g., 'X/2'
            const pickLabel = pickKey || null;
            const rawConfidence =
              predictionBlock['half_time_full_time'].percentage?.[pickKey] ?? null;
            const oddsObj = predictionBlock['half_time_full_time'].odds || {};
            const odds = oddsObj[pickKey] || null;
            if (pickLabel) {
              preds.push({
                match: matchName,
                market: 'HT/FT',
                pick: pickLabel,
                odds,
                confidence: rawConfidence ? Math.round(rawConfidence) : 0,
                source: 'api-football',
              });
            }
          }
        } catch (e) {
          // ignore per-fixture error
          console.warn('api-football per-fixture parse error', e.message);
        }
      })
    );

    return preds;
  } catch (e) {
    console.warn('api-football fetch error', e.message);
    return [];
  }
}

async function fetchFromSportmonks() {
  if (!SPORTMONKS_KEY) return [];
  try {
    // timeframe: today + next 1 day
    const now = new Date();
    const from = now.toISOString().split('T')[0];
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const to = tomorrow.toISOString().split('T')[0];

    // Example endpoint - adjust include params based on your Sportmonks plan
    const url = `https://soccer.sportmonks.com/api/v2.0/fixtures/between/${from}/${to}?api_token=${SPORTMONKS_KEY}&include=odds,localTeam,visitorTeam`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.data || !Array.isArray(json.data)) return [];
    const out = [];

    json.data.slice(0, 15).forEach((f) => {
      const home = f.localTeam?.data?.name || 'Home';
      const away = f.visitorTeam?.data?.name || 'Away';
      const matchName = `${home} vs ${away}`;

      // Parse odds object - structure may vary by your plan.
      // Here we attempt to extract 1X2 and BTTS if present.
      const oddsWrapper = f.odds?.data || [];
      // For simplicity, we mock a few predictions based on available odds if structure unknown.
      // Real implementation should inspect f.odds.data contents and map to markets.

      // Example: if there's a "1X2" market in oddsWrapper
      oddsWrapper.forEach((market) => {
        const marketName = (market.name || '').toLowerCase();
        if (marketName.includes('1x2')) {
          // assume market has odds array
          (market?.odds || []).forEach((o) => {
            // o might have label '1','X','2' and value
            const pick = o.label;
            const oddsVal = o.price || o.value || null;
            // dummy confidence derived from implied probability
            let confidence = 0;
            if (oddsVal) {
              const implied = 1 / parseFloat(oddsVal);
              confidence = Math.min(100, Math.round((1 - implied) * 100));
            }
            out.push({
              match: matchName,
              market: '1X2',
              pick,
              odds: oddsVal,
              confidence,
              source: 'sportmonks',
            });
          });
        } else if (marketName.includes('both to score') || marketName.includes('btts')) {
          // BTTS
          (market?.odds || []).forEach((o) => {
            const pick = o.label; // Yes/No
            const oddsVal = o.price || o.value || null;
            let confidence = 0;
            if (oddsVal) {
              const implied = 1 / parseFloat(oddsVal);
              confidence = Math.min(100, Math.round((1 - implied) * 100));
            }
            out.push({
              match: matchName,
              market: 'BTTS',
              pick,
              odds: oddsVal,
              confidence,
              source: 'sportmonks',
            });
          });
        }
        // HT/FT could be similar if available
      });
    });

    return out;
  } catch (e) {
    console.warn('sportmonks fetch error', e.message);
    return [];
  }
}

export default async function handler(req, res) {
  try {
    // Debug loaded keys existence (does not log values)
    console.log('football API keys loaded:', {
      apiFootball: !!API_FOOTBALL_KEY,
      sportmonks: !!SPORTMONKS_KEY,
    });

    // Fetch in parallel
    const [apiFootballPreds, sportmonksPreds] = await Promise.all([
      fetchFromAPIFootball(),
      fetchFromSportmonks(),
    ]);

    const allPreds = [...apiFootballPreds, ...sportmonksPreds];

    // Derive consensus (needs at least 2 sources matching same match+market+pick)
    const consensus = deriveConsensus(allPreds);

    // If no consensus, fallback to stub
    const footballTop = consensus.length ? consensus : STUB_PREDICTIONS;

    return res.status(200).json({
      footballTop,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Football API error:', err);
    return res.status(500).json({
      error: 'Failed to get football predictions',
      detail: err.message,
    });
  }
}
