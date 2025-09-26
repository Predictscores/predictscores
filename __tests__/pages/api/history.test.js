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

  it("skips combined fallback when debug is disabled", async () => {
    const miss = () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(miss()); // hist primary
    fetchMock.mockResolvedValueOnce(miss()); // hist secondary
    fetchMock.mockResolvedValueOnce(miss()); // hist_day primary
    fetchMock.mockResolvedValueOnce(miss()); // hist_day secondary
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-03" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const traceGets = res.jsonPayload.debug.trace
      .filter((entry) => entry.get)
      .map((entry) => entry.get);
    expect(traceGets).toEqual([
      "hist:2024-06-03",
      "hist:2024-06-03",
      "hist:day:2024-06-03",
      "hist:day:2024-06-03",
    ]);
    expect(res.jsonPayload.source["2024-06-03"].combined).toBe(false);
    expect(res.jsonPayload.source["2024-06-03"].used).toBe("hist_day");
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
    fetchMock.mockResolvedValueOnce(miss()); // combined primary
    fetchMock.mockResolvedValueOnce(combinedHit()); // combined secondary
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-04", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const traceGets = res.jsonPayload.debug.trace
      .filter((entry) => entry.get)
      .map((entry) => entry.get);
    expect(traceGets).toEqual([
      "hist:2024-06-04",
      "hist:2024-06-04",
      "hist:day:2024-06-04",
      "hist:day:2024-06-04",
      "vb:day:2024-06-04:combined",
      "vb:day:2024-06-04:combined",
    ]);
    expect(res.jsonPayload.source["2024-06-04"].used).toBe("combined");
    expect(res.jsonPayload.history.map((e) => e.fixture_id)).toContain(
      "fx-combined-1"
    );
  });
});
