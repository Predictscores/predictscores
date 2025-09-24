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

describe("value-bets learning integration", () => {
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

  it("writes shadow output in learning shadow mode and compare endpoint returns diff", async () => {
    const slot = "am";
    const configKey = "cfg:learning";
    kvStore.set(configKey, JSON.stringify({
      enable_calib: true,
      enable_evmin: true,
      enable_league_adj: true,
      shadow_mode: true,
    }));

    const fixture = {
      fixture_id: 101,
      league: { id: 39, name: "Premier League" },
      teams: {
        home: { id: 1, name: "Alpha" },
        away: { id: 2, name: "Beta" },
      },
      kickoff: "2024-07-01T15:00:00Z",
      kickoff_utc: "2024-07-01T13:00:00Z",
      markets: {
        btts: { yes: 1.9 },
        ou25: { over: 2.05 },
        fh_ou15: { over: 1.68 },
        htft: { hh: 4.4, dd: 4.0 },
        "1x2": { home: 1.95, draw: 3.4, away: 4.2 },
      },
      model_probs: {
        home: 0.52,
        draw: 0.27,
        away: 0.21,
        btts_yes: 0.58,
        ou25_over: 0.55,
        fh_ou15_over: 0.6,
        htft: { hh: 0.35, dd: 0.3 },
      },
    };

    kvStore.set(`vb:day:${ymd}:${slot}`, JSON.stringify({ items: [fixture] }));
    kvStore.set(`vbl_full:${ymd}:${slot}`, JSON.stringify({ items: [] }));
    kvStore.set(`vb:last-odds:${slot}`, JSON.stringify({ iso: "2024-07-01T10:00:00Z" }));

    kvStore.set("learn:calib:v2:BTTS:T1:1.76-2.20", JSON.stringify({
      type: "logistic",
      intercept: 0.1,
      slope: 1.2,
      samples: 320,
    }));
    kvStore.set("learn:evmin:v2:BTTS:1.76-2.20", JSON.stringify({
      ev_min: 0.03,
      samples: 280,
    }));
    kvStore.set("learn:league_adj:v1:39", JSON.stringify({
      delta_pp: 1.5,
      samples: 410,
    }));

    const { default: lockedHandler } = require("../../../pages/api/value-bets-locked");
    const req = { query: { slot } };
    const res = createMockRes();

    await lockedHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.ok).toBe(true);
    expect(res.jsonPayload.debug).toBeDefined();
    expect(res.jsonPayload.debug.learning).toBeDefined();
    expect(res.jsonPayload.debug.learning.applied).toBe(false);
    expect(res.jsonPayload.debug.learning.wrote_shadow).toBe(true);

    const shadowKey = `vb:shadow:${ymd}:${slot}`;
    expect(kvStore.has(shadowKey)).toBe(true);
    const shadow = JSON.parse(kvStore.get(shadowKey));
    expect(Array.isArray(shadow.baseline)).toBe(true);
    expect(Array.isArray(shadow.learned)).toBe(true);
    const pickMeta = shadow.meta.picks.find((p) => p.market === "BTTS");
    expect(pickMeta).toBeTruthy();
    expect(pickMeta.learned_edge_pp).toBeGreaterThan(pickMeta.baseline_edge_pp);
    expect(pickMeta.ev_guard_used).toBeGreaterThan(0);

    const { default: compareHandler } = require("../../../pages/api/learning-compare");
    const compareReq = { query: { ymd, slot } };
    const compareRes = createMockRes();

    await compareHandler(compareReq, compareRes);

    expect(compareRes.statusCode).toBe(200);
    expect(compareRes.jsonPayload.ok).toBe(true);
    expect(compareRes.jsonPayload.items.length).toBeGreaterThan(0);
    const diff = compareRes.jsonPayload.items[0];
    expect(diff.learned_edge_pp).toBeGreaterThan(diff.baseline_edge_pp);
    expect(diff.ev_guard_used).toBeGreaterThan(0);
    expect(diff.samples_bucket).toBeTruthy();
  });
});
