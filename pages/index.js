// pages/index.js
// SSR: čitamo /api/football sa slotom (late/am/pm) i primenjujemo isti BAN da ne flešne U/U23 itd.
// UI deo ostaje isti (prosleđujemo initialFootball). Ako imaš svoj layout/komponente, zadrži ih.

import React from "react";

const BAN_REGEX =
  /\bU\s*-?\s*\d{1,2}\b|Under\s*\d{1,2}\b|Women|Girls|Reserves?|Youth|Academy|Development/i;

export default function Home({ initialFootball = [], slot = "am" }) {
  // Ovde samo renderuj svoje komponente kao i pre; primer minimalnog ispisa:
  return (
    <main className="min-h-screen p-4">
      <h1 className="text-xl font-semibold mb-2">Combined — Top Football (slot: {slot})</h1>
      <ul className="space-y-2">
        {initialFootball.slice(0, 3).map((m, i) => (
          <li key={`${m?.fixture_id || m?.id || i}`} className="p-3 rounded border">
            <div className="text-sm opacity-70">
              {m?.league?.country ? `${m.league.country} — ` : ""}
              {m?.league?.name || m?.league_name || ""}
            </div>
            <div className="text-base">
              {m?.home_name || m?.teams?.home?.name || "?"} vs{" "}
              {m?.away_name || m?.teams?.away?.name || "?"}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

export async function getServerSideProps(ctx) {
  const slot = String(ctx.query?.slot || "am").toLowerCase();
  const host = ctx.req?.headers?.host || "";
  const origin = process.env.NEXT_PUBLIC_BASE_URL || (host ? `https://${host}` : "");
  let data = { ok: true, football: [] };

  try {
    const u = `${origin}/api/football?slot=${encodeURIComponent(slot)}`;
    const r = await fetch(u, { headers: { "cache-control": "no-store" } });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    data = ct.includes("application/json") ? await r.json() : { ok: false, football: [] };
  } catch (_) {
    data = { ok: false, football: [] };
  }

  const arr = Array.isArray(data?.football) ? data.football : [];
  // SSR BAN da ne “flešne” U/Women/Reserves itd.
  const filtered = arr.filter((x) => !BAN_REGEX.test(String(x?.league?.name || x?.league_name || "")));

  return {
    props: {
      slot,
      initialFootball: filtered
    }
  };
}
