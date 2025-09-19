#!/usr/bin/env node

const DEFAULT_BASE = "http://localhost:3000";
const base = (process.env.BASE || DEFAULT_BASE).replace(/\/+$/, "");
const today = new Date().toISOString().slice(0, 10);
const url = `${base}/api/history?ymd=${today}${process.env.DEBUG ? "&debug=1" : ""}`;

console.log(`[smoke-history] ${url}`);

try {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const bodyText = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {}
  if (response.status !== 200 || !payload || payload.ok !== true || payload.count === 0) {
    console.error(`[smoke-history] status=${response.status} body=${bodyText.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`[smoke-history] ok count=${payload.count}`);
  process.exit(0);
} catch (error) {
  console.error(`[smoke-history] request error: ${error?.message || error}`);
  process.exit(1);
}
