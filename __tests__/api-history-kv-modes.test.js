import handler from "../pages/api/history";

const originalFetch = global.fetch;

function createRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(() => res);
  res.json = jest.fn();
  return res;
}

function setKvEnv() {
  process.env.KV_REST_API_URL = "https://example.com";
  process.env.KV_REST_API_TOKEN = "token";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

function mockFetchSequence(envelopes) {
  const queue = envelopes.slice();
  global.fetch = jest.fn().mockImplementation(() => {
    const next = queue.length ? queue.shift() : { result: JSON.stringify({ items: [] }) };
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(next),
    });
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  jest.resetAllMocks();
});

test("history accepts stringified KV payloads", async () => {
  setKvEnv();
  mockFetchSequence([
    { result: JSON.stringify({ items: [{ id: 1, market_key: "h2h", pick: "home" }] }) },
    { result: JSON.stringify({ items: [] }) },
  ]);

  const req = { query: { ymd: "2024-01-01" } };
  const res = createRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(200);
  const payload = res.json.mock.calls[0][0];
  expect(payload.ok).toBe(true);
  expect(payload.count).toBeGreaterThan(0);
});

test("history accepts object KV payloads", async () => {
  setKvEnv();
  mockFetchSequence([
    { result: { items: [{ id: 2, market_key: "h2h", pick: "away" }] } },
    { result: { items: [] } },
  ]);

  const req = { query: { ymd: "2024-01-02" } };
  const res = createRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(200);
  const payload = res.json.mock.calls[0][0];
  expect(payload.ok).toBe(true);
  expect(payload.count).toBeGreaterThan(0);
});
