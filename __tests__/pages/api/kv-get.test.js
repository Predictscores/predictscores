const originalEnv = process.env;
const realFetch = global.fetch;

function createMockRes() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
}

describe("/api/kv/get", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    global.fetch = jest.fn(() => {
      throw new Error("fetch should not be called in this test");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = realFetch;
  });

  it("reports production KV misconfiguration when drift is detected", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_READ_ONLY_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL_PREVIEW = "https://preview.example";
    process.env.KV_REST_API_TOKEN_PREVIEW = "preview-token";

    const { PRODUCTION_MISCONFIG_CODE } = require("../../../lib/kv-helpers");
    const handler = require("../../../pages/api/kv/get.js");

    const req = {
      method: "GET",
      query: { key: "vb:day:2024-01-01:combined" },
      headers: { host: "example.com" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual(
      expect.objectContaining({
        ok: false,
        error: "Confirm env vars present in Production",
        code: PRODUCTION_MISCONFIG_CODE,
      })
    );
  });
});
