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

function encodeValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

describe("value-bets locked read fallbacks", () => {
  const ymd = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Belgrade" }).slice(0, 10);
  let kvStore;

  function mockFetchFactory(store) {
    return jest.fn(async (url, options = {}) => {
      if (url.includes("/get/")) {
        const key = decodeURIComponent(url.split("/get/")[1]);
        const stored = store.get(key);
        return {
          ok: true,
          json: async () => ({ result: stored != null ? stored : null }),
        };
      }
      if (url.includes("/set/")) {
        const [, rest] = url.split("/set/");
        const parts = rest.split("/");
        const key = decodeURIComponent(parts[0]);
        let value = null;
        if (options && options.body) {
          try {
            const parsed = JSON.parse(options.body);
            value = encodeValue(parsed?.value ?? null);
          } catch {
            value = null;
          }
        } else if (parts.length > 1) {
          value = decodeURIComponent(parts.slice(1).join("/"));
        }
        store.set(key, value);
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      return { ok: false, status: 404 };
    });
  }

  beforeEach(() => {
    jest.resetModules();
    kvStore = new Map();
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "token";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    global.fetch = mockFetchFactory(kvStore);
  });

  afterEach(() => {
    if (realFetch) {
      global.fetch = realFetch;
    } else {
      delete global.fetch;
    }
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  const baseFixture = {
    fixture_id: 404,
    league: { id: 99, name: "Test League" },
    teams: {
      home: { id: 1, name: "Alpha" },
      away: { id: 2, name: "Beta" },
    },
    kickoff: "2024-07-01T12:00:00Z",
    kickoff_utc: "2024-07-01T12:00:00Z",
    markets: {
      btts: { yes: 1.9 },
      ou25: { over: 2.05 },
      fh_ou15: { over: 1.68 },
      htft: { hh: 4.4 },
      "1x2": { home: 1.95, draw: 3.4, away: 4.2 },
    },
    model_probs: {
      home: 0.5,
      draw: 0.3,
      away: 0.2,
      btts_yes: 0.55,
      ou25_over: 0.52,
      fh_ou15_over: 0.58,
      htft: { hh: 0.32 },
    },
  };

  it("uses canonical vb:day:<ymd>:last payload when available", async () => {
    const slot = "am";
    const canonicalKey = `vb:day:${ymd}:last`;
    const fullKey = `vbl_full:${ymd}:${slot}`;
    kvStore.set(canonicalKey, JSON.stringify([baseFixture]));
    kvStore.set(fullKey, JSON.stringify({ items: [] }));

    const { default: handler } = require("../../../pages/api/value-bets-locked");
    const req = { query: { slot } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toBeTruthy();
    expect(res.jsonPayload.ok).toBe(true);
    expect(Array.isArray(res.jsonPayload.items)).toBe(true);
    expect(res.jsonPayload.items.length).toBeGreaterThan(0);
    expect(res.jsonPayload.source).toBe("vb:day:last");
    expect(res.jsonPayload.debug.base_candidates).toEqual([
      expect.objectContaining({
        key: canonicalKey,
        source: "vb:day:last",
        used: true,
        items: expect.any(Number),
      }),
    ]);
  });

  it("falls back to slot vb:day:<ymd>:<slot> when canonical payload empty", async () => {
    const slot = "pm";
    const canonicalKey = `vb:day:${ymd}:last`;
    const slotKey = `vb:day:${ymd}:${slot}`;
    const fullKey = `vbl_full:${ymd}:${slot}`;
    kvStore.set(canonicalKey, JSON.stringify([]));
    kvStore.set(slotKey, JSON.stringify({ items: [baseFixture] }));
    kvStore.set(fullKey, JSON.stringify({ items: [] }));

    const { default: handler } = require("../../../pages/api/value-bets-locked");
    const req = { query: { slot } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toBeTruthy();
    expect(res.jsonPayload.ok).toBe(true);
    expect(Array.isArray(res.jsonPayload.items)).toBe(true);
    expect(res.jsonPayload.items.length).toBeGreaterThan(0);
    expect(res.jsonPayload.source).toBe(`vb:day:${slot}`);
    expect(res.jsonPayload.debug.base_candidates).toEqual([
      expect.objectContaining({
        key: canonicalKey,
        source: "vb:day:last",
        used: false,
      }),
      expect.objectContaining({
        key: slotKey,
        source: `vb:day:${slot}`,
        used: true,
      }),
    ]);
  });
});

