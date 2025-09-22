const sampleHistoryPayload = {
  history: [
    {
      fixture_id: "fx-allow-1",
      market: "1x2",
      pick: "home",
      result: "win",
      price_snapshot: 2.25,
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

const kvResponseModes = [
  ["string payloads", (payload) => ({ result: JSON.stringify(payload) })],
  ["object payloads", (payload) => ({ result: payload })],
];

describe.each(kvResponseModes)("API history market fallback (%s)", (modeLabel, makeEnvelope) => {
  function mockKvResponses(fetchMock, payload) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeEnvelope(payload),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: null }),
    });
  }

  beforeEach(() => {
    jest.resetModules();
    process.env.HISTORY_ALLOWED_MARKETS = "1x2";
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "test-token";
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
  });

  it("surfaces entries whose market key is stored under the market field", async () => {
    const fetchMock = jest.fn();
    mockKvResponses(fetchMock, sampleHistoryPayload);
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-01", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBe(1);
    expect(res.jsonPayload.history.map((e) => e.market)).toContain("1x2");
    expect(res.jsonPayload.debug.allowed).toEqual(["h2h"]);
  });

  it("allows 1x2 entries even when no explicit HISTORY_ALLOWED_MARKETS is set", async () => {
    const fetchMock = jest.fn();
    mockKvResponses(fetchMock, sampleHistoryPayload);
    global.fetch = fetchMock;

    delete process.env.HISTORY_ALLOWED_MARKETS;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-06-01", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBe(1);
    expect(res.jsonPayload.history.map((e) => e.market)).toContain("1x2");
    expect(res.jsonPayload.debug.allowed).toEqual(["h2h"]);
  });

  it("includes market fallback entries when computing ROI", async () => {
    const fetchMock = jest.fn();
    mockKvResponses(fetchMock, sampleHistoryPayload);
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history-roi");

    const req = { query: { ymd: "2024-06-01", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBe(1);
    expect(res.jsonPayload.roi).toMatchObject({ played: 1, wins: 1 });
    expect(res.jsonPayload.debug.allowed).toEqual(["h2h"]);
  });

  it("computes ROI for 1x2 entries using the default allow-list", async () => {
    const fetchMock = jest.fn();
    mockKvResponses(fetchMock, sampleHistoryPayload);
    global.fetch = fetchMock;

    delete process.env.HISTORY_ALLOWED_MARKETS;

    const { default: handler } = require("../../../pages/api/history-roi");

    const req = { query: { ymd: "2024-06-01", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBe(1);
    expect(res.jsonPayload.roi).toMatchObject({ played: 1, wins: 1 });
    expect(res.jsonPayload.debug.allowed).toEqual(["h2h"]);
  });
});

