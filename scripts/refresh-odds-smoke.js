#!/usr/bin/env node
const { strict: assert } = require("node:assert");

const KEY_ENV_VARS = [
  "APIFOOTBALL_KEY",
  "API_FOOTBALL_KEY",
  "APISPORTS_KEY",
  "APISPORTS_API_KEY",
  "X_APISPORTS_KEY",
  "NEXT_PUBLIC_API_FOOTBALL_KEY",
];

const KV_ENV_VARS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "KV_REST_API_READ_ONLY_TOKEN",
];

const ALL_ENV_VARS = [...new Set([...KEY_ENV_VARS, ...KV_ENV_VARS])];

function setKeyEnv(value) {
  for (const name of KEY_ENV_VARS) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
}

function restoreEnv(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function makeRes() {
  const res = {
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
  return res;
}

function makeReq(query = {}) {
  return {
    method: "GET",
    headers: {},
    query,
  };
}

async function invoke(handler, { query = {} } = {}) {
  const req = makeReq(query);
  const res = makeRes();
  await handler(req, res);
  return res.jsonPayload;
}

async function main() {
  const savedEnv = Object.fromEntries(ALL_ENV_VARS.map((name) => [name, process.env[name]]));

  let stubCalls = 0;
  const stubResponse = {
    response: [
      {
        bookmakers: [
          {
            bets: [
              {
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "2.10" },
                  { value: "Draw", odd: "3.10" },
                  { value: "Away", odd: "3.50" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const stubExports = {
    afxOddsByFixture: async () => {
      stubCalls += 1;
      return stubResponse;
    },
  };
  stubExports.default = stubExports;

  const apiFootballPath = require.resolve("../lib/sources/apiFootball.js");
  require.cache[apiFootballPath] = {
    id: apiFootballPath,
    filename: apiFootballPath,
    loaded: true,
    exports: stubExports,
  };

  const jiti = require("jiti")(__filename);
  const handlerModule = jiti("../pages/api/cron/refresh-odds.js");
  const handler = handlerModule.default || handlerModule;

  const kvBase = "https://kv.example.test";
  const originalFetch = global.fetch;

  const kvFixturesDoc = {
    items: [
      {
        fixture_id: 4242,
        league: { name: "UEFA Test League" },
      },
    ],
  };

  function jsonResponse(body, { ok = true, status } = {}) {
    const httpStatus = status ?? (ok ? 200 : 404);
    return {
      ok,
      status: httpStatus,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/json" : null;
        },
      },
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  }

  const stubFetch = async (url, init = {}) => {
    const target = typeof url === "string" ? url : url?.toString?.() || "";
    if (target.startsWith(kvBase)) {
      if (target.includes("/get/")) {
        const key = decodeURIComponent(target.split("/get/")[1] || "");
        if (key.startsWith("vb:day:")) {
          return jsonResponse({ result: kvFixturesDoc });
        }
        if (key.startsWith("vbl_full:")) {
          return jsonResponse({ result: { items: [] } });
        }
        return jsonResponse({}, { ok: false, status: 404 });
      }
      if (target.includes("/set/")) {
        return jsonResponse({ ok: true });
      }
    }
    if (originalFetch) {
      return originalFetch(url, init);
    }
    throw new Error(`Unhandled fetch URL in smoke test: ${target}`);
  };

  process.env.KV_REST_API_URL = kvBase;
  process.env.KV_REST_API_TOKEN = "kv-stub-token";
  process.env.KV_REST_API_READ_ONLY_TOKEN = "kv-stub-ro";

  try {
    global.fetch = stubFetch;
    setKeyEnv(null);
    const first = await invoke(handler);
    assert.deepStrictEqual(first, { ok:false, reason:"missing API_FOOTBALL_KEY" });

    setKeyEnv("dummy-key");
    const second = await invoke(handler);
    assert.strictEqual(second.ok, true);

    if (stubCalls === 0) {
      throw new Error("Expected afxOddsByFixture stub to be invoked at least once");
    }
  } finally {
    global.fetch = originalFetch;
    restoreEnv(savedEnv);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
