const realFetch = global.fetch;

function createMockRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
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

describe("apply-learning history writer", () => {
  const ymd = "2024-07-01";
  let fetchMock;
  let pipelineCalls;

  beforeEach(() => {
    jest.resetModules();
    pipelineCalls = [];
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "test-token";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    fetchMock = jest.fn(async (url, options = {}) => {
      if (url === `https://kv.example/get/${encodeURIComponent(`vb:day:${ymd}:union`)}`) {
        const payload = {
          items: [
            {
              fixture_id: 101,
              selection: "Home",
              market_label: "H2H",
              model_prob: 0.61,
              odds: { price: 1.9 },
            },
            {
              fixture_id: 202,
              selection: "Over 2.5",
              market_label: "Total Goals",
              model_prob: 0.52,
            },
          ],
        };
        return {
          ok: true,
          json: async () => ({ result: JSON.stringify(payload) }),
        };
      }
      if (url === "https://kv.example/pipeline") {
        const body = options?.body ? JSON.parse(options.body) : [];
        pipelineCalls.push(body);
        return {
          ok: true,
          json: async () => body.map(() => ({ result: "OK" })),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      };
    });
    global.fetch = fetchMock;
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

  it("stores H2H picks in hist keys and responds with count", async () => {
    const handler = require("../../../pages/api/cron/apply-learning");
    const req = {
      url: `/api/cron/apply-learning?ymd=${encodeURIComponent(ymd)}&debug=1`,
      headers: { host: "example.test", "x-forwarded-proto": "https" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.ok).toBe(true);
    expect(res.jsonPayload.count).toBeGreaterThan(0);
    const histDayCall = pipelineCalls.find((cmds) => Array.isArray(cmds) && cmds[0]?.[1] === `hist:day:${ymd}`);
    expect(histDayCall).toBeDefined();
    expect(fetchMock).toHaveBeenCalled();
    expect(res.jsonPayload.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ kv: "set", key: `hist:day:${ymd}` }),
    ]));
  });
});
