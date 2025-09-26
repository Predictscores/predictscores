const originalEnv = process.env;

describe("kvBackends production drift detection", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws a structured error when production lacks tokens but other envs are configured", () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_READ_ONLY_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL_PREVIEW = "https://preview.example";
    process.env.KV_REST_API_TOKEN_PREVIEW = "preview-token";

    const {
      kvBackends,
      KvEnvMisconfigurationError,
      PRODUCTION_MISCONFIG_CODE,
    } = require("../../lib/kv-helpers");

    let thrown = null;
    try {
      kvBackends();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(KvEnvMisconfigurationError);
    expect(thrown?.code).toBe(PRODUCTION_MISCONFIG_CODE);
    expect(Array.isArray(thrown?.meta?.configuredElsewhere)).toBe(true);
    expect(thrown.meta.configuredElsewhere).toEqual(
      expect.arrayContaining(["KV_REST_API_URL_PREVIEW", "KV_REST_API_TOKEN_PREVIEW"])
    );
  });

  it("returns an empty list without throwing when not in production", () => {
    process.env.VERCEL_ENV = "preview";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_READ_ONLY_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL_PREVIEW = "https://preview.example";
    process.env.KV_REST_API_TOKEN_PREVIEW = "preview-token";

    const { kvBackends } = require("../../lib/kv-helpers");

    expect(kvBackends()).toEqual([]);
  });
});
