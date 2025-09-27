// pages/api/locked-floats.js
// Purpose: persist base UNION (as {items: [fixture_id,...]}) and build daily tickets.
// Note: do NOT write vb:day:<ymd>:last here; apply-learning owns that.

export const config = { api: { bodyParser: false } };

/* ---------- timezone helpers ---------- */
function pickTZ() {
  try {
    const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch {
    return "Europe/Belgrade";
  }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

/* ---------- minimal AF adapters ---------- */
async function afFetch(path) {
  const base = "https://v3.football.api-sports.io";
  const key = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  const r = await fetch(base + path, { headers: { "x-apisports-key": key } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
const afFixturesByDate = (date, tz) =>
  afFetch(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(tz)}`);
const afOddsByFixture = (fid) =>
  afFetch(`/odds?fixture=${encodeURIComponent(fid)}`);

/* ---------- KV helpers (Vercel KV / Upstash REST) ---------- */
const KV_URL = process.env.KV_REST_API_URL?.replace(/\/+$/, "");
const KV_TOK = process.env.KV_REST_API_TOKEN;
const okKV = !!(KV_URL && KV_TOK);
const J = (s) => { try { return JSON.parse(String(s || "")); } catch { return null; } };

async function kvGet(key) {
  if (!okKV) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOK}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvSet(key, val) {
  if (!okKV) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOK}`, "Content-Type": "application/json" },
    body: typeof val === "string" ? val : JSON.stringify(val),
  });
  return r.ok;
}

/* ---------- mapping ---------- */
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

/* ---------- quick tickets (BTTS/OU2.5/HT-FT) with bounded calls ---------- */
const kts = (x) => {
  const k = x?.fixture?.date || x?.date || null;
  const d = k ? new Date(k) : null;
  return Number.isFinite(d?.getTime?.()) ? d.getTime() : 0;
};
async function buildDailyTickets(fixtures) {
  const take = fixtures.slice(0, 12);
  const btts = [], ou25 = [], htft = [];
  let budgetStop = false;

  for (const f of take) {
    const fid = f?.fixture?.id || f?.id;
    if (!fid) continue;

    const odds = await afOddsByFixture(fid);
    if (!odds) { budgetStop = true; break; }
    const books = odds?.response?.[0]?.bookmakers || [];

    // BTTS best price
    {
      let yes = [], no = [];
      for (const b of books) for (const bet of (b?.bets || [])) {
        const nm = String(bet?.name || "").toLowerCase();
        if (!nm.includes("both teams to score")) continue;
        for (const v of (bet?.values || [])) {
          const lbl = String(v?.value || "").toLowerCase(); const odd = Number(v?.odd);
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
      const best = Object.entries(map).map(([k, arr]) => [k, arr.length ? Math.min(...arr) : Infinity])
                     .sort((a,b)=>a[1]-b[1])[0];
      if (best && isFinite(best[1])) htft.push({
        ...baseFx(f), market: "HT-FT", market_label: "HT-FT",
        selection_label: best[0], market_odds: best[1],
      });
    }
  }

  const sortT = (a,b) => (kts(a) - kts(b));
  return { btts: btts.sort(sortT), ou25: ou25.sort(sortT), htft: htft.sort(sortT), budgetStop };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const today = String(req.query.ymd || ymdInTZ(new Date(), TZ));
    const warm = String(req.query.warm || "") === "1";

    if (!okKV) return res.status(200).json({ ok: false, error: "KV not configured" });

    if (!warm) return res.status(200).json({ ok: true, note: "locked-floats alive" });

    // 1) Build base from AF fixtures
    const fixturesResp = await afFixturesByDate(today, TZ);
    const fixtures = Array.isArray(fixturesResp?.response) ? fixturesResp.response : [];
    const ids = fixtures.map(f => f?.fixture?.id || f?.id).filter(Boolean);
    const uniqIds = Array.from(new Set(ids));

    // Persist UNION in the normalized shape
    const ts = new Date().toISOString();
    await kvSet(`vb:day:${today}:union`, { ymd: today, ts, items: uniqIds });

    // 2) Daily tickets (if missing)
    const tKey = `tickets:${today}`;
    const tRaw = await kvGet(tKey);
    let madeTickets = false, tCounts = { btts:0, ou25:0, htft:0 }, budgetStop=false;

    if (!tRaw) {
      const { btts, ou25, htft, budgetStop: bs } = await buildDailyTickets(fixtures);
      await kvSet(tKey, { ymd: today, ts, btts, ou25, htft });
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
