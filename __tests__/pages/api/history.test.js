const sampleHistoryPayload = {
  history: [
    {
      fixture_id: "fx-histday-1",
      market_key: "h2h",
      pick: "home",
      result: "win",
      price_snapshot: 1.9,
    },
  ],
};

const combinedHistoryPayload = {
  history: [
    {
      fixture_id: "fx-combined-1",
      market_key: "h2h",
      pick: "away",
      result: "win",
      price_snapshot: 2.4,
    },
  ],
};

const realFetch = global.fetch;

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

describe("API history day loaders", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.HISTORY_ALLOWED_MARKETS = "h2h";
    process.env.KV_REST_API_URL = "https://primary-kv.example";
    process.env.KV_REST_API_TOKEN = "primary-token";
    process.env.UPSTASH_REDIS_REST_URL = "https://secondary-kv.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "secondary-token";
  });

  afterEach(() => {
    if (realFetch) {
      global.fetch = realFetch;
    } else {
      delete global.fetch;
    }
    delete process.env.HISTORY_ALLOWED_MARKETS;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("falls back to hist:day after hist misses", async () => {
    const miss = () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    const dayHit = () => ({
      ok: true,
      json: async () => ({ result: JSON.stringify(sampleHistoryPayload) }),
    });
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(miss()); // hist primary
    fetchMock.mockResolvedValueOnce(miss()); // hist secondary
    fetchMock.mockResolvedValueOnce(miss()); // hist_day primary
    fetchMock.mockResolvedValueOnce(dayHit()); // hist_day secondary
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-02", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const traceGets = res.jsonPayload.debug.trace
      .filter((entry) => entry.get)
      .map((entry) => entry.get);
    expect(traceGets).toEqual([
      "hist:2024-06-02",
      "hist:2024-06-02",
      "hist:day:2024-06-02",
      "hist:day:2024-06-02",
    ]);
    expect(res.jsonPayload.source["2024-06-02"].used).toBe("hist_day");
    expect(res.jsonPayload.history.map((e) => e.fixture_id)).toContain(
      "fx-histday-1"
    );
  });

  it("attempts all fallbacks when debug is disabled", async () => {
    const miss = () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(miss()); // hist primary
    fetchMock.mockResolvedValueOnce(miss()); // hist secondary
    fetchMock.mockResolvedValueOnce(miss()); // hist_day primary
    fetchMock.mockResolvedValueOnce(miss()); // hist_day secondary
    fetchMock.mockResolvedValueOnce(miss()); // union primary
    fetchMock.mockResolvedValueOnce(miss()); // union secondary
    fetchMock.mockResolvedValueOnce(miss()); // combined primary
    fetchMock.mockResolvedValueOnce(miss()); // combined secondary
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-03" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(8);
    const traceGets = res.jsonPayload.debug.trace
      .filter((entry) => entry.get)
      .map((entry) => entry.get);
    expect(traceGets).toEqual([
      "hist:2024-06-03",
      "hist:2024-06-03",
      "hist:day:2024-06-03",
      "hist:day:2024-06-03",
      "vb:day:2024-06-03:union",
      "vb:day:2024-06-03:union",
      "vb:day:2024-06-03:combined",
      "vb:day:2024-06-03:combined",
    ]);
    expect(res.jsonPayload.source["2024-06-03"].combined).toBe(false);
    expect(res.jsonPayload.source["2024-06-03"].union).toBe(false);
    expect(res.jsonPayload.source["2024-06-03"].used).toBeNull();
  });

  it("uses combined fallback only when debug is enabled", async () => {
    const miss = () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    const combinedHit = () => ({
      ok: true,
      json: async () => ({ result: JSON.stringify(combinedHistoryPayload) }),
    });
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(miss()); // hist primary
    fetchMock.mockResolvedValueOnce(miss()); // hist secondary
    fetchMock.mockResolvedValueOnce(miss()); // hist_day primary
    fetchMock.mockResolvedValueOnce(miss()); // hist_day secondary
    fetchMock.mockResolvedValueOnce(miss()); // union primary
    fetchMock.mockResolvedValueOnce(miss()); // union secondary
    fetchMock.mockResolvedValueOnce(miss()); // combined primary
    fetchMock.mockResolvedValueOnce(combinedHit()); // combined secondary
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-04", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(8);
    const traceGets = res.jsonPayload.debug.trace
      .filter((entry) => entry.get)
      .map((entry) => entry.get);
    expect(traceGets).toEqual([
      "hist:2024-06-04",
      "hist:2024-06-04",
      "hist:day:2024-06-04",
      "hist:day:2024-06-04",
      "vb:day:2024-06-04:union",
      "vb:day:2024-06-04:union",
      "vb:day:2024-06-04:combined",
      "vb:day:2024-06-04:combined",
    ]);
    expect(res.jsonPayload.source["2024-06-04"].used).toBe("combined");
    expect(res.jsonPayload.history.map((e) => e.fixture_id)).toContain(
      "fx-combined-1"
    );
  });

  it("treats plain array and wrapped history payloads the same", async () => {
    const plainPayload = [
      {
        fixture_id: "plain-1",
        market_key: "h2h",
        pick: "home",
        result: "win",
        teams: {
          home: { id: "p1h", name: "Plain Home" },
          away: { id: "p1a", name: "Plain Away" },
        },
      },
      {
        fixture_id: "plain-2",
        market_key: "h2h",
        pick: "away",
        result: "loss",
        teams: {
          home: { id: "p2h", name: "Plain Home 2" },
          away: { id: "p2a", name: "Plain Away 2" },
        },
      },
    ];
    const wrappedPayload = {
      history: plainPayload.map((entry, idx) => ({
        ...entry,
        fixture_id: `wrapped-${idx + 1}`,
      })),
    };

    const { default: handler } = require("../../../pages/api/history");

    const runWithPayload = async (payload) => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: JSON.stringify(payload) }),
      });
      global.fetch = fetchMock;
      const req = { query: { ymd: "2024-06-05" } };
      const res = createMockRes();
      await handler(req, res);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      return res.jsonPayload;
    };

    const plainResult = await runWithPayload(plainPayload);
    const wrappedResult = await runWithPayload(wrappedPayload);

    expect(plainResult.count).toBe(plainResult.history.length);
    expect(wrappedResult.count).toBe(wrappedResult.history.length);
    expect(plainResult.count).toBe(wrappedResult.count);
    expect(plainResult.count).toBe(plainPayload.length);
  });
});
