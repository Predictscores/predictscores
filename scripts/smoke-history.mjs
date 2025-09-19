#!/usr/bin/env node

const DEFAULT_BASE = "http://localhost:3000";
const baseEnv = (process.env.BASE || "").trim();
const base = (baseEnv || DEFAULT_BASE).replace(/\/+$/, "");

const today = new Date();
const todayUtc = new Date(Date.UTC(
  today.getUTCFullYear(),
  today.getUTCMonth(),
  today.getUTCDate(),
));
const ymd = todayUtc.toISOString().slice(0, 10);

const endpoint = `${base}/api/history?ymd=${encodeURIComponent(ymd)}`;

const fail = (message) => {
  console.error(`[smoke-history] ${message}`);
  process.exit(1);
};

try {
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    fail(`Request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json().catch(() => null);

  if (!payload || typeof payload.count !== "number") {
    fail("Response missing numeric 'count'.");
  }

  if (payload.count === 0) {
    fail("History count is zero.");
  }

  console.log(`[smoke-history] count=${payload.count}`);
} catch (error) {
  fail(error?.message || String(error));
}
