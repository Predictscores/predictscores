const sampleHistoryPayload = {
  history: [
    {
      fixture_id: "fx-secondary-1",
      market_key: "h2h",
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

describe.each(kvResponseModes)(
  "API history secondary backend fallback (%s)",
  (modeLabel, makeEnvelope) => {
    function mockSecondaryOnly(fetchMock, payload) {
      const miss = () => ({
        ok: true,
        json: async () => ({ result: null }),
      });
      fetchMock.mockResolvedValueOnce(miss());
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => makeEnvelope(payload),
      });
      fetchMock.mockResolvedValueOnce(miss());
      fetchMock.mockResolvedValueOnce(miss());
    }

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

    it("returns history stored only in the secondary backend", async () => {
      const fetchMock = jest.fn();
      mockSecondaryOnly(fetchMock, sampleHistoryPayload);
      global.fetch = fetchMock;

      const { default: handler } = require("../../../pages/api/history");

      const req = { query: { ymd: "2024-06-02", debug: "1" } };
      const res = createMockRes();

      await handler(req, res);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(res.statusCode).toBe(200);
      expect(res.jsonPayload.count).toBe(1);
      expect(res.jsonPayload.history.map((e) => e.fixture_id)).toContain(
        "fx-secondary-1"
      );
      expect(res.jsonPayload.debug.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            get: "hist:2024-06-02",
            flavor: "vercel-kv",
            hit: false,
          }),
          expect.objectContaining({
            get: "hist:2024-06-02",
            flavor: "upstash-redis",
            hit: true,
          }),
        ])
      );
    });

    it("computes ROI from entries stored only in the secondary backend", async () => {
      const fetchMock = jest.fn();
      mockSecondaryOnly(fetchMock, sampleHistoryPayload);
      global.fetch = fetchMock;

      const { default: handler } = require("../../../pages/api/history-roi");

      const req = { query: { ymd: "2024-06-02", debug: "1" } };
      const res = createMockRes();

      await handler(req, res);

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(res.statusCode).toBe(200);
      expect(res.jsonPayload.count).toBe(1);
      expect(res.jsonPayload.roi).toMatchObject({ played: 1, wins: 1 });
      expect(res.jsonPayload.debug.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            get: "hist:2024-06-02",
            flavor: "upstash-redis",
            hit: true,
          }),
        ])
      );
    });
  }
);

describe("API history placeholder string fallback", () => {
  const placeholderCases = [
    ["literal null string", "null"],
    ["empty quoted string", '""'],
    ["whitespace only", "   "],
  ];

  function mockClearedPrimary(fetchMock, placeholder, payload) {
    const cleared = () => ({
      ok: true,
      json: async () => ({ result: placeholder }),
    });
    const secondaryHit = () => ({
      ok: true,
      json: async () => ({ result: JSON.stringify(payload) }),
    });
    fetchMock.mockResolvedValueOnce(cleared());
    fetchMock.mockResolvedValueOnce(secondaryHit());
    fetchMock.mockResolvedValueOnce(cleared());
    fetchMock.mockResolvedValueOnce(secondaryHit());
  }

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

  it.each(placeholderCases)(
    "treats %s as a miss and falls back to the secondary backend for /api/history",
    async (_label, placeholder) => {
      const fetchMock = jest.fn();
      mockClearedPrimary(fetchMock, placeholder, sampleHistoryPayload);
      global.fetch = fetchMock;

      const { default: handler } = require("../../../pages/api/history");

      const req = { query: { ymd: "2024-06-02", debug: "1" } };
      const res = createMockRes();

      await handler(req, res);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(res.statusCode).toBe(200);
      expect(res.jsonPayload.count).toBe(1);
      expect(res.jsonPayload.history.map((e) => e.fixture_id)).toContain(
        "fx-secondary-1"
      );
      expect(res.jsonPayload.debug.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            get: "hist:2024-06-02",
            flavor: "vercel-kv",
            hit: false,
          }),
          expect.objectContaining({
            get: "hist:2024-06-02",
            flavor: "upstash-redis",
            hit: true,
          }),
main
        ])
      );
    }
  );

  it.each(placeholderCases)(
    "treats %s as a miss and falls back to the secondary backend for /api/history-roi",
    async (_label, placeholder) => {
      const fetchMock = jest.fn();
      mockClearedPrimary(fetchMock, placeholder, sampleHistoryPayload);
      global.fetch = fetchMock;

      const { default: handler } = require("../../../pages/api/history-roi");

      const req = { query: { ymd: "2024-06-02", debug: "1" } };
      const res = createMockRes();

      await handler(req, res);

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(res.statusCode).toBe(200);
      expect(res.jsonPayload.count).toBe(1);
      expect(res.jsonPayload.roi).toMatchObject({ played: 1, wins: 1 });
      expect(res.jsonPayload.debug.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            get: "hist:2024-06-02",
            flavor: "vercel-kv",
            hit: false,
          }),
          expect.objectContaining({
            get: "hist:2024-06-02",
            flavor: "upstash-redis",
            hit: true,
          }),
          expect.objectContaining({
            get: "vb:day:2024-06-02:combined",
            flavor: "vercel-kv",
            hit: false,
          }),
          expect.objectContaining({
            get: "vb:day:2024-06-02:combined",
            flavor: "upstash-redis",
            hit: true,
          }),
        ])
      );
    }
  );
});
