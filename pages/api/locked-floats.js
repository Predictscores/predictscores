// pages/api/locked-floats.js
// Persists today's UNION of fixture IDs and (if missing) lightweight tickets.
// Writes to BOTH KV backends (primary: KV_REST_*, fallback: UPSTASH_REDIS_REST_*).

export const config = { api: { bodyParser: false } };

/* ---------- TZ helpers ---------- */
const TZ = (() => {
  try {
    const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch { return "Europe/Belgrade"; }
})();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

/* ---------- Dual KV clients ---------- */
// Primary (Vercel KV REST)
const KV_URL = process.env.KV_REST_API_URL ? String(process.env.KV_REST_API_URL).replace(/\/+$/, "") : "";
const KV_TOK = process.env.KV_REST_API_TOKEN || "";
const hasKV = Boolean(KV_URL && KV_TOK);

// Legacy fallback (Upstash Redis REST)
const R_URL = process.env.UPSTASH_REDIS_REST_URL ? String(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, "") : "";
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const hasR  = Boolean(R_URL && R_TOK);

const J = (s) => { try { return JSON.parse(String(s ?? "")); } catch { return null; } };

async function kvGetREST(key) {
  if (!hasKV) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOK}` }, cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvSetREST(key, val) {
  if (!hasKV) return false;
  const body = typeof val === "string" ? val : JSON.stringify(val);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOK}`, "Content-Type": "application/json" },
    body,
  });
  return r.ok;
}
async function kvGetUpstash(key) {
  if (!hasR) return null;
  const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${R_TOK}` }, cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvSetUpstash(key, val) {
  if (!hasR) return false;
  const body = typeof val === "string" ? val : JSON.stringify(val);
  const r = await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" },
    body,
  });
  return r.ok;
}
// Read: prefer KV_REST_*, else Upstash. Write: try both, succeed if at least one.
async function kvGetAny(key) {
  const a = await kvGetREST(key);
  if (a != null) return a;
  return kvGetUpstash(key);
}
async function kvSetBoth(key, val) {
  const r1 = await kvSetREST(key, val);
  const r2 = await kvSetUpstash(key, val);
  return r1 || r2;
}

/* ---------- API-FOOTBALL helpers ---------- */
const AF_BASE = "https://v3.football.api-sports.io";
const AF_KEY  = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
async function af(path) {
  const r = await fetch(AF_BASE + path, { headers: { "x-apisports-key": AF_KEY } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
const fixturesByDate = (date, tz) =>
  af(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(tz)}`);
const oddsByFixture = (fid) => af(`/odds?fixture=${encodeURIComponent(fid)}`);

/* ---------- tickets (bounded) ---------- */
function baseFx(fx) {
  const f = fx?.fixture || fx || {};
  const l = fx?.league || {};
  const t = fx?.teams || {};
  return {
    id: f?.id ?? fx?.id ?? null,
    league: { name: l?.name ?? null, tier: l?.tier ?? null },
    teams: { home: t?.home?.name ?? null, away: t?.away?.name ?? null },
    date: f?.date ?? null,
  };
}

async function buildTickets(fixtures) {
  const take = fixtures.slice(0, 12);
  const btts = [], ou25 = [], htft = [];
  let budgetStop = false;

  for (const f of take) {
    const fid = f?.fixture?.id || f?.id;
    if (!fid) continue;

    const odds = await oddsByFixture(fid);
    if (!odds) { budgetStop = true; break; }
    const books = odds?.response?.[0]?.bookmakers || [];

    // BTTS
    {
      let yes = [], no = [];
      for (const b of books) for (const bet of (b?.bets || [])) {
        const nm = String(bet?.name || "").toLowerCase();
        if (!nm.includes("both teams to score")) continue;
        for (const v of (bet?.values || [])) {
          const lbl = String(v?.value || "").toLowerCase();
          const odd = Number(v?.odd);
          if (!Number.isFinite(odd)) continue;
          if (lbl.includes("yes")) yes.push(odd); else if (lbl.includes("no")) no.push(odd);
        }
      }
      const bestYes = yes.length ? Math.min(...yes) : Infinity;
      const bestNo  = no.length ? Math.min(...no)  : Infinity;
      const pick = bestYes <= bestNo
        ? { market: "BTTS", selection_label: "Yes", market_odds: bestYes }
        : { market: "BTTS", selection_label: "No",  market_odds: bestNo  };
      if (isFinite(pick.market_odds)) btts.push({ ...baseFx(f), ...pick });
    }

    // OU 2.5
    {
      let over = [], under = [];
      for (const b of books) for (const bet of (b?.bets || [])) {
        const nm = String(bet?.name || "").toLowerCase();
        if (!nm.includes("over/under")) continue;
        for (const v of (bet?.values || [])) {
          const ln = String(v?.value || "").toLowerCase();
          if (!/2\.5/.test(ln)) continue;
          const odd = Number(v?.odd);
          if (!Number.isFinite(odd)) continue;
          if (ln.includes("over")) over.push(odd); else if (ln.includes("under")) under.push(odd);
        }
      }
      const bestOver = over.length ? Math.min(...over) : Infinity;
      const bestUnder = under.length ? Math.min(...under) : Infinity;
      const pick = bestOver <= bestUnder
        ? { market: "OU2.5", selection_label: "Over 2.5",  market_odds: bestOver }
        : { market: "OU2.5", selection_label: "Under 2.5", market_odds: bestUnder };
      if (isFinite(pick.market_odds)) ou25.push({ ...baseFx(f), ...pick });
    }

    // HT/FT
    {
      const map = {};
      for (const b of books) for (const bet of (b?.bets || [])) {
        const nm = String(bet?.name || "").toLowerCase();
        if (!nm.includes("ht/ft") && !nm.includes("half time/full time")) continue;
        for (const v of (bet?.values || [])) {
          const lbl = String(v?.value || "").toUpperCase().replace(/\s+/g, "");
          const odd = Number(v?.odd); if (!Number.isFinite(odd)) continue;
          const norm = lbl.replace(/(^|\/)1/g, "$1HOME").replace(/(^|\/)X/g, "$1DRAW").replace(/(^|\/)2/g, "$1AWAY");
          (map[norm] ||= []).push(odd);
        }
      }
      const best = Object.entries(map)
        .map(([k, arr]) => [k, arr && arr.length ? Math.min(...arr) : Infinity])
        .sort((a, b) => a[1] - b[1])[0];
      if (best && isFinite(best[1])) htft.push({
        ...baseFx(f), market: "HT-FT", market_label: "HT-FT",
        selection_label: best[0], market_odds: best[1],
      });
    }
  }

  return { btts, ou25, htft, budgetStop };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    if (!hasKV && !hasR) {
      return res.status(200).json({ ok: false, error: "No KV configured (KV_REST_* or UPSTASH_REDIS_REST_*)." });
    }

    const today = String(req.query.ymd || ymdInTZ(new Date(), TZ));
    const warm = String(req.query.warm || "") === "1";
    if (!warm) return res.status(200).json({ ok: true, note: "locked-floats alive" });

    const fResp = await fixturesByDate(today, TZ);
    const fixtures = Array.isArray(fResp?.response) ? fResp.response : [];
    const ids = fixtures.map(f => f?.fixture?.id || f?.id).filter(Boolean);
    const uniqIds = Array.from(new Set(ids));

    // Write UNION in BOTH backends in the **most permissive shape** (bare array),
    // because some readers expect an array, others expect {items:[]}. We write both.
    const arr = uniqIds;
    const obj = { ymd: today, ts: new Date().toISOString(), items: uniqIds };

    await kvSetBoth(`vb:day:${today}:union`, arr);           // bare array
    await kvSetBoth(`vb:day:${today}:union:obj`, obj);       // object mirror (for readers using .items)

    // Tickets (if missing)
    const tKey = `tickets:${today}`;
    const tRaw = await kvGetAny(tKey);
    let madeTickets = false, tCounts = { btts:0, ou25:0, htft:0 }, budgetStop=false;

    if (!tRaw) {
      const { btts, ou25, htft, budgetStop: bs } = await buildTickets(fixtures);
      await kvSetBoth(tKey, { ymd: today, btts, ou25, htft });
      madeTickets = true; budgetStop = bs;
      tCounts = { btts: btts.length, ou25: ou25.length, htft: htft.length };
    } else {
      const t = J(tRaw) || {};
      tCounts = { btts: (t.btts||[]).length, ou25: (t.ou25||[]).length, htft: (t.htft||[]).length };
    }

    return res.status(200).json({
      ok: true,
      warm: { union_count: uniqIds.length, tickets_created: madeTickets, tickets_counts: tCounts, budget_exhausted: budgetStop }
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
