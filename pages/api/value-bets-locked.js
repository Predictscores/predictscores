// FILE: pages/api/value-bets-locked.js
// Vraća zaključani (KV) dnevni feed sa filtrima i “auto-rebuild on first visit”.
// DODATO: čita vb:insight:<fixture_id> i ubacuje 2 human linije u explain.*
// Fallback: ako postoji staro polje `line`, koristi se makar to.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const VB_LIMIT = parseInt(process.env.VB_LIMIT || "25", 10);
const LEAGUE_CAP = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// pragovi (bez ENV-a; možeš kasnije da ih prebaciš u ENV po želji)
const TIER3_MIN_BOOKIES = parseInt(process.env.TIER3_MIN_BOOKIES || "3", 10); // ranije 4
const MIN_BOOKIES_1X2_HTFT = 2;
const MIN_BOOKIES_OU_BTTS = 3;

// SAFE badge (za prikaz)
const SAFE_MIN_PROB = 0.65;
const SAFE_MIN_ODDS = 1.5;
const SAFE_MIN_EV   = -0.005;
const SAFE_MIN_BOOKIES_T12 = 4;
const SAFE_MIN_BOOKIES_T3  = 5;

// auto-rebuild prozor i cooldown
const ACTIVE_HOURS = { from: 10, to: 22 }; // CET
const REBUILD_COOLDOWN_MIN = parseInt(process.env.LOCKED_REBUILD_CD || "20", 10);

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

function ymdTZ(d = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    });
    return fmt.format(d);
  } catch {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2,"0"), dd = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function hmTZ(d = new Date()) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(d).reduce((a,x)=>((a[x.type]=x.value),a),{});
    return { h: parseInt(p.hour,10), m: parseInt(p.minute,10) };
  } catch { return { h:d.getHours(), m:d.getMinutes() }; }
}

function unwrapKV(raw) {
  let v = raw;
  try {
    if (typeof v === "string") {
      const p = JSON.parse(v);
      v = (p && typeof p === "object" && "value" in p) ? p.value : p;
    }
    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) v = JSON.parse(v);
  } catch {}
  return v;
}
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return unwrapKV(j && typeof j.result !== "undefined" ? j.result : null);
  } catch { return null; }
}
async function kvSet(key, value, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const body = { value: typeof value === "string" ? value : JSON.stringify(value) };
    if (opts.ex) body.ex = opts.ex;
    if (opts.nx) body.nx = true;
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

// heuristika: da li je liga "nisko" (Tier3)? koristi nazive; po želji proširi
function isTier3(leagueName = "", country = "") {
  const s = `${country} ${leagueName}`.toLowerCase();
  // youth/women/reserve su ionako isključeni niže; ovde gledamo amaterske/niske stepene
  return (
    s.includes("3.") || s.includes("third") || s.includes("liga 3") ||
    s.includes("division 2") || s.includes("second division") ||
    s.includes("regional") || s.includes("amateur") || s.includes("cup - ")
  );
}
function isExcludedLeagueOrTeam(pick) {
  const ln = String(pick?.league?.name || "").toLowerCase();
  const hn = String(pick?.teams?.home?.name || "").toLowerCase();
  const an = String(pick?.teams?.away?.name || "").toLowerCase();
  // diskvalifikuj: women, youth, reserve
  const bad = /(women|femenin|femmin|ladies|u19|u21|u23|youth|reserve|res\.?)/i;
  if (bad.test(ln) || bad.test(hn) || bad.test(an)) return true;
  return false;
}
function isUEFA(leagueName="") {
  return /uefa|champions league|europa|conference/i.test(String(leagueName));
}
function categoryOf(p) {
  const m = String(p.market_label || p.market || "");
  if (/btts/i.test(m)) return "BTTS";
  if (/over|under|ou/i.test(m)) return "OU";
  if (/ht-?ft|ht\/ft/i.test(m)) return "HT-FT";
  if (/1x2|match winner/i.test(m)) return "1X2";
  return "OTHER";
}
function meetsBookiesFilter(p) {
  const cat = categoryOf(p);
  const n = Number(p?.bookmakers_count || 0);
  if (cat === "BTTS" || cat === "OU") return n >= MIN_BOOKIES_OU_BTTS;
  if (cat === "1X2" || cat === "HT-FT") return n >= MIN_BOOKIES_1X2_HTFT;
  return false;
}
function computeSafe(p, tier3) {
  const prob = Number(p?.model_prob || 0);
  const odds = Number(p?.market_odds || 0);
  const ev   = Number(p?.ev);
  const bks  = Number(p?.bookmakers_count || 0);
  const need = tier3 ? SAFE_MIN_BOOKIES_T3 : SAFE_MIN_BOOKIES_T12;
  return (
    prob >= SAFE_MIN_PROB &&
    odds >= SAFE_MIN_ODDS &&
    Number.isFinite(ev) && ev >= SAFE_MIN_EV &&
    bks >= need
  );
}

export default async function handler(req, res) {
  setNoStore(res);

  const day = ymdTZ();
  const { h } = hmTZ();
  const lastKey = `vb:day:${day}:last`;
  const revKey  = `vb:day:${day}:rev`;
  const cdKey   = `vb:auto:rebuild:cd:${day}`;

  // 1) pokušaj da pročitaš snapshot
  let arr = unwrapKV(await kvGet(lastKey));
  if (!Array.isArray(arr)) arr = [];

  // 2) ako prazno i u aktivnim smo satima → pokušaj auto-rebuild (cooldown)
  if (arr.length === 0 && h >= ACTIVE_HOURS.from && h <= ACTIVE_HOURS.to) {
    const cd = await kvGet(cdKey);
    const now = Date.now();
    const okToRebuild = !cd || (Number(cd?.ts || cd) + REBUILD_COOLDOWN_MIN * 60 * 1000 < now);
    if (okToRebuild) {
      // zabeleži cooldown
      await kvSet(cdKey, { ts: now }, { ex: 6 * 3600 });
      // pogodi rebuild interno
      try {
        const proto = req.headers["x-forwarded-proto"] || "https";
        const host  = req.headers["x-forwarded-host"] || req.headers.host;
        const base  = `${proto}://${host}`;
        await fetch(`${base}/api/cron/rebuild`, { cache: "no-store" });
      } catch {}
      // posle rebuild-a probaj opet
      const retry = unwrapKV(await kvGet(lastKey));
      if (Array.isArray(retry) && retry.length) arr = retry;
    }

    if (!arr.length) {
      return res.status(200).json({
        value_bets: [],
        built_at: new Date().toISOString(),
        day,
        source: "ensure-wait",
        meta: {
          limit_applied: VB_LIMIT,
          league_cap: LEAGUE_CAP,
          tier3_min_bookies: TIER3_MIN_BOOKIES,
          floats_enabled: !!process.env.SMART45_FLOAT_ENABLED,
          safe_enabled: true,
          auto_rebuild: { active_hours: "10-22", stale_min: 60, rebuild_cooldown_min: REBUILD_COOLDOWN_MIN },
        },
      });
    }
  }

  // 3) filtriranje i cap-ovi
  const byLeagueCount = new Map();
  const out = [];

  for (const p of arr) {
    if (out.length >= VB_LIMIT) break;

    if (isExcludedLeagueOrTeam(p)) continue;

    const leagueName = p?.league?.name || "";
    const leagueKey = `${p?.league?.country || ""}::${leagueName}`;
    const isUefa = isUEFA(leagueName);
    const cap = isUefa ? Math.max(LEAGUE_CAP, 4) : LEAGUE_CAP;

    const cur = byLeagueCount.get(leagueKey) || 0;
    if (cur >= cap) continue;

    // min bookies (globalno) + za tier3 strože
    const tier3 = isTier3(leagueName, p?.league?.country || "");
    const nBooks = Number(p?.bookmakers_count || 0);
    if (!meetsBookiesFilter(p)) continue;
    if (tier3 && nBooks < TIER3_MIN_BOOKIES) continue;

    // --- UBACI 2 HUMAN LINIJE IZ KV (i fallback na staro `line`) ---
    const fid = Number(p?.fixture_id);
    if (Number.isFinite(fid)) {
      const ins = unwrapKV(await kvGet(`vb:insight:${fid}`));
      const headline = ins?.headline && String(ins.headline).trim();
      const formLine = ins?.form_line && String(ins.form_line).trim();
      const oldLine  = (!headline && !formLine && ins?.line) ? String(ins.line).trim() : null;

      let human = [];
      if (headline) human.push(headline);
      if (formLine) human.push(formLine);
      if (!human.length && oldLine) human = [oldLine];

      if (human.length) {
        p.explain = p.explain || {};
        p.explain.summary = human[0];     // prva linija ide u "Zašto"
        p.explain.human   = human;        // UI može da prikaže obe
        if (human[1]) p._insight_line = human[1]; // ako UI već koristi dodatnu liniju
      }
    }
    // ---------------------------------------------------------------

    // safe badge
    const safe = computeSafe(p, tier3);

    out.push({ ...p, safe });
    byLeagueCount.set(leagueKey, cur + 1);
  }

  // sort: SAFE prvo, pa veći conf, pa EV, pa skoriji kickoff
  out.sort((a, b) => {
    if ((b.safe ? 1 : 0) !== (a.safe ? 1 : 0)) return (b.safe ? 1 : 0) - (a.safe ? 1 : 0);
    const ca = Number(a.confidence_pct || Math.round((a.model_prob || 0) * 100));
    const cb = Number(b.confidence_pct || Math.round((b.model_prob || 0) * 100));
    if (cb !== ca) return cb - ca;
    const eva = Number.isFinite(a.ev) ? a.ev : -Infinity;
    const evb = Number.isFinite(b.ev) ? b.ev : -Infinity;
    if (evb !== eva) return evb - eva;
    const ta = Number(new Date(String(a?.datetime_local?.starting_at?.date_time || "").replace(" ", "T")).getTime());
    const tb = Number(new Date(String(b?.datetime_local?.starting_at?.date_time || "").replace(" ", "T")).getTime());
    return ta - tb;
  });

  // rev info (ako postoji)
  const revRaw = unwrapKV(await kvGet(revKey));
  let rev = 0;
  try { rev = parseInt(String(revRaw?.value ?? revRaw ?? "0"), 10) || 0; } catch {}

  return res.status(200).json({
    value_bets: out,
    built_at: new Date().toISOString(),
    day,
    source: "locked-cache",
    meta: {
      limit_applied: VB_LIMIT,
      league_cap: LEAGUE_CAP,
      tier3_min_bookies: TIER3_MIN_BOOKIES,
      tier3_min_bookies_note: "aplikira se samo na niske lige (heuristika)",
      floats_enabled: !!process.env.SMART45_FLOAT_ENABLED,
      safe_enabled: true,
      safe_min_prob: SAFE_MIN_PROB,
      safe_min_odds: SAFE_MIN_ODDS,
      safe_min_ev: SAFE_MIN_EV,
      safe_min_bookies_t12: SAFE_MIN_BOOKIES_T12,
      safe_min_bookies_t3: SAFE_MIN_BOOKIES_T3,
      auto_rebuild: { active_hours: "10-22", rebuild_cooldown_min: REBUILD_COOLDOWN_MIN },
      rev
    },
  });
}
