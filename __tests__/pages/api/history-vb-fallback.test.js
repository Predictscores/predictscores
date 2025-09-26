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

const unionOnlyPayload = {
  history: [
    {
      fixture_id: "fx-union-1",
      market_key: "h2h",
      pick: "home",
      result: "win",
      price_snapshot: 2.0,
    },
  ],
};

const combinedOnlyPayload = {
  history: [
    {
      fixture_id: "fx-combined-1",
      market_key: "h2h",
      pick: "away",
      result: "win",
      price_snapshot: 3.1,
    },
  ],
};

describe("API history VB fallback layers", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.HISTORY_ALLOWED_MARKETS = "h2h";
    process.env.KV_REST_API_URL = "https://primary-kv.example";
    process.env.KV_REST_API_TOKEN = "primary-token";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
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

  it("returns union fallback history without debug", async () => {
    const fetchMock = jest.fn();
    const miss = () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    const unionHit = () => ({
      ok: true,
      json: async () => ({ result: JSON.stringify(unionOnlyPayload) }),
    });

    fetchMock.mockResolvedValueOnce(miss());
    fetchMock.mockResolvedValueOnce(miss());
    fetchMock.mockResolvedValueOnce(unionHit());
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-02" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBe(1);
    expect(res.jsonPayload.history.map((e) => e.fixture_id)).toContain("fx-union-1");
    expect(res.jsonPayload.source["2024-06-02"]).toMatchObject({
      used: "union",
      union: true,
      combined: false,
    });
  });

  it("returns combined fallback history when union is empty", async () => {
    const fetchMock = jest.fn();
    const miss = () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    const combinedHit = () => ({
      ok: true,
      json: async () => ({ result: JSON.stringify(combinedOnlyPayload) }),
    });

    fetchMock.mockResolvedValueOnce(miss());
    fetchMock.mockResolvedValueOnce(miss());
    fetchMock.mockResolvedValueOnce(miss());
    fetchMock.mockResolvedValueOnce(combinedHit());
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-03" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBe(1);
    expect(res.jsonPayload.history.map((e) => e.fixture_id)).toContain("fx-combined-1");
    expect(res.jsonPayload.source["2024-06-03"]).toMatchObject({
      used: "combined",
      union: false,
      combined: true,
    });
  });
});

