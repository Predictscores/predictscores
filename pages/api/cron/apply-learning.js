// pages/api/cron/apply-learning.js
// Settling i history SAMO nad vb:day:<YMD>:combined (Top 3).
// Ako combined nedostaje ili je prazan, SAM pokreće /api/cron/rebuild (koji po potrebi poziva /api/score-sync).
// Podrazumevani YMD je Europe/Belgrade. Presuđuje 1X2, OU, BTTS, HT-FT.
import { afxGetJson } from "../../../lib/sources/apiFootball";

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
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`KV pipeline HTTP ${r.status}: ${t}`); }
  return r.json();
}
async function kvGet(key) { const out = await kvPipeline([["GET", key]]); return out?.[0]?.result ?? null; }
async function kvSet(key, val) { const out = await kvPipeline([["SET", key, val]]); return out?.[0]?.result ?? "OK"; }
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
async function kvSetJSON(key, obj) { return kvSet(key, JSON.stringify(obj)); }

function ymdInTZ(tz = "Europe/Belgrade", d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const dd = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${dd}`;
}

/* ---------- ranking / combined helpers ---------- */

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
function rankOf(it) {
  const c = Number(it?.confidence_pct);
  const p = Number(it?.model_prob);
  const evlb = Number(it?._ev_lb);
  const ev = Number(it?._ev);
  return [
    - (Number.isFinite(c) ? c : -1),
    - (Number.isFinite(p) ? p : -1),
    - (Number.isFinite(evlb) ? evlb : -1),
    - (Number.isFinite(ev) ? ev : -1),
  ];
}
function top3Combined(items) {
  const byRank = [...items].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  const out = []; const seenFixtures = new Set();
  for (const it of byRank) {
    const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? it?.fixture?.id ?? null;
    if (fid != null && seenFixtures.has(fid)) continue;
    out.push(it);
    if (fid != null) seenFixtures.add(fid);
    if (out.length >= 3) break;
  }
  return out;
}

/* ---------- settle rules ---------- */

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
      const okHT =
        htPick === "HOME" ? htWinner === "HOME" :
        htPick === "AWAY" ? htWinner === "AWAY" :
        htPick === "DRAW" ? htWinner === "DRAW" : false;
      const okFT =
        ftPick === "HOME" ? ftWinner === "HOME" :
        ftPick === "AWAY" ? ftWinner === "AWAY" :
        ftPick === "DRAW" ? ftWinner === "DRAW" : false;
      return okHT && okFT ? "WIN" : "LOSE";
    }
  }
  return "PENDING";
}

function normalizeName(s) { return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\s+/g," ").trim(); }
function makePairKey(home, away) { return `${normalizeName(home)}|${normalizeName(away)}`; }

async function fetchFixturesByIds(ids) {
  if (!ids || !ids.length) return {};
  const path = `/fixtures?ids=${ids.join(",")}`;
  const j = await afxGetJson(path, { priority: "P1" });
  if (!j) return {};
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
  if (!ymd) return {};
  const path = `/fixtures?date=${ymd}&timezone=UTC`;
  const j = await afxGetJson(path, { priority: "P1" });
  if (!j) return {};
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
  return byPair;
}
function ymdShift(ymd, deltaDays) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0,10);
}
async function ensureFinalsFor(ymd, items) {
  const fids = Array.from(new Set(items.map(it => it.fixture_id ?? it.id ?? it.fixtureId).filter(x => x != null)));
  const byId = await fetchFixturesByIds(fids);
  const byPair = {};
  if (Object.keys(byId).length < Math.ceil(fids.length * 0.6)) {
    for (const dd of [0, -1, 1]) {
      const add = await fetchFixturesByDate(dd === 0 ? ymd : ymdShift(ymd, dd));
      Object.assign(byPair, add);
    }
  }
  return { byId, byPair };
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const tzYmd = ymdInTZ("Europe/Belgrade");
    const ymd = url.searchParams.get("ymd") || tzYmd;
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const base = `${proto}://${req.headers.host}`;
    const debug = url.searchParams.get("debug") === "1";
    const days = ymd ? 1 : Math.max(1, Math.min(14, parseInt(url.searchParams.get("days") || "1", 10)));

    const ymds = ymd ? [ymd] : Array.from({ length: days }, (_, i) => {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
      return ymdInTZ("Europe/Belgrade", d);
    });

    const reports = [];

    for (const theDay of ymds) {
      // 1) pokušaj combined
      let combined = await kvGetJSON(`vb:day:${theDay}:combined`);
      if (!Array.isArray(combined) || !combined.length) {
        // 1a) probaj rebuild (on po potrebi zove score-sync)
        await fetch(`${base}/api/cron/rebuild?ymd=${encodeURIComponent(theDay)}`, { cache: "no-store" }).then(r => r.text()).catch(() => {});
        combined = await kvGetJSON(`vb:day:${theDay}:combined`);
      }
      if (!Array.isArray(combined) || !combined.length) {
        // 1b) kao poslednji fallback, pokušaj score-sync → rebuild
        await fetch(`${base}/api/score-sync?ymd=${encodeURIComponent(theDay)}`, { cache: "no-store" }).then(r => r.text()).catch(() => {});
        await fetch(`${base}/api/cron/rebuild?ymd=${encodeURIComponent(theDay)}`, { cache: "no-store" }).then(r => r.text()).catch(() => {});
        combined = await kvGetJSON(`vb:day:${theDay}:combined`);
      }

      const items = Array.isArray(combined) ? dedupeBySignature(combined) : [];

      // 2) finalni rezultati
      const { byId, byPair } = await ensureFinalsFor(theDay, items);

      let settled = 0, won = 0, lost = 0, voided = 0, pending = 0;
      let staked = 0, returned = 0;
      let matchedById = 0, matchedByName = 0;

      const settledItems = [];

      for (const it of items) {
        const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? null;
        const odds = Number(it?.odds?.price ?? 1) || 1;
        const home = it.home?.name || it.home || it?.teams?.home || "";
        const away = it.away?.name || it.away || it?.teams?.away || "";
        const keyPair = makePairKey(home, away);

        let finals = null;
        let outcome = "PENDING";
        let reason = "none";

        if (fid != null && byId[fid]) {
          finals = byId[fid];
          outcome = decideOutcomeFromFinals(it, finals);
          reason = "id";
          matchedById++;
        }
        if (outcome === "PENDING" && (byPair[keyPair] || byPair[makePairKey(away, home)])) {
          finals = byPair[keyPair] || byPair[makePairKey(away, home)];
          outcome = decideOutcomeFromFinals(it, finals);
          reason = "nameMatch";
          matchedByName++;
        }

        if (outcome === "WIN") { staked += 1; returned += odds; settled += 1; won += 1; }
        else if (outcome === "LOSE") { staked += 1; returned += 0; settled += 1; lost += 1; }
        else if (outcome === "VOID" || outcome === "PUSH") { settled += 1; voided += 1; }
        else { pending += 1; }

        settledItems.push({ ...it, outcome, finals: finals || null, _day: theDay, _source: "combined" });
      }

      const roi = staked > 0 ? (returned - staked) / staked : 0;

      const historyPayload = {
        ymd: theDay,
        counts: { total: items.length, settled, won, lost, voided, pending },
        roi: { staked, returned, roi },
        items: settledItems,
        meta: {
          builtAt: new Date().toISOString(),
          finals_by_id: Object.keys(byId).length,
          matchedById, matchedByName,
          source: "combined",
        },
      };

      await kvSetJSON(`hist:${theDay}`, historyPayload);
      await kvSetJSON(`hist:day:${theDay}`, historyPayload);

      reports.push({
        ymd: theDay,
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
