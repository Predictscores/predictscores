// Safe wrapper for API-FOOTBALL (v3) using the official header.
// Drop-in replacement; izbegava RapidAPI headere koji često daju 403/HTML.
//
// Upotreba:
//   const { afFetch } = require("../../lib/sources/apiFootball");
//   const data = await afFetch("/fixtures", { date: "2025-08-17" });
//
// Env:
//   API_FOOTBALL_KEY (obavezno)
//   API_FOOTBALL_BASE (opciono; default https://v3.football.api-sports.io)

const API_BASE =
  process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
const API_KEY =
  process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || "";

function qs(params = {}) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) v.forEach((vv) => u.append(k, vv));
    else u.append(k, v);
  });
  return u.toString();
}

async function afFetch(path, params = {}, init = {}) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY is missing");
  const url = `${API_BASE}${path}${
    Object.keys(params).length ? `?${qs(params)}` : ""
  }`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "x-apisports-key": API_KEY,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text();
    throw new Error(
      `API-FOOTBALL non-JSON response (${res.status}): ${text.slice(0, 180)}`
    );
  }
  const data = await res.json();
  return data;
}

module.exports = {
  afFetch,
  default: { afFetch },
};
