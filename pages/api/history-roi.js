// pages/api/history-roi.js
// Aggregates results ONLY from Combined logic: Top-N per slot (AM/PM/LATE) for the last N days.
// Returns summary (W/L/ROI) + per-day breakdown + grouped items for a clean UI rendering.
//
// Params:
//   ?days=14     -> lookback window (1..60)
//   ?top=3       -> Top-N items per slot (1..10), matching Combined Top-3
//   ?slots=am,pm,late  -> filter which slots to include (defaults to all present)
// Notes:
//   - Prefers vb:score:<fixture_id> from KV (written by your score-sync workflow).
//   - Falls back to API-Football only if no vb:score exists AND API key is available.
//   - Uses locked snapshot odds from vbl_full:<YMD>:<slot> (or vbl:<...>), exactly what Combined shows.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";
const API_HOST = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// ---------------- utils ----------------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function ymd(dt = new Date()) {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short" })
    .format(dt)
    .replaceAll("/", "-");
  return s; // YYYY-MM-DD
}
function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}
function toLocalHHMM(dateStr) {
  if (!dateStr) return "";
  const ms = Date.parse(dateStr.replace(" ", "T"));
  if (!Number.isFinite(ms)) return "";
  const dt = new Date(ms);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(dt);
}
async function safeJson(r) {
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await r.json();
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { ok:false, error:"non-json", raw:t }; }
}

// ---------------- Upstash KV ----------------
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  const j = await safeJson(r);
  if (j && typeof j.result !== "undefined" && j.result !== null) {
    try { return JSON.parse(j.result); } catch { return j.result; }
  }
  return null;
}
async function kvSet(key, value, ttlSeconds = 21600) {
  if (!KV_URL || !KV_TOKEN) return false;
  const val = typeof value === "string" ? value : JSON.stringify(value);
  const url = `${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?EX=${ttlSeconds}`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  return r.ok;
}

// ---------------- Scores (prefer KV -> fallback API) ----------------
async function readScoreFromKV(fixtureId) {
  const key = `vb:score:${fixtureId}`;
  const s = await kvGet(key);
  if (!s) return null;
  // Expected shape from your score-sync: { statusShort, ftHome, ftAway, htHome, htAway, ... }
  const out = {
    statusShort: s.statusShort || "",
    ftHome: numOrNull(s.ftHome ?? s.goalsHome),
    ftAway: numOrNull(s.ftAway ?? s.goalsAway),
    htHome: numOrNull(s.htHome),
    htAway: numOrNull(s.htAway),
  };
  return out;
}
function numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
async function readScoreViaAPI(fixtureId) {
  if (!API_KEY) return null;
  try {
    const r = await fetch(`${API_HOST}/fixtures?id=${fixtureId}`, {
      headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
      cache: "no-store",
    });
    const j = await safeJson(r);
    const it = j?.response?.[0];
    if (!it) return null;
    const out = {
      statusShort: it?.fixture?.status?.short || "",
      ftHome: numOrNull(it?.score?.fulltime?.home ?? it?.goals?.home),
      ftAway: numOrNull(it?.score?.fulltime?.away ?? it?.goals?.away),
      htHome: numOrNull(it?.score?.halftime?.home),
      htAway: numOrNull(it?.score?.halftime?.away),
    };
    // cache briefly to avoid spam
    await kvSet(`fx:${fixtureId}`, out, (out.statusShort === "FT" || out.statusShort === "AET" || out.statusShort === "PEN") ? 21600 : 900);
    return out;
  } catch {
    return null;
  }
}
async function getFinalScore(fixtureId) {
  // Try vb:score first
  const kv = await readScoreFromKV(fixtureId);
  if (kv && (kv.statusShort === "FT" || kv.statusShort === "AET" || kv.statusShort === "PEN")) return kv;

  // Fallback to short cache (fx:<id>)
  const cached = await kvGet(`fx:${fixtureId}`);
  if (cached && (cached.statusShort === "FT" || cached.statusShort === "AET" || cached.statusShort === "PEN")) return cached;

  // If still nothing, try API
  return await readScoreViaAPI(fixtureId);
}

// ---------------- Settlement helpers ----------------
function result1X2(h, a) {
  if (h > a) return "1";
  if (h < a) return "2";
  return "X";
}
function parseOU(codeOrLabel) {
  const m = String(codeOrLabel || "").match(/([OU])\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return null;
  return { side: m[1].toUpperCase(), line: parseFloat(m[2]) };
}
function settlePick(market, pick_code, goalsHome, goalsAway, htHome=null, htAway=null, ftHome=null, ftAway=null) {
  const mkt = String(market || "").toUpperCase();
  const code = String(pick_code || "").toUpperCase();
  const h = Number.isFinite(ftHome) ? ftHome : goalsHome;
  const a = Number.isFinite(ftAway) ? ftAway : goalsAway;

  if (!Number.isFinite(h) || !Number.isFinite(a)) return { settled: false, push: false, won: null };

  if (mkt === "1X2" || mkt === "1X" || mkt === "X2" || mkt === "12") {
    const ft = result1X2(h, a);
    if (code.length === 1) return { settled: true, push: false, won: ft === code };
    if (code === "1X") return { settled: true, push: false, won: ft === "1" || ft === "X" };
    if (code === "12") return { settled: true, push: false, won: ft === "1" || ft === "2" };
    if (code === "X2") return { settled: true, push: false, won: ft === "X" || ft === "2" };
    return { settled: true, push: false, won: false };
  }

  if (mkt.includes("BTTS")) {
    const both = (h>=1 && a>=1);
    if (code.startsWith("Y")) return { settled: true, push: false, won: both };
    if (code.startsWith("N")) return { settled: true, push: false, won: !both };
    return { settled: true, push: false, won: false };
  }

  if (mkt.includes("OU") || code.startsWith("O") || code.startsWith("U")) {
    const total = h + a;
    const p = parseOU(code) || parseOU(mkt);
    if (!p) return { settled: true, push: false, won: false };
    if (total === p.line) return { settled: true, push: true, won: false };
    if (p.side === "O") return { settled: true, push: false, won: total > p.line };
    if (p.side === "U") return { settled: true, push: false, won: total < p.line };
    return { settled: true, push: false, won: false };
  }

  if (mkt.includes("HT/FT") || mkt.includes("HTFT")) {
    if (!Number.isFinite(htHome) || !Number.isFinite(htAway)) return { settled: false, push: false, won: null };
    const ht = result1X2(htHome, htAway);
    const ft = result1X2(h, a);
    // Expect pick_code like "HD" "AA" with H=1, D=X, A=2
    const map = { H:"1", D:"X", A:"2" };
    if (code.length !== 2) return { settled: true, push: false, won: false };
    const needHT = map[code[0]] || "?";
    const needFT = map[code[1]] || "?";
    return { settled: true, push: false, won: ht === needHT && ft === needFT };
  }

  const ft = result1X2(h, a);
  return { settled: true, push: false, won: ft === code };
}

function unitReturn(odds, won, push) {
  const o = Number(odds) || 0;
  if (push) return 1;
  if (won) return o;
  return 0;
}

// ---------------- Combined Top-N picker ----------------
function scoreForSort(it) {
  // Match Combined sorting: prioritize confidence, then model_prob, then EV/edge if present
  const c = Number(it?.confidence_pct ?? it?.confidence ?? 0);
  const p = Number(it?.model_prob ?? 0);
  const ev = Number(it?.ev ?? it?.edge ?? 0);
  // Weighted tuple
  return c * 10000 + p * 100 + ev;
}
function topNCombined(items, n = 3) {
  return [...(items || [])]
    .sort((a, b) => scoreForSort(b) - scoreForSort(a))
    .slice(0, n);
}

// ---------------- main handler ----------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const days = clamp(Number(url.searchParams.get("days") || 14), 1, 60);
    const top = clamp(Number(url.searchParams.get("top") || 3), 1, 10);
    const slotsParam = (url.searchParams.get("slots") || "am,pm,late")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const SLOTS = Array.from(new Set(slotsParam.length ? slotsParam : ["am","pm","late"]));

    const now = new Date();
    const start = addDays(new Date(now), -days + 1);

    const daysOut = [];
    let agg = { picks: 0, settled: 0, wins: 0, pushes: 0, stake: 0, payout: 0 };

    for (let d = 0; d < days; d++) {
      const date = addDays(start, d);
      const dateYMD = ymd(date);

      const itemsOut = [];
      let day = { ymd: dateYMD, picks: 0, settled: 0, wins: 0, pushes: 0, stake: 0, payout: 0 };

      for (const slot of SLOTS) {
        const snap = (await kvGet(`vbl_full:${dateYMD}:${slot}`)) || (await kvGet(`vbl:${dateYMD}:${slot}`));
        if (!Array.isArray(snap) || snap.length === 0) continue;

        // Combined uses Top-N
        const topItems = topNCombined(snap, top);

        for (const it of topItems) {
          const fixtureId = it?.fixture_id || it?.fixtureId || it?.fixture?.id;
          if (!fixtureId) continue;

          const timeLocal = it?.datetime_local?.starting_at?.date_time || it?.kickoff || it?.date || null;
          const odds = Number(it?.odds?.price ?? it?.odds ?? 0) || null;

          // resolve score/status
          const fx = await getFinalScore(fixtureId);
          let status = "pending";
          let win = false;
          let push = false;

          if (fx && (fx.statusShort === "FT" || fx.statusShort === "AET" || fx.statusShort === "PEN")) {
            const st = settlePick(
              String(it.market || it.market_label || ""),
              String(it.pick_code || it.selection || it.pick || ""),
              fx.ftHome, fx.ftAway, fx.htHome, fx.htAway, fx.ftHome, fx.ftAway
            );
            if (st.settled) {
              status = st.push ? "push" : (st.won ? "win" : "loss");
              win = !!st.won; push = !!st.push;
            }
          }

          // aggregate
          day.picks += 1;
          if (status !== "pending") {
            day.settled += 1;
            if (win) day.wins += 1;
            if (push) day.pushes += 1;
            day.stake += 1;
            day.payout += unitReturn(odds, win, push);
          }

          itemsOut.push({
            ymd: dateYMD,
            time_hhmm: toLocalHHMM(timeLocal),
            league_name: it?.league_name || it?.league?.name || "",
            league_country: it?.league?.country || "",
            home: it?.home || it?.teams?.home || "",
            away: it?.away || it?.teams?.away || "",
            market: it?.market || it?.market_label || "",
            pick_code: it?.pick_code || it?.selection || it?.pick || "",
            selection_label: it?.selection_label || "",
            odds,
            fixture_id: fixtureId,
            status,
          });
        }
      }

      const profit = +(day.payout - day.stake).toFixed(3);
      const roi_pct = day.stake > 0 ? +(((day.payout - day.stake) / day.stake) * 100).toFixed(2) : 0;
      const win_rate_pct = day.settled > 0 ? +((day.wins / day.settled) * 100).toFixed(2) : 0;

      daysOut.push({
        ymd: dateYMD,
        picks: day.picks,
        settled: day.settled,
        wins: day.wins,
        pushes: day.pushes,
        profit, roi_pct, win_rate_pct,
        items: itemsOut.sort((a,b) => (a.time_hhmm || "").localeCompare(b.time_hhmm || "")),
      });

      agg.picks += day.picks;
      agg.settled += day.settled;
      agg.wins += day.wins;
      agg.pushes += day.pushes;
      agg.stake += day.stake;
      agg.payout += day.payout;
    }

    const summary = {
      days, top, slots: SLOTS,
      picks: agg.picks,
      settled: agg.settled,
      wins: agg.wins,
      pushes: agg.pushes,
      profit: +(agg.payout - agg.stake).toFixed(3),
      roi_pct: agg.stake > 0 ? +(((agg.payout - agg.stake) / agg.stake) * 100).toFixed(2) : 0,
      win_rate_pct: agg.settled > 0 ? +((agg.wins / agg.settled) * 100).toFixed(2) : 0,
    };

    res.status(200).json({ ok: true, summary, days: daysOut });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
