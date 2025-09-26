jest.mock("../../../lib/kv-helpers", () => ({
  kvBackends: jest.fn(() => []),
  readKeyFromBackends: jest.fn(),
}));

const { kvBackends, readKeyFromBackends } = require("../../../lib/kv-helpers");
const handler = require("../../../pages/api/kv/get");

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    jsonPayload: null,
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

afterEach(() => {
  jest.clearAllMocks();
  jest.resetAllMocks();
});

describe("API /api/kv/get", () => {
  it("rejects non-GET requests with 405", async () => {
    const req = { method: "POST", query: { key: "vb:test" } };
    const res = createMockRes();

    await handler(req, res);

    expect(kvBackends).not.toHaveBeenCalled();
    expect(readKeyFromBackends).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(res.jsonPayload).toEqual({ ok: false, error: "method_not_allowed" });
    expect(res.headers.Allow).toBe("GET");
  });

  it("requires a key and returns 400 JSON error when missing", async () => {
    const req = { method: "GET", query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(kvBackends).not.toHaveBeenCalled();
    expect(readKeyFromBackends).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.jsonPayload).toEqual({ ok: false, error: "missing_key" });
  });

  it("returns a miss envelope with null raw values", async () => {
    kvBackends.mockReturnValueOnce([{ flavor: "vercel-kv" }]);
    readKeyFromBackends.mockResolvedValueOnce({
      value: null,
      hit: false,
      flavor: null,
      tried: [
        { flavor: "vercel-kv", ok: true, hit: false, count: 0 },
        { flavor: "upstash-redis", ok: false, hit: false, count: 0 },
      ],
    });

    const req = { method: "GET", query: { key: "vb:missing" } };
    const res = createMockRes();

    await handler(req, res);

    expect(kvBackends).toHaveBeenCalledTimes(1);
    expect(readKeyFromBackends).toHaveBeenCalledWith("vb:missing", {
      backends: [{ flavor: "vercel-kv" }],
      parseJson: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toMatchObject({
      ok: true,
      key: "vb:missing",
      hit: false,
      flavor: null,
      raw: null,
      valueType: "null",
      parsed: false,
      parsedType: "null",
    });
    expect(res.jsonPayload.tried).toEqual([
      { flavor: "vercel-kv", ok: true, hit: false, count: 0 },
      { flavor: "upstash-redis", ok: false, hit: false, count: 0 },
    ]);
  });

  it("parses JSON strings and reports parsed metadata", async () => {
    const rawJson = '{"foo":"bar","arr":[1,2,3]}';
    kvBackends.mockReturnValueOnce([{ flavor: "vercel-kv" }]);
    readKeyFromBackends.mockResolvedValueOnce({
      value: rawJson,
      hit: true,
      flavor: "vercel-kv",
    });

    const req = { method: "GET", query: { key: "vb:json" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toMatchObject({
      ok: true,
      key: "vb:json",
      hit: true,
      flavor: "vercel-kv",
      raw: rawJson,
      value: { foo: "bar", arr: [1, 2, 3] },
      valueType: "string",
      parsed: true,
      parsedType: "object",
    });
  });

  it("returns native objects without stringifying them", async () => {
    const native = { foo: "bar", nested: { answer: 42 } };
    kvBackends.mockReturnValueOnce([{ flavor: "vercel-kv" }]);
    readKeyFromBackends.mockResolvedValueOnce({
      value: native,
      hit: true,
      flavor: "vercel-kv",
    });

    const req = { method: "GET", query: { key: "vb:native" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.value).toEqual(native);
    expect(res.jsonPayload.raw).toEqual(native);
    expect(typeof res.jsonPayload.raw).toBe("object");
    expect(res.jsonPayload).toMatchObject({
      ok: true,
      key: "vb:native",
      hit: true,
      flavor: "vercel-kv",
      valueType: "object",
      parsed: false,
      parsedType: "object",
    });
  });
});

