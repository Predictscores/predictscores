// pages/api/cron/apply-learning.js
// Settle + history sa dva izvora finala:
// 1) fixtures?ids=... (primarno)
// 2) fixtures?date=YYYY-MM-DD&timezone=UTC (fallback name-match)
// Podržava tržišta: 1X2, OU (Over/Under), BTTS, HT-FT.
// Dodaje _day na svaku history stavku.

function kvEnv() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_URL ||
    "";
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_READ_ONLY_TOKEN ||
    "";
  return { url, token };
}

async function kvPipeline(cmds) {
  const { url, token } = kvEnv();
  if (!url || !token) throw new Error("KV env not set (URL/TOKEN).");
  const r = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`KV pipeline HTTP ${r.status}: ${t}`);
  }
  return r.json();
}
async function kvGet(key) {
  const out = await kvPipeline([["GET", key]]);
  return out?.[0]?.result ?? null;
}
async function kvSet(key, val) {
  const out = await kvPipeline([["SET", key, val]]);
  return out?.[0]?.result ?? "OK";
}
async function kvGetJSON(key) {
  const raw = await kvGet(key);
  if (raw == null) return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try { return JSON.parse(s); } catch { return raw; }
    }
    return raw;
  }
  return raw;
}
async function kvSetJSON(key, obj) {
  return kvSet(key, JSON.stringify(obj));
}

function apiFootballKey() {
  return process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || "";
}

/* ---------- helpers: day lists ---------- */

function isPointerString(x) {
  return typeof x === "string" && /^vb:day:\d{4}-\d{2}-\d{2}:(am|pm|late|union)$/.test(x);
}
function dedupeBySignature(items = []) {
  const out = []; const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? "";
    const mkt = it.market ?? it.market_label ?? "";
    const sel = it.pick ?? it.selection ?? it.selection_label ?? "";
    const sig = `${fid}::${mkt}::${sel}`;
    if (!seen.has(sig)) { seen.add(sig); out.push(it); }
  }
  return out;
}
async function readDayListLastOrNull(ymd) {
  const last = await kvGetJSON(`vb:day:${ymd}:last`);
  if (Array.isArray(last)) return last;
  if (isPointerString(last)) {
    const deref = await kvGetJSON(String(last));
    if (Array.isArray(deref)) return deref;
  }
  if (typeof last === "string") {
    const s = last.trim();
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try { const p = JSON.parse(s); if (Array.isArray(p)) return p; } catch {}
    }
  }
  return null;
}
async function buildDayUnion(ymd) {
  const slots = ["am", "pm", "late"]; const chunks = [];
  for (const slot of slots) {
    const arr = await kvGetJSON(`vbl:${ymd}:${slot}`);
    if (Array.isArray(arr) && arr.length) chunks.push(...arr);
  }
  return dedupeBySignature(chunks);
}
async function ensureDayLastIsList(ymd) {
  const ex = await readDayListLastOrNull(ymd);
  if (ex && ex.length) { await kvSetJSON(`vb:day:${ymd}:union`, dedupeBySignature(ex)); return ex; }
  const union = await kvGetJSON(`vb:day:${ymd}:union`);
  if (Array.isArray(union) && union.length) { await kvSetJSON(`vb:day:${ymd}:last`, union); return union; }
  const built = await buildDayUnion(ymd);
  await kvSetJSON(`vb:day:${ymd}:last`, built);
  await kvSetJSON(`vb:day:${ymd}:union`, built);
  return built;
}

/* ---------- settle helpers ---------- */

function parseOUThreshold(it) {
  const s = (it.selection_label || it.pick || it.selection || it.pick_code || "").toString().toUpperCase();
  const m = s.match(/(O|U|OVER|UNDER)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m) return parseFloat(m[2]);
  const m2 = String(it.market || it.market_label || "").match(/OU\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m2) return parseFloat(m2[1]);
  return 2.5;
}
function pickSide(it) {
  const p = (it.selection_label || it.pick || it.selection || it.pick_code || "").toString().toUpperCase();
  if (p.startsWith("O") || p.startsWith("OVER")) return "OVER";
  if (p.startsWith("U") || p.startsWith("UNDER")) return "UNDER";
  if (p.includes("YES")) return "YES";
  if (p.includes("NO")) return "NO";
  if (p === "1" || p.includes("HOME")) return "HOME";
  if (p === "2" || p.includes("AWAY")) return "AWAY";
  if (p === "X" || p.includes("DRAW")) return "DRAW";
  if (p.includes("/")) return p; // HT/FT
  return p;
}
function winnerFromScore(h, a) { if (h > a) return "HOME"; if (a > h) return "AWAY"; return "DRAW"; }

function decideOutcomeFromFinals(it, finals) {
  if (!finals || typeof finals !== "object") return "PENDING";
  const market = (it.market || it.market_label || "").toUpperCase();
  const side = pickSide(it);
  const ftH = Number(finals.ft_home ?? finals.home ?? NaN);
  const ftA = Number(finals.ft_away ?? finals.away ?? NaN);
  const htH = Number(finals.ht_home ?? NaN);
  const htA = Number(finals.ht_away ?? NaN);
  const ftWinner = winnerFromScore(ftH, ftA);
  const htWinner = Number.isFinite(htH) && Number.isFinite(htA) ? winnerFromScore(htH, htA) : null;
  if (!Number.isFinite(ftH) || !Number.isFinite(ftA)) return "PENDING";

  if (market.includes("1X2") || market === "1X2") {
    if (side === "HOME") return ftWinner === "HOME" ? "WIN" : "LOSE";
    if (side === "DRAW") return ftWinner === "DRAW" ? "WIN" : "LOSE";
    if (side === "AWAY") return ftWinner === "AWAY" ? "WIN" : "LOSE";
  }
  if (market.includes("OU") || market.includes("OVER/UNDER") || market.includes("OVER") || market.includes("UNDER")) {
    const total = ftH + ftA; const thr = parseOUThreshold(it);
    if (side === "OVER") return total > thr ? "WIN" : "LOSE";
    if (side === "UNDER") return total < thr ? "WIN" : "LOSE";
  }
  if (market.includes("BTTS") || market.includes("BOTH") || market.includes("GG/NG")) {
    const btts = ftH > 0 && ftA > 0;
    if (side === "YES") return btts ? "WIN" : "LOSE";
    if (side === "NO") return btts ? "LOSE" : "WIN";
  }
  if (market.includes("HT-FT") || market.includes("HT/FT")) {
    if (htWinner == null) return "PENDING";
    const parts = side.split("/").map((s) => s.trim());
    if (parts.length === 2) {
      const [htPick, ftPick] = parts;
      const okHT = htPick === htWinner;
      const okFT = ftPick === ftWinner;
      return okHT && okFT ? "WIN" : "LOSE";
    }
  }
  return "PENDING";
}

/* ---------- API-FOOTBALL fetch & matching ---------- */

function normalizeName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase().replace(/\s+/g, " ").trim();
}
function makePairKey(home, away) { return `${normalizeName(home)}|${normalizeName(away)}`; }

async function fetchFixturesByIds(ids) {
  const key = apiFootballKey(); if (!key || !ids.length) return {};
  const url = `https://v3.football.api-sports.io/fixtures?ids=${ids.join(",")}`;
  const r = await fetch(url, { headers: { "x-apisports-key": key, "Accept": "application/json" }, cache: "no-store" });
  if (!r.ok) return {};
  const j = await r.json().catch(() => ({}));
  const map = {};
  for (const row of j?.response || []) {
    const fid = row?.fixture?.id;
    const ftH = row?.goals?.home, ftA = row?.goals?.away;
    const htH = row?.score?.halftime?.home, htA = row?.score?.halftime?.away;
    const status = row?.fixture?.status?.short;
    if (fid != null) {
      map[fid] = {
        ft_home: ftH, ft_away: ftA, ht_home: htH, ht_away: htA,
        status, winner: winnerFromScore(Number(ftH), Number(ftA)),
        home_name: row?.teams?.home?.name, away_name: row?.teams?.away?.name,
        provider: "api-football(ids)",
      };
    }
  }
  return map;
}

async function fetchFixturesByDate(ymd) {
  const key = apiFootballKey(); if (!key) return { byPair: {}, rawCount: 0 };
  const url = `https://v3.football.api-sports.io/fixtures?date=${ymd}&timezone=UTC`;
  const r = await fetch(url, { headers: { "x-apisports-key": key, "Accept": "application/json" }, cache: "no-store" });
  if (!r.ok) return { byPair: {}, rawCount: 0 };
  const j = await r.json().catch(() => ({}));
  const byPair = {};
  for (const row of j?.response || []) {
    const home = row?.teams?.home?.name, away = row?.teams?.away?.name;
    const keyPair = makePairKey(home, away);
    const ftH = row?.goals?.home, ftA = row?.goals?.away;
    const htH = row?.score?.halftime?.home, htA = row?.score?.halftime?.away;
    const status = row?.fixture?.status?.short;
    byPair[keyPair] = {
      ft_home: ftH, ft_away: ftA, ht_home: htH, ht_away: htA,
      status, winner: winnerFromScore(Number(ftH), Number(ftA)),
      home_name: home, away_name: away, fixture_id: row?.fixture?.id,
      provider: "api-football(date)",
    };
  }
  return { byPair, rawCount: (j?.response || []).length };
}

async function ensureFinalsFor(ymd, items) {
  const fids = Array.from(new Set(items.map(it => it.fixture_id ?? it.id ?? it.fixtureId).filter(x => x != null)));
  const finalsById = await fetchFixturesByIds(fids);

  // ako je dobijeno malo rezultata, povuci i po datumu
  const needDateFallback = Object.keys(finalsById).length < Math.ceil(fids.length * 0.6);
  let byPair = {};
  if (needDateFallback || !fids.length) {
    const fx = await fetchFixturesByDate(ymd);
    byPair = fx.byPair;
  }

  return { finalsById, finalsByPair: byPair };
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymdParam = url.searchParams.get("ymd");
    const debug = url.searchParams.get("debug") === "1";
    const days = Math.max(1, Math.min(14, parseInt(url.searchParams.get("days") || "1", 10)));

    const today = new Date();
    const ymds = [];
    if (ymdParam) {
      ymds.push(ymdParam);
    } else {
      for (let i = 0; i < days; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        ymds.push(d.toISOString().slice(0, 10));
      }
    }

    const reports = [];

    for (const ymd of ymds) {
      const list = await ensureDayLastIsList(ymd);
      const items = dedupeBySignature(list);

      const { finalsById, finalsByPair } = await ensureFinalsFor(ymd, items);

      let settled = 0, won = 0, lost = 0, voided = 0, pending = 0;
      let staked = 0, returned = 0;
      let matchedById = 0, matchedByName = 0;

      const settledItems = [];

      for (const it of items) {
        const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? null;
        const odds = Number(it?.odds?.price ?? 1) || 1;

        let finals = null;
        let outcome = "PENDING";
        let reason = "none";

        if (fid != null && finalsById[fid]) {
          finals = finalsById[fid];
          outcome = decideOutcomeFromFinals(it, finals);
          reason = "id";
          if (finals) matchedById++;
        }

        if (outcome === "PENDING") {
          // pokušaj name-match po datumu
          const home = it.home?.name || it.home || it?.teams?.home || "";
          const away = it.away?.name || it.away || it?.teams?.away || "";
          const key1 = makePairKey(home, away);
          const key2 = makePairKey(away, home); // za svaki slučaj
          if (finalsByPair[key1] || finalsByPair[key2]) {
            finals = finalsByPair[key1] || finalsByPair[key2];
            outcome = decideOutcomeFromFinals(it, finals);
            reason = "nameMatch";
            matchedByName++;
          }
        }

        if (outcome === "WIN") { staked += 1; returned += odds; settled += 1; won += 1; }
        else if (outcome === "LOSE") { staked += 1; returned += 0; settled += 1; lost += 1; }
        else if (outcome === "VOID" || outcome === "PUSH") { settled += 1; voided += 1; }
        else { pending += 1; }

        settledItems.push({ ...it, outcome, finals: finals || null, _day: ymd, _settle_reason: reason });
      }

      const roi = staked > 0 ? (returned - staked) / staked : 0;

      const historyPayload = {
        ymd,
        counts: { total: items.length, settled, won, lost, voided, pending },
        roi: { staked, returned, roi },
        items: settledItems,
        meta: {
          builtAt: new Date().toISOString(),
          finals_by_id: Object.keys(finalsById).length,
          finals_by_name: matchedByName,
          matchedById, matchedByName,
        },
      };

      await kvSetJSON(`hist:${ymd}`, historyPayload);
      await kvSetJSON(`hist:day:${ymd}`, historyPayload);
      await kvSetJSON(`vb:day:${ymd}:last`, items);
      await kvSetJSON(`vb:day:${ymd}:union`, items);

      reports.push({
        ymd,
        totals: historyPayload.counts,
        roi: historyPayload.roi,
        ...(debug ? { meta: historyPayload.meta } : {}),
      });
    }

    res.status(200).json({ ok: true, days: ymds.length, report: reports });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
