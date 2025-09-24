const originalEnv = process.env;
const realFetch = global.fetch;

jest.mock("../../../lib/crypto-core", () => {
  const actual = jest.requireActual("../../../lib/crypto-core");
  return {
    ...actual,
    buildSignals: jest.fn(),
  };
});

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

describe("FREE mode API handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv };
    delete global.__UPSTASH_FALLBACK_STORE__;
    global.fetch = jest.fn(() => {
      throw new Error("unexpected fetch call");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = realFetch;
  });

  it("/api/crypto returns live data using FREE mode", async () => {
    process.env.COINGECKO_FREE = "1";
    process.env.COINGECKO_API_KEY = "";
    process.env.CRYPTO_FALLBACK_STORE_TOKEN = "local";

    const cryptoCore = require("../../../lib/crypto-core");
    cryptoCore.buildSignals.mockResolvedValue([
      {
        symbol: "BTC",
        signal: "LONG",
        confidence_pct: 60,
        entry: 100,
        tp: 120,
        sl: 90,
        rr: 2,
        expectedMove: 5,
      },
    ]);

    const { default: handler } = require("../../../pages/api/crypto.js");

    const req = { query: {}, headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(cryptoCore.buildSignals).toHaveBeenCalledTimes(1);
    expect(cryptoCore.buildSignals.mock.calls[0][0]).toEqual(
      expect.objectContaining({ cgFree: true })
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload?.ok).toBe(true);
    expect(res.jsonPayload?.source).toBe("live");
  });

  it("/api/cron/crypto-build rejects invalid key", async () => {
    process.env.CRON_KEY = "secret";

    const { default: handler } = require("../../../pages/api/cron/crypto-build.js");

    const req = { query: { key: "nope" }, headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.jsonPayload).toEqual({ ok: false, reason: "bad key" });
  });

  it("/api/cron/crypto-build saves signals with correct key", async () => {
    process.env.COINGECKO_FREE = "1";
    process.env.COINGECKO_API_KEY = "";
    process.env.CRYPTO_FALLBACK_STORE_TOKEN = "local";
    process.env.CRON_KEY = "secret";

    const cryptoCore = require("../../../lib/crypto-core");
    cryptoCore.buildSignals.mockResolvedValue([
      {
        symbol: "BTC",
        signal: "LONG",
        confidence_pct: 60,
        entry: 100,
        tp: 120,
        sl: 90,
        rr: 2,
        expectedMove: 5,
      },
    ]);

    const { default: handler } = require("../../../pages/api/cron/crypto-build.js");

    const req = { query: { key: "secret", debug: "1" }, headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(cryptoCore.buildSignals).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload?.ok).toBe(true);
    expect(res.jsonPayload?.saved).toBeGreaterThanOrEqual(0);
    expect(res.jsonPayload?.ttl_min).toBeGreaterThan(0);
  });

  it("/api/cron/crypto-watchdog reports upstream failure", async () => {
    process.env.CRON_KEY = "secret";

    global.fetch = jest.fn(async (url) => {
      expect(url).toBe("https://example.com/api/cron/crypto-build?key=secret&debug=1");
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ ok: false, error: "upstream_down" }),
      };
    });

    const { default: handler } = require("../../../pages/api/cron/crypto-watchdog.js");

    const req = {
      query: { key: "secret", debug: "1" },
      headers: { host: "example.com", "x-forwarded-proto": "https" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload?.ok).toBe(false);
    expect(res.jsonPayload?.upstream).toEqual({
      status: 503,
      body: { ok: false, error: "upstream_down" },
    });
  });
});
