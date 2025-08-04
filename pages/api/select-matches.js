// FILE: pages/api/select-matches.js

const SPORTMONKS_BASE = 'https://soccer.sportmonks.com/api/v2.0';
const SPORTMONKS_KEY = process.env.SPORTMONKS_KEY;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuta cache po datumu

let cache = {
  date: null,
  timestamp: 0,
  data: null,
};

function formatLocalDatetimeFromSportMonks(fixture) {
  try {
    let utcDate;

    if (fixture.starting_at) {
      // Preferiraj timestamp ako postoji (najstabilnije)
      if (fixture.starting_at.timestamp) {
        utcDate = new Date(fixture.starting_at.timestamp * 1000);
      } else if (fixture.starting_at.date_time) {
        // Zameni razmak sa T i dodaj Z da bi bio ISO UTC
        const iso = fixture.starting_at.date_time.replace(' ', 'T') + 'Z';
        utcDate = new Date(iso);
      } else if (fixture.starting_at.date) {
        // fallback na date-only
        utcDate = new Date(fixture.starting_at.date);
      }
    }

    if (!utcDate || isNaN(utcDate.getTime())) {
      return 'Invalid Date';
    }

    const formatter = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/Belgrade',
    });
    let formatted = formatter.format(utcDate);
    formatted = formatted.replace(/\/\d{4}/, '').trim(); // ukloni godinu
    return formatted;
  } catch (e) {
    return 'Invalid Date';
  }
}

// Very simple placeholder model for probabilities
function deriveSimpleProbabilities(fixture) {
  // Ovde možeš kasnije zameniti pravim modelom.
  const home = 0.45;
  const draw = 0.25;
  const away = 0.3;
  const btts_probability = 0.4;
  const over25_probability = 0.323;

  const predicted =
    home >= draw && home >= away
      ? 'home'
      : draw >= home && draw >= away
      ? 'draw'
      : 'away';

  const sorted = [
    { key: 'home', val: home },
    { key: 'draw', val: draw },
    { key: 'away', val: away },
  ].sort((a, b) => b.val - a.val);
  const confidence = Math.round((sorted[0].val - sorted[1].val) * 100); // razlika najboljeg i drugog

  return {
    model_probs: {
      home: Number(home.toFixed(2)),
      draw: Number(draw.toFixed(2)),
      away: Number(away.toFixed(2)),
    },
    predicted,
    confidence,
    btts_probability,
    over25_probability,
  };
}

export default async function handler(req, res) {
  try {
    const { date: rawDate } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const date = rawDate && typeof rawDate === 'string' ? rawDate : today;

    const now = Date.now();
    if (cache.date === date && now - cache.timestamp < CACHE_TTL_MS && cache.data) {
      return res.status(200).json(cache.data);
    }

    if (!SPORTMONKS_KEY) {
      return res.status(500).json({ error: 'Missing SPORTMONKS_KEY env var' });
    }

    const fixturesUrl = `${SPORTMONKS_BASE}/fixtures/date/${encodeURIComponent(
      date
    )}?api_token=${encodeURIComponent(SPORTMONKS_KEY)}&include=localTeam,visitorTeam,league`;

    const fRes = await fetch(fixturesUrl);
    if (!fRes.ok) {
      const text = await fRes.text();
      return res.status(500).json({
        error: 'Failed fetching from sportmonks',
        status: fRes.status,
        body: text,
      });
    }
    const raw = await fRes.json();
    const fixtures = raw.data || [];

    // debug: log da vidiš da se pravi novi poziv
    console.log(`select-matches: fetched ${fixtures.length} fixtures for date=${date}`);

    const picks = fixtures.map((fixture) => {
      const {
        model_probs,
        predicted,
        confidence,
        btts_probability,
        over25_probability,
      } = deriveSimpleProbabilities(fixture);

      const teams = {
        home: {
          id: fixture.localTeam?.data?.id || fixture.localteam_id || null,
          name: fixture.localTeam?.data?.name || null,
        },
        away: {
          id: fixture.visitorTeam?.data?.id || fixture.visitorteam_id || null,
          name: fixture.visitorTeam?.data?.name || null,
        },
      };

      return {
        fixture_id: fixture.id,
        league: {
          id: fixture.league?.data?.id || null,
          name: fixture.league?.data?.name || null,
        },
        teams,
        venue: {
          name: fixture.venue || null,
        },
        datetime_local: formatLocalDatetimeFromSportMonks(fixture),
        model_probs,
        predicted,
        confidence,
        btts_probability,
        over25_probability,
        rankScore: confidence,
      };
    });

    const output = {
      picks,
      debug: {
        date,
        sourceUsed: 'sportmonks',
        total_fetched: fixtures.length,
        raw_source: raw,
      },
    };

    cache = {
      date,
      timestamp: now,
      data: output,
    };

    return res.status(200).json(output);
  } catch (err) {
    console.error('select-matches error:', err);
    return res.status(500).json({
      error: 'internal error',
      details: err.message,
    });
  }
}
