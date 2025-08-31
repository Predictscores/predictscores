// pages/api/cron/rebuild.js
// Rebuild job (value-bets) — slot-wide, sa stratifikacijom kandidata po satima
// - Uzima mečeve za današnji slot (late/am/pm)
// - Povlači odds + predictions, računa medijane, implied, blend modela (predictions vs implied)
// - Guardrails: trusted-only, spread limiti, uplift cap, min odds, itd.
// - Rangira po EV i upisuje u KV:
//     vbl:<YMD>:<slot> (slim, TOP N), vbl_full:<YMD>:<slot> (full, širi preseci)
//   + alias ključevi radi kompatibilnosti: vb-locked:/vb:locked:/vb_locked:/locked:vbl:
// - Ne prazni KV kada nema rezultata

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ------------------------------ vreme ------------------------------
function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    });
    const parts = fmt.formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    const y = d.getUTCFullYear(),
      m = String(d.getUTCMonth() + 1).padStart(2, "0"),
      dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}
function toLocal(dateIso, tz = TZ) {
  try {
    const d = new Date(dateIso);
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return {
      ymd: `${p.year}-${p.month}-${p.day}`,
      hm: `${p.hour}:${p.minute}`,
      hour: Number(p.hour),
      local: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
    };
  } catch {
    return { ymd: ymdInTZ(new Date(), tz), hm: "00:00", hour: 0, local: "" };
  }
}
function slotOfHour(h) { return h < 10 ? "late" : (h < 15 ? "am" : "pm"); }
function windowForSlot(slot) {
  if (slot === "late") return { hmin: 0, hmax: 9, label: "late" };
  if (slot === "am") return { hmin: 10, hmax: 14, label: "am" };
  return { hmin: 15, hmax: 23, label: "pm" };
}
function isWeekend(d = new Date(), tz = TZ) {
  try {
    const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d).toLowerCase();
    return wd.startsWith("sat") || wd.startsWith("sun");
  } catch {
    const wd = d.getUTCDay();
    return wd === 0 || wd === 6;
  }
}

// ------------------------------ ENV helpers ------------------------------
function envBool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function envList(nameA, nameB) {
  const raw = process.env[nameA] || process.env[nameB] || "";
  return String(raw)
    .split(/[,;|\n]/g)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toLowerCase());
}

// ------------------------------ limiti/slotevi ------------------------------
const DEFAULT_LIMIT_WEEKDAY = envNum("SLOT_WEEKDAY_LIMIT", 15);
const DEFAULT_LIMIT_WEEKEND = envNum("SLOT_WEEKEND_LIMIT", 25);
const LIMIT_LATE_WEEKDAY = envNum("SLOT_LATE_WEEKDAY_LIMIT", DEFAULT_LIMIT_WEEKDAY);
const VB_LIMIT = envNum("VB_LIMIT", 0); // 0 = no cap

// ------------------------------ filter/guardrails ------------------------------
const MIN_ODDS = envNum("MIN_ODDS", 1.01);

const TRUSTED_ONLY = envBool("ODDS_TRUSTED_ONLY", false);
const TRUSTED_LIST = envList("TRUSTED_BOOKMAKERS", "TRUSTED_BOOKIES");

const TRUSTED_SPREAD_MAX = Number.isFinite(envNum("TRUSTED_SPREAD_MAX", NaN)) ? envNum("TRUSTED_SPREAD_MAX", NaN) : NaN;
const ALL_SPREAD_MAX = Number.isFinite(envNum("ALL_SPREAD_MAX", NaN)) ? envNum("ALL_SPREAD_MAX", NaN) : NaN;
const UPLIFT_CAP = envNum("TRUSTED_UPLIFT_CAP", 0.08); // max dozvoljeni pomak modela vs implied po ishodu
const ONE_TRUSTED_TOL = envNum("ONE_TRUSTED_TOL", 0.02); // kad je samo 1 trusted kvota, traži makar +2pp naspram implied

const MODEL_ALPHA = envNum("MODEL_ALPHA", 0.4); // težina predictions vs implied (0..1)

const EXCLUDE_WOMEN = envBool("EXCLUDE_WOMEN", true);

// ------------------------------ API-Football ------------------------------
const API_BASE = process.env.API_FOOTBALL_BASE_URL || process.env.API_FOOTBALL || "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "";

function afHeaders() {
  const h = {};
  if (API_KEY) {
    h["x-apisports-key"] = API_KEY; // api-sports v3
    h["x-rapidapi-key"] = API_KEY;  // rapidapi fallback
  }
  return h;
}
async function getJSON(url) {
  const r = await fetch(url, { headers: afHeaders() });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) throw new Error(`AF ${r.status} ${await r.text().catch(() => r.statusText)}`);
  return ct.includes("application/json") ? await r.json() : JSON.parse(await r.text());
}
async function fetchFixturesByDate(ymd) {
  if (!API_KEY) return [];
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/, "")}/fixtures?date=${encodeURIComponent(ymd)}`);
    if (!j || (j.errors && Object.keys(j.errors).length)) return [];
    return Array.isArray(j?.response) ? j.response : [];
  } catch {
    return [];
  }
}
async function fetchOddsForFixture(fixtureId) {
  if (!API_KEY) return [];
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/, "")}/odds?fixture=${encodeURIComponent(fixtureId)}`);
    if (!j || (j.errors && Object.keys(j.errors).length)) return [];
    return Array.isArray(j?.response) ? j.response : [];
  } catch {
    return [];
  }
}
async function fetchPredictionForFixture(fixtureId) {
  if (!API_KEY) return null;
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/, "")}/predictions?fixture=${encodeURIComponent(fixtureId)}`);
    if (!j || (j.errors && Object.keys(j.errors).length)) return null;
    const arr = Array.isArray(j?.response) ? j.response : [];
    return arr[0] || null;
  } catch {
    return null;
  }
}

// ------------------------------ 1X2, trust & spread ------------------------------
function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function isTrustedBook(name) {
  if (!TRUSTED_ONLY) return true; // ako nije uključeno, ne filtriraj
  if (!TRUSTED_LIST.length) return true; // nema liste -> pusti sve
  const n = String(name || "").toLowerCase().trim();
  return TRUSTED_LIST.some(t => n.includes(t));
}

/**
 * Ekstrakcija 1X2 iz odds payload-a (radi i sa "bookmakers[]" i sa "bets[]" oblicima)
 * Vraća:
 *  - med: median cene po ishodu
 *  - counts: broj uključenih bookija po ishodu (posle trust filtera)
 *  - spread: max spread (max(price)/min(price)-1) preko uključenih bookija (uzimajući max od 1/X/2)
 */
function extract1X2FromOdds(oddsPayload) {
  const priceBy = { "1": [], "X": [], "2": [] };
  const seenBy = { "1": new Set(), "X": new Set(), "2": new Set() };

  const roots = Array.isArray(oddsPayload) ? oddsPayload : [];
  const rows = [];
  for (const root of roots) {
    if (!root) continue;
    if (Array.isArray(root.bookmakers)) { for (const bk of root.bookmakers) rows.push(bk); continue; }
    if (Array.isArray(root.bets)) { rows.push(root); continue; }
    if (root.bookmaker && Array.isArray(root.bookmaker.bets)) { rows.push(root.bookmaker); continue; }
  }

  for (const row of rows) {
    const bkmName = String(row?.name ?? row?.bookmaker?.name ?? row?.id ?? row?.bookmaker ?? "");
    if (!isTrustedBook(bkmName)) continue;
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets) {
      const nm = (bet?.name || "").toLowerCase();
      if (!/match\s*winner|1x2|winner/i.test(nm)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals) {
        const lab = (v?.value || v?.label || "").toString().toLowerCase();
        let code = null;
        if (lab === "1" || /^home/.test(lab)) code = "1";
        else if (lab === "x" || /^draw/.test(lab)) code = "X";
        else if (lab === "2" || /^away/.test(lab)) code = "2";
        if (!code) continue;
        const price = Number(v?.odd ?? v?.price ?? v?.odds);
        if (!Number.isFinite(price) || price < MIN_ODDS) continue;
        priceBy[code].push(price);
        if (bkmName) seenBy[code].add(bkmName);
      }
    }
  }

  const med = { "1": median(priceBy["1"]), "X": median(priceBy["X"]), "2": median(priceBy["2"]) };
  const counts = { "1": seenBy["1"].size, "X": seenBy["X"].size, "2": seenBy["2"].size };

  const spreadPer = {};
  for (const k of ["1","X","2"]) {
    const arr = priceBy[k];
    if (arr.length >= 2) {
      const mx = Math.max(...arr), mn = Math.min(...arr);
      spreadPer[k] = mx > 0 ? (mx / mn - 1) : 0;
    } else {
      spreadPer[k] = 0;
    }
  }
  const spread = Math.max(spreadPer["1"], spreadPer["X"], spreadPer["2"]);

  return { med, counts, spread };
}

function normalizeImplied(med) {
  const imp = {
    "1": Number.isFinite(med["1"]) ? 1 / med["1"] : 0,
    "X": Number.isFinite(med["X"]) ? 1 / med["X"] : 0,
    "2": Number.isFinite(med["2"]) ? 1 / med["2"] : 0
  };
  const s = (imp["1"] || 0) + (imp["X"] || 0) + (imp["2"] || 0);
  if (s <= 0) return { "1": null, "X": null, "2": null };
  return { "1": imp["1"] / s, "X": imp["X"] / s, "2": imp["2"] / s };
}

// ------------------------------ ženski filter ------------------------------
function isWomenString(s = "") {
  if (/\b(women|women's|ladies)\b/i.test(s)) return true;
  if (/\b(femenina|feminine|feminin|femminile)\b/i.test(s)) return true;
  if (/\b(dames|dam|kvinner|kvinn|kvinnor)\b/i.test(s)) return true;
  if (/\(w\)/i.test(s)) return true;
  if (/\sW$/i.test(s)) return true; // "Chelsea W"
  if (/女子|여자/.test(s)) return true;
  return false;
}
function isWomensLeague(leagueName = "", teams = { home: "", away: "" }) {
  return EXCLUDE_WOMEN ? (isWomenString(leagueName) || isWomenString(teams.home) || isWomenString(teams.away)) : false;
}

// ------------------------------ KV (Upstash) ------------------------------
async function kvSetJSON_safe(key, value, ttlSec = null) {
  const base = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN nisu postavljeni");

  const urlPOST = ttlSec != null
    ? `${base.replace(/\/+$/, "")}/setex/${encodeURIComponent(key)}/${ttlSec}`
    : `${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}`;

  let r = await fetch(urlPOST, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(value)
  }).catch(() => null);
  if (r && r.ok) return true;

  const urlPATH = ttlSec != null
    ? `${base.replace(/\/+$/, "")}/setex/${encodeURIComponent(key)}/${ttlSec}/${encodeURIComponent(JSON.stringify(value))}`
    : `${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  r = await fetch(urlPATH, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (r && r.ok) return true;

  const msg = r ? await r.text().catch(() => String(r.status)) : "network-error";
  throw new Error(`KV set failed: ${msg.slice(0, 200)}`);
}

// ------------------------------ handler ------------------------------
export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const qSlot = (req.query.slot && String(req.query.slot)) || slotOfHour(toLocal(now, TZ).hour);
    const slotWin = windowForSlot(qSlot);
    const wantDebug = String(req.query.debug || "") === "1";

    let slotLimit = qSlot === "late"
      ? (isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : LIMIT_LATE_WEEKDAY)
      : (isWeekend(now, TZ) ? DEFAULT_LIMIT_WEEKEND : DEFAULT_LIMIT_WEEKDAY);
    if (VB_LIMIT > 0) slotLimit = Math.min(slotLimit, VB_LIMIT);

    const debug = { ymd, slot: qSlot };

    // 1) fixtures → slot → ženske out
    const raw = await fetchFixturesByDate(ymd);
    debug.fixtures_total = Array.isArray(raw) ? raw.length : 0;

    let fixtures = (Array.isArray(raw) ? raw : [])
      .map((r) => {
        const fx = r?.fixture || {};
        const lg = r?.league || {};
        const tm = r?.teams || {};
        const dateIso = fx?.date;
        const loc = toLocal(dateIso, TZ);
        const home = tm?.home?.name || tm?.home || "";
        const away = tm?.away?.name || tm?.away || "";
        return {
          fixture_id: fx?.id,
          date_utc: dateIso,
          local_hour: loc.hour,
          local_str: `${loc.ymd} ${loc.hm}`,
          league: { id: lg?.id, name: lg?.name, country: lg?.country },
          teams: { home, away }
        };
      })
      .filter(fx => fx.fixture_id && fx.date_utc != null);

    debug.after_basic = fixtures.length;

    fixtures = fixtures.filter(fx => fx.local_hour >= slotWin.hmin && fx.local_hour <= slotWin.hmax);
    debug.after_slot = fixtures.length;

    fixtures = fixtures.filter(fx => !isWomensLeague(fx.league?.name, fx.teams));
    debug.after_gender_filter = fixtures.length;

    // 1b) STRATIFIKACIJA kandidata po satima slota (umesto .slice(0, N*3))
    const hours = [];
    for (let h = slotWin.hmin; h <= slotWin.hmax; h++) hours.push(h);
    const maxCandidates = Math.max(1, slotLimit) * 3; // isti budžet kao ranije, ali raspoređen po satima
    const perHour = Math.max(1, Math.ceil(maxCandidates / hours.length));

    const byHour = new Map();
    for (const fx of fixtures) {
      const arr = byHour.get(fx.local_hour) || [];
      arr.push(fx);
      byHour.set(fx.local_hour, arr);
    }
    const bucketed = [];
    for (const h of hours) {
      const arr = (byHour.get(h) || []).slice(0, perHour);
      bucketed.push(...arr);
    }
    fixtures = bucketed.slice(0, maxCandidates);
    debug.considered = fixtures.length;
    debug.strat_hours = { perHour, hours: hours.length };

    // 2) odds/predictions → BLEND modela + guardrails → EV
    const recs = [];
    const dropReasons = { noOdds: 0, spread: 0, prices: 0, noModel: 0, minOdds: 0, ok: 0 };

    for (const fx of fixtures) {
      try {
        const oddsPayload = await fetchOddsForFixture(fx.fixture_id);
        const oddsArr = Array.isArray(oddsPayload) ? oddsPayload : [];
        const { med, counts, spread } = extract1X2FromOdds(oddsArr);

        // bez kvota = nema EV
        if (!Number.isFinite(med["1"]) && !Number.isFinite(med["X"]) && !Number.isFinite(med["2"])) { dropReasons.noOdds++; continue; }

        // spread gate (trusted vs all)
        if (Number.isFinite(TRUSTED_SPREAD_MAX) && TRUSTED_ONLY && spread > TRUSTED_SPREAD_MAX) { dropReasons.spread++; continue; }
        if (Number.isFinite(ALL_SPREAD_MAX) && !TRUSTED_ONLY && spread > ALL_SPREAD_MAX) { dropReasons.spread++; continue; }

        // implied normalizovan
        const impliedN = normalizeImplied(med);
        if (impliedN["1"] == null || impliedN["X"] == null || impliedN["2"] == null) { dropReasons.prices++; continue; }

        // predictions (ako ima)
        const pred = await fetchPredictionForFixture(fx.fixture_id).catch(() => null);
        const comp = pred?.predictions || pred?.prediction || pred || {};
        const pHome = Number(String(comp?.percent?.home || comp?.home_percent || "").replace("%", "")) / 100;
        const pDraw = Number(String(comp?.percent?.draw || comp?.draw_percent || "").replace("%", "")) / 100;
        const pAway = Number(String(comp?.percent?.away || comp?.away_percent || "").replace("%", "")) / 100;

        // početna raspodela
        let model = {
          "1": Number.isFinite(pHome) ? pHome : impliedN["1"],
          "X": Number.isFinite(pDraw) ? pDraw : impliedN["X"],
          "2": Number.isFinite(pAway) ? pAway : impliedN["2"]
        };

        // renormalizuj ako treba
        {
          const s = (model["1"] || 0) + (model["X"] || 0) + (model["2"] || 0);
          if (s > 0) { model = { "1": model["1"] / s, "X": model["X"] / s, "2": model["2"] / s }; }
        }

        // BLEND: model = α*pred + (1-α)*implied
        const alpha = MODEL_ALPHA;
        if (Number.isFinite(pHome)) model["1"] = alpha * pHome + (1 - alpha) * impliedN["1"];
        if (Number.isFinite(pDraw)) model["X"] = alpha * pDraw + (1 - alpha) * impliedN["X"];
        if (Number.isFinite(pAway)) model["2"] = alpha * pAway + (1 - alpha) * impliedN["2"];

        // guardrail: per-outcome uplift cap
        for (const k of ["1", "X", "2"]) {
          const cap = UPLIFT_CAP;
          if (!Number.isFinite(cap) || cap <= 0) continue;
          const diff = model[k] - impliedN[k];
          if (diff > cap) model[k] = impliedN[k] + cap;
          if (diff < -cap) model[k] = Math.max(0.0001, impliedN[k] - cap);
        }
        // renormalizuj posle cap-a
        {
          const s = (model["1"] || 0) + (model["X"] || 0) + (model["2"] || 0);
          if (s > 0) { model = { "1": model["1"] / s, "X": model["X"] / s, "2": model["2"] / s }; }
        }

        // EV po ishodu
        const evBy = {
          "1": Number.isFinite(med["1"]) && Number.isFinite(model["1"]) ? (med["1"] * model["1"] - 1) : -Infinity,
          "X": Number.isFinite(med["X"]) && Number.isFinite(model["X"]) ? (med["X"] * model["X"] - 1) : -Infinity,
          "2": Number.isFinite(med["2"]) && Number.isFinite(model["2"]) ? (med["2"] * model["2"] - 1) : -Infinity
        };

        // najbolji ishod
        let best = "1";
        if (evBy["X"] > evBy[best]) best = "X";
        if (evBy["2"] > evBy[best]) best = "2";

        const bestPrice = med[best];
        if (!Number.isFinite(bestPrice) || bestPrice < MIN_ODDS) { dropReasons.minOdds++; continue; }

        // kad je samo jedan trusted book za izabrani ishod, traži mali uplift vs implied
        if (TRUSTED_ONLY && Number.isFinite(ONE_TRUSTED_TOL) && ONE_TRUSTED_TOL > 0) {
          const trustedCount = counts[best] || 0;
          if (trustedCount === 1) {
            const uplift = (model[best] || 0) - (impliedN[best] || 0);
            if (!(uplift >= ONE_TRUSTED_TOL)) { dropReasons.noModel++; continue; }
          }
        }

        const mp = model[best];
        if (!Number.isFinite(mp)) { dropReasons.noModel++; continue; }

        const confidence_pct = Math.round(Math.max(0, Math.min(100, mp <= 1 ? mp * 100 : mp)));
        const leagueName = fx.league?.name || "";
        const leagueCountry = fx.league?.country || "";

        const rec = {
          fixture_id: fx.fixture_id,
          market: "1X2",
          pick: best === "1" ? "Home" : best === "2" ? "Away" : "Draw",
          pick_code: best,
          selection_label: best === "1" ? "Home" : best === "2" ? "Away" : "Draw",
          model_prob: Number(mp.toFixed(4)),
          confidence_pct,
          odds: { price: Number(bestPrice), books_count: counts[best] || 0 },
          league: { id: fx.league?.id, name: leagueName, country: leagueCountry },
          league_name: leagueName,
          league_country: leagueCountry,
          teams: { home: fx.teams.home, away: fx.teams.away },
          home: fx.teams.home,
          away: fx.teams.away,
          kickoff: fx.local_str,
          kickoff_utc: fx.date_utc,
          _implied: Number((1 / Number(bestPrice)).toFixed(4)),
          _ev: Number((bestPrice * mp - 1).toFixed(12)),
          source_meta: { books_counts_raw: { "1": counts["1"] || 0, "X": counts["X"] || 0, "2": counts["2"] || 0 } }
        };

        recs.push(rec);
        dropReasons.ok++;
      } catch {
        // skip fixture na grešku jednog poziva
      }
    }

    debug.recs = recs.length;
    debug.dropped = dropReasons;

    // 3) Rangiranje i preseci
    const byEV = [...recs].sort((a, b) => (b._ev - a._ev) || (b.confidence_pct - a.confidence_pct));

    const fullCount = Math.max(slotLimit, Math.min(byEV.length, 100));
    const slimCount = Math.min(slotLimit, byEV.length);

    const fullList = byEV.slice(0, fullCount);
    const slimList = byEV.slice(0, slimCount);

    // 4) Upis u KV – samo ako imamo nešto (ne prazni postojeće)
    let wrote = false;
    if (slimList.length > 0 || fullList.length > 0) {
      const keySlim = `vbl:${ymd}:${qSlot}`;
      const keyFull = `vbl_full:${ymd}:${qSlot}`;

      const payloadSlim = { items: slimList, football: slimList, value_bets: slimList };
      const payloadFull = { items: fullList, football: fullList, value_bets: fullList };

      await kvSetJSON_safe(keySlim, payloadSlim);
      await kvSetJSON_safe(keyFull, payloadFull);

      // alias ključevi koje čitaju druge rute/watcheri
      const keyLockedDash = `vb-locked:${ymd}:${qSlot}`;
      const keyLockedColon = `vb:locked:${ymd}:${qSlot}`;
      const keyLockedUnder = `vb_locked:${ymd}:${qSlot}`;
      const keyLockedVbl = `locked:vbl:${ymd}:${qSlot}`;

      await kvSetJSON_safe(keyLockedDash, payloadSlim);
      await kvSetJSON_safe(keyLockedColon, payloadSlim);
      await kvSetJSON_safe(keyLockedUnder, payloadSlim);
      await kvSetJSON_safe(keyLockedVbl, payloadSlim);

      // pointer
      await kvSetJSON_safe(`vb:day:${ymd}:last`, {
        key: keyLockedDash,
        alt: [keySlim, keyFull, keyLockedColon, keyLockedUnder, keyLockedVbl]
      });

      wrote = true;
    }

    return res.status(200).json({
      ok: true,
      slot: qSlot,
      ymd,
      count: slimList.length,
      count_full: fullList.length,
      wrote,
      football: slimList,
      ...(wantDebug ? { debug } : {})
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
