const originalEnv = process.env;
const realFetch = global.fetch;

type MockResponse = {
  statusCode: number;
  jsonPayload: any;
  status(code: number): MockResponse;
  json(payload: any): MockResponse;
};

function createMockRes(): MockResponse {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.jsonPayload = payload;
      return this;
    },
  };
}

describe("history API KV result normalization", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.HISTORY_ALLOWED_MARKETS = "h2h";
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "kv-token";
    global.fetch = jest.fn(() => {
      throw new Error("fetch not mocked");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("handles stringified KV history payloads", async () => {
    const items = [
      {
        fixture_id: "fx-1",
        market_key: "h2h",
        pick: "home",
        result: "win",
      },
    ];

    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: JSON.stringify({ items }) }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: null }),
    });

    const { default: handler } = await import("../../../pages/api/history");

    const req = { query: { ymd: "2024-05-01" } };
    const res = createMockRes();

    await handler(req, res as any);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBeGreaterThan(0);
    expect(res.jsonPayload.history).toHaveLength(res.jsonPayload.count);
  });

  it("handles object KV history payloads", async () => {
    const items = [
      {
        fixture_id: "fx-2",
        market_key: "h2h",
        pick: "home",
        result: "win",
      },
    ];

    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { items } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: null }),
    });

    const { default: handler } = await import("../../../pages/api/history");

    const req = { query: { ymd: "2024-05-02" } };
    const res = createMockRes();

    await handler(req, res as any);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBeGreaterThan(0);
    expect(res.jsonPayload.history).toHaveLength(res.jsonPayload.count);
  });
});
