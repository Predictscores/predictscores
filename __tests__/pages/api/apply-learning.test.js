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

function extractTrace(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.trace)) return payload.trace;
  if (Array.isArray(payload._trace)) return payload._trace;
  return [];
}

describe("apply-learning history writer", () => {
  const ymd = "2024-07-01";
  let fetchMock;
  let setCalls;

  beforeEach(() => {
    jest.resetModules();
    setCalls = [];
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
            {
              fixture: {
                id: 303,
                teams: {
                  home: { id: 3001, name: "Gamma" },
                  away: { id: 3002, name: "Delta" },
                },
              },
              selection: "Away",
              market_key: "h2h",
              teams: {
                home: { id: 3001, name: "Gamma" },
                away: { id: 3002, name: "Delta" },
              },
            },
            {
              fixture_id: 404,
              market: "1x2",
              selection: "Home",
              home_name: "Omega FC",
              away_name: "Sigma FC",
              model: {
                fixture: 404,
                predicted: "home",
                home_team: "Omega FC",
                away_team: "Sigma FC",
              },
            },
          ],
        };
        return {
          ok: true,
          json: async () => ({ result: JSON.stringify(payload) }),
        };
      }
      const setMatch = url.match(/^https:\/\/kv\.example\/set\/(.+)$/);
      if (setMatch) {
        const key = decodeURIComponent(setMatch[1]);
        const bodyJson = options?.body ? JSON.parse(options.body) : {};
        setCalls.push({ key, body: bodyJson });
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: "OK" }),
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
    const handlerModule = require("../../../pages/api/cron/apply-learning");
    const handler = handlerModule.default || handlerModule;
    const req = {
      url: `/api/cron/apply-learning?ymd=${encodeURIComponent(ymd)}&trace=1`,
      headers: { host: "example.test", "x-forwarded-proto": "https" },
      query: { ymd, trace: "1" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.ok).toBe(true);
    expect(res.jsonPayload.count).toBeGreaterThan(0);
    const histArrayCall = setCalls.find((call) => call.key === `hist:${ymd}`);
    expect(histArrayCall).toBeDefined();
    const histArrayPayload = histArrayCall.body?.value;
    const parsedHist = JSON.parse(histArrayPayload);
    expect(Array.isArray(parsedHist)).toBe(true);
    expect(parsedHist.length).toBeGreaterThanOrEqual(1);
    const fallbackEntry = parsedHist.find((row) => row.fixture_id === 404);
    expect(fallbackEntry).toBeDefined();
    expect(fallbackEntry).toEqual(
      expect.objectContaining({
        fixture_id: 404,
        selection: "home",
        predicted: "home",
        home_name: "Omega FC",
        away_name: "Sigma FC",
        market_key: "1x2",
        market: "1x2",
        market_label: "1X2",
        source: "combined",
      })
    );
    expect(Object.keys(fallbackEntry).sort()).toEqual(
      [
        "away_name",
        "fixture_id",
        "home_name",
        "market",
        "market_key",
        "market_label",
        "predicted",
        "selection",
        "source",
      ].sort()
    );

    const responseTrace = extractTrace(res.jsonPayload);

    expect(responseTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          history_requirements: expect.objectContaining({ kept: res.jsonPayload.count }),
        }),
      ])
    );
    expect(responseTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalize: "teams", filled: expect.objectContaining({ home: expect.any(Number), away: expect.any(Number) }) }),
      ])
    );
    const historyTrace = responseTrace.find((row) => row.history_requirements);
    expect(historyTrace).toBeDefined();
    expect(historyTrace.history_requirements.reasons.noTeams).toBe(0);

    const histDayCall = setCalls.find((call) => call.key === `hist:day:${ymd}`);
    expect(histDayCall).toBeDefined();
    const histDayPayload = JSON.parse(histDayCall.body?.value);
    expect(Array.isArray(histDayPayload)).toBe(true);
    expect(histDayPayload).toEqual(parsedHist);
    expect(fetchMock).toHaveBeenCalled();
    expect(responseTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kv: "set", key: `hist:${ymd}`, size: parsedHist.length, ok: true }),
      ])
    );
    expect(responseTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kv: "set", key: `hist:day:${ymd}`, size: parsedHist.length, ok: true }),
      ])
    );
  });

  it("infers 1x2 market metadata for implicit H2H picks", async () => {
    const assumedYmd = "2024-07-02";
    fetchMock.mockImplementation(async (url, options = {}) => {
      if (url === `https://kv.example/get/${encodeURIComponent(`vb:day:${assumedYmd}:union`)}`) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }
      if (url === `https://kv.example/get/${encodeURIComponent(`vb:day:${assumedYmd}:combined`)}`) {
        const payload = {
          items: [
            {
              fixture_id: 505,
              selection: "Away",
              teams: {
                home: { id: 9001, name: "Implied Home" },
                away: { id: 9002, name: "Implied Away" },
              },
              fixture: {
                id: 505,
                teams: {
                  home: { id: 9001, name: "Implied Home" },
                  away: { id: 9002, name: "Implied Away" },
                },
              },
            },
          ],
        };
        return {
          ok: true,
          json: async () => ({ result: JSON.stringify(payload) }),
        };
      }
      const setMatch = url.match(/^https:\/\/kv\.example\/set\/(.+)$/);
      if (setMatch) {
        const key = decodeURIComponent(setMatch[1]);
        const bodyJson = options?.body ? JSON.parse(options.body) : {};
        setCalls.push({ key, body: bodyJson });
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: "OK" }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      };
    });

    const handlerModule = require("../../../pages/api/cron/apply-learning");
    const handler = handlerModule.default || handlerModule;
    const req = {
      url: `/api/cron/apply-learning?ymd=${encodeURIComponent(assumedYmd)}&trace=1`,
      headers: { host: "example.test", "x-forwarded-proto": "https" },
      query: { ymd: assumedYmd, trace: "1" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.ok).toBe(true);
    expect(res.jsonPayload.count).toBe(1);

    const responseTrace = extractTrace(res.jsonPayload);

    const historyTrace = responseTrace.find((row) => row.history_requirements);
    expect(historyTrace).toBeDefined();
    expect(historyTrace.history_requirements.reasons.assumedMarket).toBeGreaterThan(0);
    expect(historyTrace.history_requirements.reasons.noMarket).toBe(0);

    const histArrayCall = setCalls.find((call) => call.key === `hist:${assumedYmd}`);
    expect(histArrayCall).toBeDefined();
    const parsedHist = JSON.parse(histArrayCall.body?.value);
    expect(Array.isArray(parsedHist)).toBe(true);
    expect(parsedHist.length).toBe(1);
    expect(parsedHist[0]).toEqual(
      expect.objectContaining({
        fixture_id: 505,
        selection: "away",
        predicted: "away",
        home_name: "Implied Home",
        away_name: "Implied Away",
        market_key: "1x2",
        market: "1x2",
        market_label: "1X2",
        source: "combined",
      })
    );

    const histDayCall = setCalls.find((call) => call.key === `hist:day:${assumedYmd}`);
    expect(histDayCall).toBeDefined();
    const parsedDay = JSON.parse(histDayCall.body?.value);
    expect(Array.isArray(parsedDay)).toBe(true);
    expect(parsedDay).toEqual(parsedHist);
  });

  it("falls back to :last snapshot when only last is populated", async () => {
    const lastYmd = "2024-07-03";
    fetchMock.mockImplementation(async (url, options = {}) => {
      if (url === `https://kv.example/get/${encodeURIComponent(`vb:day:${lastYmd}:union`)}`) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }
      if (url === `https://kv.example/get/${encodeURIComponent(`vb:day:${lastYmd}:combined`)}`) {
        const payload = { items: [] };
        return {
          ok: true,
          json: async () => ({ result: JSON.stringify(payload) }),
        };
      }
      if (url === `https://kv.example/get/${encodeURIComponent(`vb:day:${lastYmd}:last`)}`) {
        const payload = {
          items: [
            {
              fixture_id: 808,
              selection: "Home",
              market_label: "H2H",
              model_prob: 0.64,
              teams: {
                home: { id: 7001, name: "Last Home" },
                away: { id: 7002, name: "Last Away" },
              },
              fixture: {
                id: 808,
                teams: {
                  home: { id: 7001, name: "Last Home" },
                  away: { id: 7002, name: "Last Away" },
                },
              },
            },
            {
              fixture_id: 808,
              selection: "Home",
              market_label: "H2H",
              model_prob: 0.42,
              teams: {
                home: { id: 7001, name: "Last Home" },
                away: { id: 7002, name: "Last Away" },
              },
              fixture: {
                id: 808,
                teams: {
                  home: { id: 7001, name: "Last Home" },
                  away: { id: 7002, name: "Last Away" },
                },
              },
            },
          ],
        };
        return {
          ok: true,
          json: async () => ({ result: JSON.stringify(payload) }),
        };
      }
      const setMatch = url.match(/^https:\/\/kv\.example\/set\/(.+)$/);
      if (setMatch) {
        const key = decodeURIComponent(setMatch[1]);
        const bodyJson = options?.body ? JSON.parse(options.body) : {};
        setCalls.push({ key, body: bodyJson });
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: "OK" }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      };
    });

    const handlerModule = require("../../../pages/api/cron/apply-learning");
    const handler = handlerModule.default || handlerModule;
    const req = {
      url: `/api/cron/apply-learning?ymd=${encodeURIComponent(lastYmd)}&trace=1`,
      headers: { host: "example.test", "x-forwarded-proto": "https" },
      query: { ymd: lastYmd, trace: "1" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.ok).toBe(true);
    expect(res.jsonPayload.count).toBe(1);

    const histArrayCall = setCalls.find((call) => call.key === `hist:${lastYmd}`);
    expect(histArrayCall).toBeDefined();
    const parsedHist = JSON.parse(histArrayCall.body?.value);
    expect(Array.isArray(parsedHist)).toBe(true);
    expect(parsedHist).toHaveLength(1);
    expect(parsedHist[0]).toEqual(
      expect.objectContaining({
        fixture_id: 808,
        selection: "home",
        home_name: "Last Home",
        away_name: "Last Away",
        source: "combined",
      })
    );

    const histDayCall = setCalls.find((call) => call.key === `hist:day:${lastYmd}`);
    expect(histDayCall).toBeDefined();
    const parsedDay = JSON.parse(histDayCall.body?.value);
    expect(Array.isArray(parsedDay)).toBe(true);
    expect(parsedDay).toEqual(parsedHist);

    const calledUrls = fetchMock.mock.calls.map(([calledUrl]) =>
      typeof calledUrl === "string" ? decodeURIComponent(calledUrl) : calledUrl
    );
    expect(calledUrls.some((calledUrl) => calledUrl.includes(`vb:day:${lastYmd}:last`))).toBe(true);
    expect(calledUrls.some((calledUrl) => calledUrl.includes(`vb:day:${lastYmd}:am`))).toBe(false);
    expect(calledUrls.some((calledUrl) => calledUrl.includes(`vb:day:${lastYmd}:pm`))).toBe(false);
    expect(calledUrls.some((calledUrl) => calledUrl.includes(`vb:day:${lastYmd}:late`))).toBe(false);
  });

  it("exposes trace payload via _trace when requested", async () => {
    const handlerModule = require("../../../pages/api/cron/apply-learning");
    const handler = handlerModule.default || handlerModule;
    const req = {
      url: `/api/cron/apply-learning?ymd=${encodeURIComponent(ymd)}&trace=1`,
      headers: { host: "example.test", "x-forwarded-proto": "https" },
      query: { ymd, trace: "1" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.ok).toBe(true);
    const traceArray = Array.isArray(res.jsonPayload.trace) ? res.jsonPayload.trace : [];
    expect(traceArray.length).toBe(0);
    const debugTrace = Array.isArray(res.jsonPayload._trace) ? res.jsonPayload._trace : [];
    expect(debugTrace.length).toBeGreaterThan(0);

    const historyTrace = debugTrace.find((row) => row.history_requirements);
    expect(historyTrace).toBeDefined();
    expect(historyTrace.history_requirements.kept).toBe(res.jsonPayload.count);
  });
});
