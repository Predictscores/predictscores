const BASE_MARKETS = {
  btts: { yes: 1.9 },
  ou25: { over: 2.02 },
  fh_ou15: { over: 1.68 },
  htft: { hh: 4.4, dd: 4.0, aa: 6.2 },
  '1x2': { home: 1.95, draw: 3.4, away: 4.2 },
};

const BASE_MODEL = {
  home: 0.55,
  draw: 0.25,
  away: 0.2,
  btts_yes: 0.62,
  ou25_over: 0.58,
  fh_ou15_over: 0.6,
  htft: {
    hh: 0.33,
    dd: 0.28,
    aa: 0.18,
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFixture(id, league, options = {}) {
  const kickoff = new Date(Date.UTC(2024, 7, 1, 12 + (id % 6))).toISOString();
  const fixture = {
    fixture_id: id,
    league: {
      id: league?.id ?? null,
      name: league?.name ?? null,
    },
    teams: {
      home: { id: id * 10 + 1, name: `Home ${id}` },
      away: { id: id * 10 + 2, name: `Away ${id}` },
    },
    kickoff,
    kickoff_utc: kickoff,
    markets: deepClone(BASE_MARKETS),
    model_probs: deepClone(BASE_MODEL),
  };

  if (options.markets) {
    fixture.markets = {
      ...fixture.markets,
      ...options.markets,
    };
    if (options.markets.htft) {
      fixture.markets.htft = {
        ...BASE_MARKETS.htft,
        ...options.markets.htft,
      };
    }
    if (options.markets['1x2']) {
      fixture.markets['1x2'] = {
        ...BASE_MARKETS['1x2'],
        ...options.markets['1x2'],
      };
    }
  }

  if (options.model_probs) {
    fixture.model_probs = {
      ...fixture.model_probs,
      ...options.model_probs,
    };
    if (options.model_probs.htft) {
      fixture.model_probs.htft = {
        ...BASE_MODEL.htft,
        ...options.model_probs.htft,
      };
    }
  }

  if (options.teams) {
    fixture.teams = {
      home: { ...fixture.teams.home, ...options.teams.home },
      away: { ...fixture.teams.away, ...options.teams.away },
    };
  }

  if (options.kickoff) {
    fixture.kickoff = options.kickoff;
    fixture.kickoff_utc = options.kickoff_utc ?? options.kickoff;
  }

  return fixture;
}

const TIER1_LEAGUES = [
  { id: 39, name: 'Premier League' },
  { id: 61, name: 'Ligue 1' },
  { id: 78, name: 'Bundesliga' },
  { id: 135, name: 'Serie A' },
  { id: 140, name: 'La Liga' },
  { id: 2, name: 'Champions League' },
  { id: 3, name: 'Europa League' },
];

const TIER2_LEAGUES = [
  { id: 41, name: 'Championship' },
  { id: 94, name: 'Primeira Liga' },
];

const TIER3_LEAGUE = { id: 501, name: 'National League' };

const tieredFixtures = [
  createFixture(1001, TIER1_LEAGUES[0], {
    model_probs: { home: 0.63, draw: 0.2, away: 0.17, btts_yes: 0.7, ou25_over: 0.66 },
  }),
  createFixture(1002, TIER1_LEAGUES[1], {
    model_probs: { home: 0.6, draw: 0.22, away: 0.18, btts_yes: 0.68, ou25_over: 0.64 },
  }),
  createFixture(1003, TIER1_LEAGUES[2], {
    model_probs: { home: 0.59, draw: 0.23, away: 0.18, btts_yes: 0.67, ou25_over: 0.63 },
  }),
  createFixture(1004, TIER1_LEAGUES[3], {
    model_probs: { home: 0.58, draw: 0.24, away: 0.18, btts_yes: 0.66, ou25_over: 0.62 },
  }),
  createFixture(1005, TIER1_LEAGUES[4], {
    model_probs: { home: 0.6, draw: 0.22, away: 0.18, btts_yes: 0.65, ou25_over: 0.61 },
  }),
  createFixture(1006, TIER1_LEAGUES[5], {
    model_probs: { home: 0.61, draw: 0.21, away: 0.18, btts_yes: 0.69, ou25_over: 0.64 },
  }),
  createFixture(1007, TIER1_LEAGUES[6], {
    model_probs: { home: 0.6, draw: 0.22, away: 0.18, btts_yes: 0.68, ou25_over: 0.63 },
  }),
  createFixture(1008, TIER2_LEAGUES[0], {
    model_probs: { home: 0.53, draw: 0.27, away: 0.2, btts_yes: 0.58, ou25_over: 0.55 },
  }),
  createFixture(1009, TIER2_LEAGUES[1], {
    model_probs: { home: 0.52, draw: 0.27, away: 0.21, btts_yes: 0.57, ou25_over: 0.54 },
  }),
  createFixture(1010, TIER3_LEAGUE, {
    model_probs: { home: 0.5, draw: 0.28, away: 0.22, btts_yes: 0.55, ou25_over: 0.52 },
  }),
];

const denylistedFixture = createFixture(2001, { id: 9001, name: 'Premier League U-19' });

module.exports = {
  tieredFixtures,
  denylistedFixture,
  createFixture,
};
