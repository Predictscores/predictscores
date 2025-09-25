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
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }
      if (url === `https://kv.example/get/${encodeURIComponent(`vb:day:${ymd}:combined`)}`) {
        const payload = {
          items: [
            {
              fixture_id: 101,
              selection: "Home",
              market_label: "H2H",
              model_prob: 0.61,
              odds: { price: 1.9 },
              league_id: 77,
              league_name: "Sample League",
              league: { id: 77, name: "Sample League" },
              teams: {
                home: { id: 1001, name: "Alpha" },
                away: { id: 1002, name: "Beta" },
              },
              fixture: {
                teams: {
                  home: { id: 1001, name: "Alpha" },
                  away: { id: 1002, name: "Beta" },
                },
                league: { id: 77, name: "Sample League" },
              },
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
      query: { ymd },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.ok).toBe(true);
    expect(res.jsonPayload.count).toBeGreaterThan(0);
    const histArrayCall = pipelineCalls.find((cmds) => Array.isArray(cmds) && cmds[0]?.[1] === `hist:${ymd}`);
    expect(histArrayCall).toBeDefined();
    const histArrayPayload = histArrayCall[0][2];
    const parsedHist = JSON.parse(histArrayPayload);
    expect(Array.isArray(parsedHist)).toBe(true);
    expect(parsedHist.length).toBeGreaterThan(0);
    expect(parsedHist[0].league.name).toBe("Sample League");
    expect(parsedHist[0].teams.home.name).toBe("Alpha");

    const histDayCall = pipelineCalls.find((cmds) => Array.isArray(cmds) && cmds[0]?.[1] === `hist:day:${ymd}`);
    expect(histDayCall).toBeDefined();
    expect(fetchMock).toHaveBeenCalled();
    expect(res.jsonPayload.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ kv: "set", key: `hist:day:${ymd}` }),
    ]));
  });
});
