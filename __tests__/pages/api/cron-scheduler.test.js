const realFetch = global.fetch;

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    json(payload) {
      this.jsonPayload = payload;
      return this;
    },
  };
}

describe("cron scheduler orchestrator", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    global.fetch = realFetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("invokes rebuild, refresh-odds, apply-learning in order with identical params", async () => {
    const calls = [];
    global.fetch = jest.fn(async (url) => {
      calls.push(url);
      const { pathname, searchParams } = new URL(url);
      const sharedResponse = {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, step: pathname.split("/").pop() }),
      };

      if (pathname === "/api/cron/rebuild") {
        expect(searchParams.get("ymd")).toBe("2024-07-01");
        expect(searchParams.get("slot")).toBe("am");
        expect(searchParams.get("extra")).toBe("1");
        return sharedResponse;
      }

      if (pathname === "/api/cron/refresh-odds") {
        expect(searchParams.get("ymd")).toBe("2024-07-01");
        expect(searchParams.get("slot")).toBe("am");
        expect(searchParams.get("extra")).toBe("1");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, trace: [], updated: 0 }),
        };
      }

      if (pathname === "/api/cron/apply-learning") {
        expect(searchParams.get("ymd")).toBe("2024-07-01");
        expect(searchParams.get("slot")).toBe("am");
        expect(searchParams.get("extra")).toBe("1");
        return sharedResponse;
      }

      throw new Error(`unexpected fetch call: ${url}`);
    });

    const { default: handler } = require("../../../pages/api/cron/scheduler.js");

    const req = {
      query: { ymd: "2024-07-01", slot: "am", extra: "1" },
      headers: { host: "example.com", "x-forwarded-proto": "https" },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/api/cron/rebuild",
      "/api/cron/refresh-odds",
      "/api/cron/apply-learning",
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload?.notes).toEqual([
      expect.objectContaining({ step: "refresh-odds", note: "no_updates" }),
    ]);
    expect(res.jsonPayload?.steps).toHaveLength(3);
    for (const step of res.jsonPayload.steps) {
      expect(step?.body?.ok).toBe(true);
    }
  });
});
