const sampleHistoryPayload = {
  history: [
    {
      fixture_id: "fx-1",
      market_key: "H2H!!! ",
      pick: "Home",
      result: "WIN",
      price_snapshot: 2,
    },
    {
      fixture_id: "fx-1",
      market_key: "h2h",
      pick: "HOME ",
      result: "win",
      price_snapshot: 2,
    },
    {
      fixture_id: "fx-2",
      market_key: "Total-Goals??",
      pick: "Over 2.5",
      result: "loss",
      price_snapshot: 1.8,
    },
  ],
};

const realFetch = global.fetch;

const kvResponseModes = [
  ["string payloads", (payload) => ({ result: JSON.stringify(payload) }), false],
  ["object payloads", (payload) => ({ result: payload }), true],
];

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

describe.each(kvResponseModes)("API history market normalization (%s)", (modeLabel, makeEnvelope, expectKvObject) => {
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
    process.env.HISTORY_ALLOWED_MARKETS = " h2h , total-goals?? ";
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

  it("exposes history entries whose market keys include stray punctuation", async () => {
    const fetchMock = jest.fn();
    mockKvResponses(fetchMock, sampleHistoryPayload);
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history");

    const req = { query: { ymd: "2024-05-01", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.history).toHaveLength(2);
    expect(res.jsonPayload.history.map((e) => e.market_key)).toEqual(
      expect.arrayContaining(["H2H!!! ", "Total-Goals??"])
    );
    expect(res.jsonPayload.debug).toEqual({
      sourceFlavor: "vercel-kv",
      kvObject: expectKvObject,
    });
  });

  it("includes normalized market keys in ROI calculations", async () => {
    const fetchMock = jest.fn();
    mockKvResponses(fetchMock, sampleHistoryPayload);
    global.fetch = fetchMock;

    const { default: handler } = require("../../../pages/api/history-roi");

    const req = { query: { ymd: "2024-05-01", debug: "1" } };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.count).toBe(2);
    expect(res.jsonPayload.roi).toMatchObject({ played: 2, wins: 1 });
    expect(res.jsonPayload.debug).toEqual({
      sourceFlavor: "vercel-kv",
      kvObject: expectKvObject,
    });
  });
});
