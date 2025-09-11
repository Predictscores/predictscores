// pages/api/cron/refresh-odds.js

export const config = { api: { bodyParser: false } };

const TZ =
  (process.env.TZ_DISPLAY && process.env.TZ_DISPLAY.trim()) ||
  "Europe/Belgrade";

/* ---------- KV helpers ---------- */
function kvCfgs() {
  const url = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const rw = process.env.KV_REST_API_TOKEN || "";
  const ro = process.env.KV_REST_API_READ_ONLY_TOKEN || "";
  const list = [];
  if (url && rw) list.push({ flavor: "vercel-kv:rw", url, token: rw });
  if (url && ro) list.push({ flavor: "vercel-kv:ro", url, token: ro });
  return list;
}
async function kvGET(key, diag) {
  for (const c of kvCfgs()) {
    try {
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${c.token}` },
        cache: "no-store",
      });
      const j = r.ok ? await r.json().catch(() => null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag &&
        (diag.reads = diag.reads || []).push({
          flavor: c.flavor,
          key,
          status: r.ok ? (raw ? "hit" : "miss-null") : `http-${r.status}`,
        });
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag &&
        (diag.reads = diag.reads || []).push({
          flavor: c.flavor,
          key,
          status: `err:${String(e?.message || e)}`,
        });
    }
  }
  return { raw: null, flavor: null };
}
async function kvSET(key, valueString, diag) {
  const saved = [];
  for (const c of kvCfgs().filter((x) => x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: valueString,
      });
      saved.push({ flavor: c.flavor, ok: r.ok });
    } catch (e) {
      saved.push({ flavor: c.flavor, ok: false, err: String(e?.message || e) });
    }
  }
  diag && (diag.writes = diag.writes || []).push({ key, saved });
  return saved;
}
async function kvINCR(key, by = 1, diag) {
  const { raw } = await kvGET(key, diag);
  let v = 0;
  try {
    v = Number(JSON.parse(raw)) || 0;
  } catch {
    v = 0;
  }
  v += by;
  await kvSET(key, JSON.stringify(v), diag);
  return v;
}
const J = (s) => {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
};
function arrFromAny(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "object") {
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value === "string") {
      const v = J(x.value);
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") return arrFromAny(v);
    }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data)) return x.data;
  }
  if (typeof x === "string") {
    const v = J(x);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return arrFromAny(v);
  }
  return null;
}
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v = J(raw);
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && "value" in v) {
    if (Array.isArray(v.value)) return v.value;
    if (typeof v.value === "string") {
      const v2 = J(v.value);
      if (Array.isArray(v2)) return v2;
      if (v2 && typeof v2 === "object") return arrFromAny(v2);
    }
    return null;
  }
  if (v && typeof v === "object") return arrFromAny(v);
  return null;
}

/* ---------- time/slot ---------- */
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = fmt.formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(fmt.format(d), 10);
}
function deriveSlot(h) {
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}
function slotForKickoffISO(iso) {
  const h = new Date(iso).toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: TZ,
  });
  return deriveSlot(parseInt(h, 10));
}

/* ---------- API-Football ---------- */
const AF_BASE = "https://v3.football.api-sports.io";
const afFixturesHeaders = () => ({
  "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim(),
});
const afOddsHeaders = () => ({
  "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim(),
});

async function afFetch(path, params = {}, headers = afFixturesHeaders(), diagTag, diag) {
  const url = new URL(`${AF_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));
  const r = await fetch(url, { headers, cache: "no-store" });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  if (diag)
    (diag.af = diag.af || []).push({
      host: AF_BASE,
      tag: diagTag,
      path,
      params,
      status: r.status,
      ok: r.ok,
      results: j?.results,
      errors: j?.errors,
    });
  return j || {};
}
function mapFixture(fx) {
  const id = Number(fx?.fixture?.id);
  const ts =
    Number(fx?.fixture?.timestamp || 0) * 1000 ||
    Date.parse(fx?.fixture?.date || 0) ||
    0;
  const kick = new Date(ts).toISOString();
  return {
    fixture_id: id,
    league_name: fx?.league?.name,
    teams: { home: fx?.teams?.home?.name, away: fx?.teams?.away?.name },
    home: fx?.teams?.home?.name,
    away: fx?.teams?.away?.name,
    kickoff_utc: kick,
  };
}

/* ---------- fixtures (p0; paging ako treba) ---------- */
async function fetchFixturesIDsByDateStrict(ymd, slot, diag) {
  const variants = [
    { tag: "date+tz", params: { date: ymd, timezone: TZ } },
    { tag: "date", params: { date: ymd } },
    { tag: "from-to", params: { from: ymd, to: ymd } },
  ];
  const bag = new Map();
  for (const v of variants) {
    const j0 = await afFetch(
      "/fixtures",
      { ...v.params },
      afFixturesHeaders(),
      `fixtures:${v.tag}:p0`,
      diag
    );
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0) {
      const m = mapFixture(fx);
      if (!m.fixture_id) continue;
      if (slotForKickoffISO(m.kickoff_utc) !== slot) continue;
      bag.set(m.fixture_id, m);
    }
    const tot = Number(j0?.paging?.total || 1);
    for (let page = 2; page <= Math.min(tot, 12); page++) {
      const j = await afFetch(
        "/fixtures",
        { ...v.params, page },
        afFixturesHeaders(),
        `fixtures:${v.tag}:p${page}`,
        diag
      );
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr) {
        const m = mapFixture(fx);
        if (!m.fixture_id) continue;
        if (slotForKickoffISO(m.kickoff_utc) !== slot) continue;
        bag.set(m.fixture_id, m);
      }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}
async function fetchFixturesIDsWholeDay(ymd, slot, diag) {
  const variants = [
    { tag: "date+tz", params: { date: ymd, timezone: TZ } },
    { tag: "date", params: { date: ymd } },
    { tag: "from-to", params: { from: ymd, to: ymd } },
  ];
  const bag = new Map();
  for (const v of variants) {
    const j0 = await afFetch(
      "/fixtures",
      { ...v.params },
      afFixturesHeaders(),
      `fixtures:${v.tag}:p0`,
      diag
    );
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0) {
      const m = mapFixture(fx);
      if (!m.fixture_id) continue;
      if (slotForKickoffISO(m.kickoff_utc) !== slot) continue;
      bag.set(m.fixture_id, m);
    }
    const tot = Number(j0?.paging?.total || 1);
    for (let page = 2; page <= Math.min(tot, 12); page++) {
      const j = await afFetch(
        "/fixtures",
        { ...v.params, page },
        afFixturesHeaders(),
        `fixtures:${v.tag}:p${page}`,
        diag
      );
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr) {
        const m = mapFixture(fx);
        if (!m.fixture_id) continue;
        if (slotForKickoffISO(m.kickoff_utc) !== slot) continue;
        bag.set(m.fixture_id, m);
      }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}

/* ---------- Parse & save API-Football odds ---------- */
function bestPrice(values, wanted) {
  const pick = values?.find(
    (v) => String(v?.value || "").toLowerCase() === wanted
  );
  const odd = pick ? Number(pick.odd) : null;
  return Number.isFinite(odd) && odd > 1.01 ? odd : null;
}
async function saveAFMarketsToKV(fixtureId, jo, diag) {
  const r = Array.isArray(jo?.response) ? jo.response[0] : null;
  const books = Array.isArray(r?.bookmakers) ? r.bookmakers : [];
  let bttsSaved = false;
  let htftSaved = false;

  let bttsYes = null,
    bttsNo = null,
    bttsBooks = 0;

  const htftMap = {};
  let htftBooks = 0;

  for (const bm of books) {
    const bets = Array.isArray(bm?.bets) ? bm.bets : [];
    for (const bet of bets) {
      const name = String(bet?.name || "").toLowerCase();
      const values = Array.isArray(bet?.values) ? bet.values : [];

      if (name.includes("both teams") && name.includes("score")) {
        const yes = bestPrice(values, "yes");
        const no = bestPrice(values, "no");
        if (yes || no) {
          bttsBooks += 1;
          if (yes && (!bttsYes || yes > bttsYes)) bttsYes = yes;
          if (no && (!bttsNo || no > bttsNo)) bttsNo = no;
        }
      }

      if (name.includes("ht/ft") || name.includes("half time/full time")) {
        htftBooks += 1;
        for (const v of values) {
          const lbl = String(v?.value || "").trim();
          const odd = Number(v?.odd);
          if (!lbl || !Number.isFinite(odd) || odd <= 1.01) continue;
          if (!htftMap[lbl] || odd > htftMap[lbl]) htftMap[lbl] = odd;
        }
      }
    }
  }

  if (bttsYes || bttsNo) {
    const key = `odds:af:${fixtureId}:btts`;
    const payload = {
      yes: bttsYes || null,
      no: bttsNo || null,
      books_count: bttsBooks,
      updatedAt: new Date().toISOString(),
    };
    await kvSET(key, JSON.stringify(payload), diag);
    bttsSaved = true;
  }

  if (Object.keys(htftMap).length) {
    const key = `odds:af:${fixtureId}:htft`;
    const payload = {
      prices: htftMap,
      books_count: htftBooks,
      updatedAt: new Date().toISOString(),
    };
    await kvSET(key, JSON.stringify(payload), diag);
    htftSaved = true;
  }

  return { bttsSaved, htftSaved };
}

async function refreshOddsForIDs(ids, diag) {
  let touched = 0;
  let savedBTTS = 0;
  let savedHTFT = 0;

  for (const id of ids) {
    try {
      const jo = await afFetch("/odds", { fixture: id }, afOddsHeaders(), "odds", diag);
      diag && (diag.odds = diag.odds || []).push({ fixture: id, ok: Boolean(jo?.response?.length) });
      const { bttsSaved, htftSaved } = await saveAFMarketsToKV(id, jo, diag);
      if (bttsSaved) savedBTTS += 1;
      if (htftSaved) savedHTFT += 1;
      touched++;
    } catch (e) {
      diag && (diag.odds = diag.odds || []).push({ fixture: id, ok: false, err: String(e?.message || e) });
    }
  }
  return { touched, savedBTTS, savedHTFT };
}

/* ---------- TheOddsAPI (batch OU2.5 enrichment, dnevni limit) ---------- */
const OA_BASE = (process.env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4").replace(/\/+$/, "");
const OA_KEY = (process.env.ODDS_API_KEY || "").trim();
const OA_REGION_STR = (process.env.ODDS_API_REGION || process.env.ODDS_API_REGIONS || "eu").trim();
const OA_MARKETS_STR = (process.env.ODDS_API_MARKETS || "h2h,totals").trim();
const OA_DAILY_CAP = Math.max(1, Number(process.env.ODDS_API_DAILY_CAP || 15) || 15);

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|sc|afc|cf|bk|women|w|u\d+)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function withinMinutes(aISO, bISO, minutes = 360) {
  const a = Date.parse(aISO || 0);
  const b = Date.parse(bISO || 0);
  if (!a || !b) return false;
  return Math.abs(a - b) <= minutes * 60 * 1000;
}
function pickTotals25(bookmakers) {
  let over = null,
    under = null,
    books = 0;
  if (!Array.isArray(bookmakers)) return null;
  for (const bm of bookmakers) {
    const mkts = Array.isArray(bm?.markets) ? bm.markets : [];
    for (const m of mkts) {
      if (String(m?.key || "").toLowerCase() !== "totals") continue;
      const outs = Array.isArray(m?.outcomes) ? m.outcomes : [];
      const pts = Number(outs?.[0]?.point ?? outs?.[1]?.point ?? NaN);
      if (!Number.isFinite(pts) || Math.abs(pts - 2.5) > 0.05) continue;
      const oOver = outs.find((x) => String(x?.name || "").toLowerCase() === "over");
      const oUnder = outs.find((x) => String(x?.name || "").toLowerCase() === "under");
      const pOver = Number(oOver?.price);
      const pUnder = Number(oUnder?.price);
      let touched = false;
      if (Number.isFinite(pOver) && pOver > 1.01) {
        if (!over || pOver > over) over = pOver;
        touched = true;
      }
      if (Number.isFinite(pUnder) && pUnder > 1.01) {
        if (!under || pUnder > under) under = pUnder;
        touched = true;
      }
      if (touched) books += 1;
    }
  }
  if (!over && !under) return null;
  return { line: 2.5, over: over || null, under: under || null, books_count: books };
}

async function tryTheOddsBatchMapAndSave(ids, diag) {
  if (!OA_KEY) {
    return { matched: 0, saved: 0, calls: 0, budget_per_day: OA_DAILY_CAP, remaining_before: 0, used_now: 0 };
  }
  const ymd = ymdInTZ(new Date(), TZ);
  const capKey = `oaanalysis:${ymd}:calls`;
  const { raw } = await kvGET(capKey, diag);
  const used = Number(J(raw)) || 0;
  if (used >= OA_DAILY_CAP) {
    return { matched: 0, saved: 0, calls: 0, budget_per_day: OA_DAILY_CAP, remaining_before: Math.max(0, OA_DAILY_CAP - used), used_now: 0 };
  }

  // Ensure we have AF metadata for each fixture id
  const meta = new Map(); // id -> {home, away, kickoff}
  for (const id of ids) {
    const j = await afFetch("/fixtures", { id }, afFixturesHeaders(), "fixture:byid", diag);
    const r = Array.isArray(j?.response) ? j.response[0] : null;
    const home = r?.teams?.home?.name || "";
    const away = r?.teams?.away?.name || "";
    const dt = r?.fixture?.date || null;
    if (home && away && dt) meta.set(id, { home, away, kickoff: dt });
  }
  if (meta.size === 0) {
    return { matched: 0, saved: 0, calls: 0, budget_per_day: OA_DAILY_CAP, remaining_before: Math.max(0, OA_DAILY_CAP - used), used_now: 0 };
  }

  // Single batch call to TheOddsAPI
  const url = new URL(`${OA_BASE}/sports/soccer/odds`);
  url.searchParams.set("apiKey", OA_KEY);
  url.searchParams.set("regions", OA_REGION_STR || "eu");
  url.searchParams.set("markets", OA_MARKETS_STR || "h2h,totals");
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  let count = 0;
  let remainingHdr = null;
  let ok = false;
  let status = 0;
  let body = "[]";
  try {
    const r = await fetch(url, { cache: "no-store" });
    status = r.status;
    remainingHdr = r.headers.get("x-requests-remaining");
    ok = r.ok;
    body = await r.text();
  } catch (e) {
    status = 0;
    ok = false;
    body = "[]";
  }
  let events = [];
  try {
    events = JSON.parse(body);
  } catch {
    events = [];
  }
  count = Array.isArray(events) ? events.length : 0;

  diag &&
    (diag.odds_api = diag.odds_api || []).push({
      host: OA_BASE,
      path: "/sports/soccer/odds",
      region: OA_REGION_STR || "eu",
      market: OA_MARKETS_STR || "h2h,totals",
      status,
      ok,
      count,
      remaining: Number(remainingHdr ?? NaN),
    });

  // Increase budget usage by 1 call if succeeded
  let usedNow = 0;
  if (ok) {
    await kvINCR(capKey, 1, diag);
    usedNow = 1;
  }

  // Map OA events to AF fixtures
  let matched = 0;
  let saved = 0;

  for (const ev of events) {
    const h = normName(ev?.home_team);
    const a = normName(ev?.away_team);
    const when = ev?.commence_time || "";
    if (!h || !a || !when) continue;

    for (const [fxId, m] of meta.entries()) {
      const hh = normName(m.home);
      const aa = normName(m.away);
      const okTeams =
        (h === hh && a === aa) || (h === aa && a === hh);
      if (!okTeams) continue;
      if (!withinMinutes(when, m.kickoff, 360)) continue;

      // Totals 2.5
      const totals = pickTotals25(ev?.bookmakers);
      if (totals) {
        matched += 1;
        const key = `odds:oa:${fxId}:totals`;
        await kvSET(
          key,
          JSON.stringify({ ...totals, updatedAt: new Date().toISOString() }),
          diag
        );
        saved += 1;
      }
      break;
    }
  }

  const remainingBefore = Math.max(0, OA_DAILY_CAP - used);
  return {
    matched,
    saved,
    calls: usedNow,
    budget_per_day: OA_DAILY_CAP,
    remaining_before: remainingBefore,
    used_now: usedNow,
  };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const wantDebug =
    String(q.debug ?? "") === "1" ||
    String(q.debug ?? "").toLowerCase() === "true";
  const diag = wantDebug ? {} : null;

  try {
    const now = new Date();
    const ymd =
      (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd)))
        ? String(q.ymd)
        : ymdInTZ(now, TZ);
    const slot =
      (q.slot && /^(am|pm|late)$/.test(String(q.slot)))
        ? String(q.slot)
        : deriveSlot(hourInTZ(now, TZ));

    const tried = [];
    let pickedKey = null;
    let list = [];
    let seeded = false;

    async function takeFromKey(key, picker) {
      tried.push(key);
      const { raw } = await kvGET(key, diag);
      const arr = arrFromAny(unpack(raw));
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const ids = (picker ? arr.map(picker) : arr)
        .map((x) => Number(x))
        .filter(Boolean);
      if (!ids.length) return false;
      if (list.length === 0) {
        list = Array.from(new Set(ids));
        pickedKey = key;
      }
      return true;
    }

    await takeFromKey(`vb:day:${ymd}:${slot}`, (x) => x?.fixture_id);
    if (list.length === 0) await takeFromKey(`vb:day:${ymd}:union`, (x) => x?.fixture_id);
    if (list.length === 0) await takeFromKey(`vb:day:${ymd}:last`, (x) => x?.fixture_id);
    if (list.length === 0) await takeFromKey(`vbl_full:${ymd}:${slot}`);
    if (list.length === 0) await takeFromKey(`fixtures:multi`);

    if (list.length === 0) {
      const strict = await fetchFixturesIDsByDateStrict(ymd, slot, diag);
      if (strict.length) list = strict;
      else {
        const whole = await fetchFixturesIDsWholeDay(ymd, slot, diag);
        if (whole.length) list = whole;
      }
      if (list.length) {
        await kvSET(`fixtures:${ymd}:${slot}`, JSON.stringify(list), diag);
        await kvSET(`fixtures:multi`, JSON.stringify(list), diag);
        seeded = true;
      }
    }

    if (list.length === 0) {
      return res.status(200).json({
        ok: true,
        ymd,
        slot,
        inspected: 0,
        filtered: 0,
        targeted: 0,
        touched: 0,
        source: "refresh-odds:no-slot-matches",
        debug: wantDebug
          ? { tried, pickedKey, listLen: 0, forceSeed: seeded, af: diag?.af }
          : undefined,
      });
    }

    const ids = Array.from(new Set(list));
    const afRes = await refreshOddsForIDs(ids, diag);
    const oaSum = await tryTheOddsBatchMapAndSave(ids, diag);

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      inspected: ids.length,
      filtered: 0,
      targeted: ids.length,
      touched: afRes.touched,
      source: pickedKey ? `refresh-odds:${pickedKey}` : "refresh-odds:fallback",
      debug: wantDebug
        ? {
            tried,
            pickedKey,
            listLen: ids.length,
            forceSeed: seeded,
            af: diag?.af,
            odds: diag?.odds,
            odds_api: diag?.odds_api,
            oa_summary: oaSum,
            saved_btts: afRes.savedBTTS,
            saved_htft: afRes.savedHTFT,
          }
        : undefined,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
