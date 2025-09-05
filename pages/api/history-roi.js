// pages/api/history-roi.js
// Aggregates results ONLY from Combined logic: Top-N per slot (AM/PM/LATE) for the last N days.
// Falls back across snapshots: vbl_full -> vbl -> vb:day -> hist
// Computes W/L/Push and ROI (stake counts ONLY when odds are valid).

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";
const API_HOST = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// --- timeouts & concurrency ---
const FETCH_TIMEOUT_MS = Number(process.env.HISTORY_TIMEOUT_MS || 5500);
const KV_TIMEOUT_MS = Number(process.env.HISTORY_KV_TIMEOUT_MS || 4500);
const SCORE_CONCURRENCY = Math.max(2, Math.min(8, Number(process.env.HISTORY_SCORE_CONCURRENCY || 6)));

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function ymd(dt = new Date()) {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short" })
    .format(dt).replaceAll("/", "-");
  return s;
}
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function toLocalHHMM(dateStr) {
  if (!dateStr) return "";
  const ms = Date.parse(String(dateStr).replace(" ", "T"));
  if (!Number.isFinite(ms)) return "";
  const dt = new Date(ms);
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(dt);
}
async function safeJson(r) {
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await r.json();
  const t = await r.text(); try { return JSON.parse(t); } catch { return { ok:false, error:"non-json", raw:t }; }
}

// --- helpers: fetch with timeout ---
async function fetchWithTimeout(url, opts={}, ms=FETCH_TIMEOUT_MS){
  const c = new AbortController();
  const id = setTimeout(()=>c.abort(new Error("timeout")), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal, cache: "no-store" });
  } finally {
    clearTimeout(id);
  }
}

// ---------------- Upstash KV ----------------
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetchWithTimeout(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    }, KV_TIMEOUT_MS);
    const j = await safeJson(r);
    if (j && typeof j.result !== "undefined" && j.result !== null) {
      try { return JSON.parse(j.result); } catch { return j.result; }
    }
    return null;
  } catch { return null; }
}
async function kvSet(key, value, ttlSeconds = 21600) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const val = typeof value === "string" ? value : JSON.stringify(value);
    const url = `${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?EX=${ttlSeconds}`;
    const r = await fetchWithTimeout(url, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` } }, KV_TIMEOUT_MS);
    return r.ok;
  } catch { return false; }
}

// ---------------- Scores (prefer KV -> fallback API) ----------------
function numOrNull(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
async function readScoreFromKV(fixtureId) {
  const s = await kvGet(`vb:score:${fixtureId}`);
  if (!s) return null;
  return {
    statusShort: s.statusShort || "",
    ftHome: numOrNull(s.ftHome ?? s.goalsHome),
    ftAway: numOrNull(s.ftAway ?? s.goalsAway),
    htHome: numOrNull(s.htHome),
    htAway: numOrNull(s.htAway),
  };
}
async function readScoreViaAPI(fixtureId) {
  if (!API_KEY) return null;
  try {
    const r = await fetchWithTimeout(`${API_HOST}/fixtures?id=${fixtureId}`, {
      headers: { "x-apisports-key": API_KEY, Accept: "application/json" }
    }, FETCH_TIMEOUT_MS);
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
    // cache quick
    await kvSet(`fx:${fixtureId}`, out, (out.statusShort === "FT" || out.statusShort === "AET" || out.statusShort === "PEN") ? 21600 : 900);
    return out;
  } catch { return null; }
}
async function getFinalScore(fixtureId) {
  const kv = await readScoreFromKV(fixtureId);
  if (kv && (kv.statusShort === "FT" || kv.statusShort === "AET" || kv.statusShort === "PEN")) return kv;
  const cached = await kvGet(`fx:${fixtureId}`);
  if (cached && (cached.statusShort === "FT" || cached.statusShort === "AET" || cached.statusShort === "PEN")) return cached;
  return await readScoreViaAPI(fixtureId);
}

// ---------------- Settlement helpers ----------------
function result1X2(h, a) { if (h>a) return "1"; if (h<a) return "2"; return "X"; }
function parseOU(codeOrLabel) {
  const m = String(codeOrLabel || "").match(/([OU])\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return null; return { side: m[1].toUpperCase(), line: parseFloat(m[2]) };
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
  const c = Number(it?.confidence_pct ?? it?.confidence ?? 0);
  const p = Number(it?.model_prob ?? 0);
  const ev = Number(it?.ev ?? it?.edge ?? 0);
  return c * 10000 + p * 100 + ev;
}
function topNCombined(items, n = 3) {
  return [...(items || [])].sort((a, b) => scoreForSort(b) - scoreForSort(a)).slice(0, n);
}

// ---------------- Snapshots fallback chain ----------------
async function getSnapshotItems(ymd, slot) {
  const candidates = [
    `vbl_full:${ymd}:${slot}`,
    `vbl:${ymd}:${slot}`,
    `vb:day:${ymd}:${slot}`,
    `hist:${ymd}:${slot}`,
  ];
  for (const key of candidates) {
    const v = await kvGet(key);
    if (!v) continue;
    if (Array.isArray(v) && v.length) return v;
    if (v && Array.isArray(v.items) && v.items.length) return v.items; // hist:{items:[]}
  }
  return [];
}

// --- simple concurrency limiter for getFinalScore ---
async function runLimited(tasks, limit=SCORE_CONCURRENCY){
  const out = [];
  let i = 0, active = 0;
  return await new Promise(resolve=>{
    const next = () => {
      while (active < limit && i < tasks.length){
        const idx = i++;
        active++;
        tasks[idx]().then(v => { out[idx]=v; })
          .catch(()=>{ out[idx]=null; })
          .finally(()=>{ active--; if (i>=tasks.length && active===0) resolve(out); else next(); });
      }
    };
    next();
  });
}

// ---------------- main handler ----------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const days = clamp(Number(url.searchParams.get("days") || 14), 1, 60);
    const top = clamp(Number(url.searchParams.get("top") || 3), 1, 10);
    const slotsParam = (url.searchParams.get("slots") || "am,pm,late").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const SLOTS = Array.from(new Set(slotsParam.length ? slotsParam : ["am", "pm", "late"]));

    const now = new Date();
    const start = addDays(new Date(now), -days + 1);

    const daysOut = [];
    let agg = { picks: 0, settled: 0, wins: 0, pushes: 0, stake: 0, payout: 0 };

    for (let d = 0; d < days; d++) {
      const date = addDays(start, d);
      const dateYMD = ymd(date);

      const itemsOut = [];
      let day = { ymd: dateYMD, picks: 0, settled: 0, wins: 0, pushes: 0, stake: 0, payout: 0 };

      // prvo skupi sve top picks po slotu
      const perSlotTop = [];
      for (const slot of SLOTS) {
        const snap = await getSnapshotItems(dateYMD, slot);
        if (!Array.isArray(snap) || snap.length === 0) continue;
        perSlotTop.push(...topNCombined(snap, top));
      }

      if (perSlotTop.length) {
        // pripremi tasks za rezultat (sa limitiranom paralelom)
        const tasks = perSlotTop.map((it) => async () => {
          const fixtureId = it?.fixture_id || it?.fixtureId || it?.fixture?.id;
          if (!fixtureId) return { it, fx: null };

          const fx = await getFinalScore(fixtureId);
          return { it, fx };
        });

        const scored = await runLimited(tasks, SCORE_CONCURRENCY);

        for (const node of scored) {
          if (!node || !node.it) continue;
          const it = node.it;
          const fx = node.fx;

          const fixtureId = it?.fixture_id || it?.fixtureId || it?.fixture?.id;
          const timeLocal = it?.datetime_local?.starting_at?.date_time || it?.kickoff || it?.date || null;
          const oddsRaw = it?.odds?.price ?? it?.odds ?? null;
          const odds = Number(oddsRaw);
          const hasOdds = Number.isFinite(odds) && odds >= 1.01;

          let status = "pending", win = false, push = false;

          if (fx && (fx.statusShort === "FT" || fx.statusShort === "AET" || fx.statusShort === "PEN")) {
            const st = settlePick(
              String(it.market || it.market_label || ""),
              String(it.pick_code || it.selection || it.pick || ""),
              fx.ftHome, fx.ftAway, fx.htHome, fx.htAway, fx.ftHome, fx.ftAway
            );
            if (st.settled) {
              status = st.push ? "push" : (st.won ? "win" : "loss");
              win = !!st.won; push = !!st.push;
              day.settled += 1;
              if (win) day.wins += 1;
              if (push) day.pushes += 1;
              if (hasOdds) { day.stake += 1; day.payout += unitReturn(odds, win, push); }
            }
          }

          day.picks += 1;

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
            odds: hasOdds ? odds : null,
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
