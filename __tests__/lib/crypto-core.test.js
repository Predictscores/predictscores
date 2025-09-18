const originalEnv = process.env;
const realFetch = global.fetch;

function createMockResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (name && name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => data,
  };
}

describe("CoinGecko mode handling", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    global.fetch = jest.fn(() => {
      throw new Error("fetch not mocked");
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  test("FREE mode bypasses API key validation", async () => {
    process.env.COINGECKO_FREE = "true";
    process.env.COINGECKO_API_KEY = "";

    const payload = [
      {
        id: "bitcoin",
        symbol: "btc",
        name: "Bitcoin",
        image: "btc.png",
        current_price: 100,
        market_cap: 200,
        total_volume: 300,
        price_change_percentage_1h_in_currency: 0.1,
        price_change_percentage_24h_in_currency: 0.2,
        price_change_percentage_7d_in_currency: 0.3,
      },
    ];

    global.fetch.mockImplementation(async (url, opts = {}) => {
      expect(opts.headers).toBeUndefined();
      return createMockResponse(payload);
    });

    const { fetchCoinGeckoMarkets } = await import("../../lib/crypto-core.js");
    const result = await fetchCoinGeckoMarkets("");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        id: "bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        image: "btc.png",
        current_price: 100,
        market_cap: 200,
        total_volume: 300,
        price_change_percentage_1h_in_currency: 0.1,
        price_change_percentage_24h_in_currency: 0.2,
        price_change_percentage_7d_in_currency: 0.3,
      },
    ]);
  });

  test("Pro mode enforces API key validation", async () => {
    delete process.env.COINGECKO_FREE;
    process.env.COINGECKO_API_KEY = "";

    const { fetchCoinGeckoMarkets } = await import("../../lib/crypto-core.js");

    await expect(fetchCoinGeckoMarkets("")).rejects.toMatchObject({
      code: "coingecko_api_key_missing",
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("buildSignals uses FREE mode without an API key", async () => {
    process.env.COINGECKO_FREE = "true";
    process.env.COINGECKO_API_KEY = "";
    process.env.CRYPTO_OKX_ENABLE = "0";
    process.env.CRYPTO_BYBIT_ENABLE = "0";

    global.fetch.mockImplementation(async (url, opts = {}) => {
      expect(opts.headers).toBeUndefined();
      return createMockResponse([]);
    });

    const cryptoCore = await import("../../lib/crypto-core.js");
    const result = await cryptoCore.buildSignals();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = global.fetch.mock.calls[0];
    expect(options?.headers).toBeUndefined();
  });
});
