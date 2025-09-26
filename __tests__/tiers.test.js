const { tieredFixtures, denylistedFixture } = require("../lib/matchSelector.fixtures");
const { isLeagueDenied } = require("../lib/leaguesConfig");
const { resolveLeagueTier } = require("../lib/learning/runtime");

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

describe("tiering and denylist fixtures", () => {
  it("flags denylisted leagues", () => {
    expect(isLeagueDenied(denylistedFixture.league)).toBe(true);
  });

  it("maintains at least 70% Tier 1 coverage", () => {
    const tiers = tieredFixtures.map((fix) => resolveLeagueTier(fix.league));
    const t1Count = tiers.filter((tier) => tier === "T1").length;
    const ratio = t1Count / tiers.length;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });
});

describe("value-bets locked tier output", () => {
  const fixedNow = new Date("2024-08-01T08:00:00Z");
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(fixedNow);
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
    jest.useFakeTimers().setSystemTime(fixedNow);
    jest.resetModules();
    kvStore = new Map();
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "token";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    global.fetch = mockFetchFactory(kvStore);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (realFetch) {
      global.fetch = realFetch;
    } else {
      delete global.fetch;
    }
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  it("exposes tier information in locked response", async () => {
    const slot = "am";
    const dayKey = `vb:day:${ymd}:${slot}`;
    const fullKey = `vbl_full:${ymd}:${slot}`;
    const lastKey = `vb:last-odds:${slot}`;

    kvStore.set(dayKey, JSON.stringify({ items: tieredFixtures }));
    kvStore.set(fullKey, JSON.stringify({ items: [] }));
    kvStore.set(lastKey, JSON.stringify({ iso: "2024-08-01T07:30:00Z" }));

    const { default: handler } = require("../pages/api/value-bets-locked");
    const req = { query: { slot } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload?.ok).toBe(true);
    const items = res.jsonPayload.items || [];
    expect(items.length).toBeGreaterThan(0);
    items.forEach((item) => {
      expect(typeof item.tier).toBe("string");
      expect(item.tier.length).toBeGreaterThan(0);
    });

    const uniqueFixtureTiers = new Map();
    for (const item of items) {
      if (item.fixture_id == null) continue;
      if (!uniqueFixtureTiers.has(item.fixture_id)) {
        uniqueFixtureTiers.set(item.fixture_id, item.tier);
      }
    }
    const totalFixtures = uniqueFixtureTiers.size;
    expect(totalFixtures).toBeGreaterThan(0);
    const tier1Count = Array.from(uniqueFixtureTiers.values()).filter((tier) => tier === "T1").length;
    const ratio = tier1Count / totalFixtures;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });
});
