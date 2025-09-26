process.env.KV_REST_API_URL = "https://kv.example";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.KV_REST_API_READ_ONLY_TOKEN = "";

const realFetch = global.fetch;

jest.mock("../../../../lib/sources/apiFootball", () => ({
  afxTeamStats: jest.fn(),
  afxInjuries: jest.fn(),
  afxH2H: jest.fn(),
  afxReadBudget: jest.fn(),
}));

const {
  afxTeamStats,
  afxInjuries,
  afxH2H,
  afxReadBudget,
} = require("../../../../lib/sources/apiFootball");
const handler = require("../../../../pages/api/cron/enrich").default;

function createMockRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      return this;
    },
  };
}

describe("/api/cron/enrich budget guard", () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "test-token";
    process.env.KV_REST_API_READ_ONLY_TOKEN = "";

    afxTeamStats.mockReset();
    afxInjuries.mockReset();
    afxH2H.mockReset();
    afxReadBudget.mockReset();
  });

  afterEach(() => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_READ_ONLY_TOKEN;

    if (realFetch) {
      global.fetch = realFetch;
    } else {
      delete global.fetch;
    }
  });

  it("stops immediately when the API budget reports zero remaining", async () => {
    const lockedItems = [
      {
        fixture_id: 101,
        teams: { home_id: 1, away_id: 2 },
        league: { id: 55, season: 2024 },
      },
      {
        fixture_id: 102,
        teams: { home_id: 3, away_id: 4 },
        league: { id: 55, season: 2024 },
      },
    ];

    const kvWrites = [];

    global.fetch = jest.fn(async (url, options = {}) => {
      if (url.includes("/api/value-bets-locked")) {
        return {
          ok: true,
          json: async () => ({ items: lockedItems }),
        };
      }
      if (url.startsWith("https://kv.example/set/")) {
        kvWrites.push({ url, options });
        return { ok: true, text: async () => "" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    afxReadBudget.mockResolvedValue(0);

    const req = { query: { slot: "am" }, headers: { host: "test.local" } };
    const res = createMockRes();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledTimes(1); // only the locked picks read
    expect(kvWrites).toHaveLength(0);
    expect(afxTeamStats).not.toHaveBeenCalled();
    expect(afxInjuries).not.toHaveBeenCalled();
    expect(afxH2H).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toMatchObject({
      enriched: 0,
      budget_exhausted: true,
      budget_remaining: 0,
      budget_stop_reason: "exhausted",
    });
  });

  it("processes fixtures until the budget drops to zero", async () => {
    const lockedItems = [
      {
        fixture_id: 201,
        teams: { home_id: 11, away_id: 22 },
        league: { id: 60, season: 2024 },
      },
      {
        fixture_id: 202,
        teams: { home_id: 33, away_id: 44 },
        league: { id: 60, season: 2024 },
      },
    ];

    const kvWrites = [];

    global.fetch = jest.fn(async (url, options = {}) => {
      if (url.includes("/api/value-bets-locked")) {
        return {
          ok: true,
          json: async () => ({ items: lockedItems }),
        };
      }
      if (url.startsWith("https://kv.example/set/")) {
        kvWrites.push({ url, options });
        return { ok: true, text: async () => "" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    afxReadBudget.mockResolvedValueOnce(500).mockResolvedValueOnce(0);
    afxTeamStats.mockResolvedValue({ response: {} });
    afxInjuries.mockResolvedValue({ response: [] });
    afxH2H.mockResolvedValue({ response: [] });

    const req = { query: { slot: "am" }, headers: { host: "test.local" } };
    const res = createMockRes();

    await handler(req, res);

    // locked picks fetch + two kv writes (meta + list)
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(kvWrites).toHaveLength(2);
    expect(afxTeamStats).toHaveBeenCalledTimes(2);
    expect(afxInjuries).toHaveBeenCalledTimes(2);
    expect(afxH2H).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toMatchObject({
      enriched: 1,
      enriched_full: 1,
      budget_exhausted: true,
      budget_remaining: 0,
      budget_stop_reason: "exhausted",
    });
  });
});

