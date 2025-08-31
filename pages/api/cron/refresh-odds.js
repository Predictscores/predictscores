// pages/api/cron/refresh-odds.js
// Per-fixture watcher — SLOT-BOUND + ROUND-ROBIN
// - Čita value-bets iz KV (robustno: vbl/vbl_full + svi aliasi + pointer)
// - Umesto rolling prozora, cilja CEO slot (late/am/pm) po lokalnom kickoff-u
// - U svakom run-u osveži najviše ODDS_PER_FIXTURE_CAP mečeva, round-robin kroz ceo slot
// - Ne menja pick; ažurira samo odds / books_count / _implied / _ev / source_meta
// - UI i druge rute ostaju KV-only

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ----------------------- utils -----------------------
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function envBool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}
function slotOfHour(h) { return h < 10 ? "late" : (h < 15 ? "am" : "pm"); }
function windowForSlot(slot) {
  if (slot === "late") return { hmin: 0,  hmax: 9,  label: "late" };
  if (slot === "am")   return { hmin: 10, hmax: 14, label: "am"   };
  return                  { hmin: 15, hmax: 23, label: "pm"   };
}
function localHour(tz = TZ) {
  try { return Number(new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())); }
  catch { return new Date().getUTCHours(); }
}
function parseISO(x) {
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : NaN;
}
function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function localPartsFromISO(dateIso, tz = TZ) {
  try {
    const d = new Date(dateIso);
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), hm: `${p.hour}:${p.minute}` };
  } catch {
    return { ymd: ymdInTZ(new Date(), tz), hour: 0, hm: "00:00" };
  }
}

// ----------------------- config consts (pre KV/AF) -----------------------
const MIN_ODDS = envNum("MIN_ODDS", 1.01);
const CAP = envNum("ODDS_PER_FIXTURE_CAP", 10);         // koliko mečeva osvežavaš po run-u
const DRY_RUN = envBool("WATCHER_DRY_RUN", false);      // ako 1/true, ne piše nazad u KV

// ----------------------- KV (Upstash) -----------------------
async function kvGetRaw(key) {
  const base = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return null;
  const r = await fetch(`${base.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json().catch(() => null) : await r.text().catch(() => null);
  return (body && typeof body === "object" && "result" in body) ? body.result : body;
}
async function kvSetJSON(key, value) {
  if (DRY_RUN) return true; // suvi hod
  const base = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return false;

  // 1) set POST body
  let r = await fetch(`${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(value)
  }).catch(() => null);
  if (r && r.ok) return true;

  // 2) fallback set sa vrednošću u path-u
  r = await fetch(`${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null);
  return !!(r && r.ok);
}

// ----------------------- API-Football -----------------------
const API_BASE = process.env.API_FOOTBALL_BASE_URL || process.env.API_FOOTBALL || "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "";
function afHeaders() {
  const h = {};
  if (API_KEY) {
    h["x-apisports-key"] = API_KEY;   // api-sports v3
    h["x-rapidapi-key"] = API_KEY;    // rapidapi fallback
  }
  return h;
}
async function afGet(url) {
  const r = await fetch(url, { headers: afHeaders() }).catch(() => null);
  if (!r || !r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? await r.json().catch(() => null) : null;
}
async function fetchOddsForFixture(fixtureId) {
  if (!API_KEY) return [];
  const j = await afGet(`${API_BASE.replace(/\/+$/, "")}/odds?fixture=${encodeURIComponent(fixtureId)}`);
  const arr = Array.isArray(j?.response) ? j.response : [];
  return arr;
}

// 1X2 extraction (radi i sa oblikom gde postoji "bookmakers[]")
function extract1X2FromOdds(oddsPayload) {
  const priceBy = { "1": [], "X": [], "2": [] };
  const seen = { "1": new Set(), "X": new Set(), "2": new Set() };
  const roots = Array.isArray(oddsPayload) ? oddsPayload : [];
  const rows = [];

  for (const root of roots) {
    if (!root) continue;
    if (Array.isArray(root.bookmakers)) { for (const bk of root.bookmakers) rows.push(bk); continue; }
    if (Array.isArray(root.bets)) { rows.push(root); continue; }
    if (root.bookmaker && Array.isArray(root.bookmaker.bets)) { rows.push(root.bookmaker); continue; }
  }

  for (const row of rows) {
    const bkmName = String(row?.name ?? row?.bookmaker?.name ?? row?.id ?? "");
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
        if (!Number.isFinite(price)) continue;
        if (price < MIN_ODDS) continue;
        priceBy[code].push(price);
        if (bkmName) seen[code].add(bkmName);
      }
    }
  }

  const med = { "1": median(priceBy["1"]), "X": median(priceBy["X"]), "2": median(priceBy["2"]) };
  const booksCount = { "1": seen["1"].size, "X": seen["X"].size, "2": seen["2"].size };
  return { med, booksCount };
}

// ----------------------- main -----------------------
export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const slot = (req.query.slot && String(req.query.slot)) || slotOfHour(localHour(TZ));
    const win = windowForSlot(slot);

    const debug = { tried: [], pickedKey: null, listLen: 0, filteredBySlot: 0, rrOffset: 0, targetedIds: [], mode: "slot-bound" };

    // 1) Učitaj payload iz KV (robustno)
    const keyCandidates = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb-locked:${ymd}:${slot}`,
      `vb:locked:${ymd}:${slot}`,
      `vb_locked:${ymd}:${slot}`,
      `locked:vbl:${ymd}:${slot}`
    ];

    let payload = null;
    let pickedKey = null;

    for (const k of keyCandidates) {
      debug.tried.push(k);
      const raw = await kvGetRaw(k);
      if (!raw) continue;
      let v = raw;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* ignore */ } }
      if (v && typeof v === "object") {
        const arr = (Array.isArray(v.items) ? v.items :
          Array.isArray(v.value_bets) ? v.value_bets :
          Array.isArray(v.football) ? v.football :
          Array.isArray(v.arr) ? v.arr :
          Array.isArray(v.data) ? v.data : []);
        if (Array.isArray(arr) && arr.length > 0) {
          payload = { obj: v, arr, key: k };
          pickedKey = k;
          break;
        }
      }
    }

    // fallback preko pointera
    if (!payload) {
      const ptrRaw = await kvGetRaw(`vb:day:${ymd}:last`);
      debug.tried.push(`vb:day:${ymd}:last`);
      if (ptrRaw) {
        let p = ptrRaw;
        if (typeof p === "string") { try { p = JSON.parse(p); } catch { /* ignore */ } }
        const ptrKey = p?.key || p?.target || p?.k || null;
        if (ptrKey) {
          debug.tried.push(ptrKey);
          const raw = await kvGetRaw(ptrKey);
          if (raw) {
            let v = raw; if (typeof v === "string") { try { v = JSON.parse(v); } catch { } }
            const arr = (Array.isArray(v?.items) ? v.items :
              Array.isArray(v?.value_bets) ? v.value_bets :
              Array.isArray(v?.football) ? v.football :
              Array.isArray(v?.arr) ? v.arr :
              Array.isArray(v?.data) ? v.data : []);
            if (Array.isArray(arr) && arr.length > 0) {
              payload = { obj: v, arr, key: ptrKey };
              pickedKey = ptrKey;
            }
          }
        }
      }
    }

    const inspected = Array.isArray(payload?.arr) ? payload.arr.length : 0;
    debug.listLen = inspected;
    debug.pickedKey = pickedKey;

    if (!inspected) {
      return res.status(200).json({
        ok: true, ymd, slot,
        inspected: 0, filtered: 0, targeted: 0, touched: 0,
        source: "refresh-odds:per-fixture",
        debug
      });
    }

    // 2) SLOT-BOUND filter: ceo slot dana (po lokalnom kickoff-u)
    //    Prefer "kickoff" (lokalni string koji je rebuild već izračunao u TZ), fallback na "kickoff_utc" -> pretvori u lokalni sat & ymd.
    const candidates = payload.arr
      .map(r => {
        if (r && typeof r === "object") {
          // pokušaj direktno iz "kickoff" stringa "YYYY-MM-DD HH:mm"
          const k = String(r.kickoff || "");
          if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(k)) {
            const ymdLocal = k.slice(0, 10);
            const hh = Number(k.slice(11, 13));
            return { rec: r, ymdLocal, hh };
          }
          // fallback: kickoff_utc -> lokalni delovi
          const ts = parseISO(r.kickoff_utc);
          if (Number.isFinite(ts)) {
            const parts = localPartsFromISO(r.kickoff_utc, TZ);
            return { rec: r, ymdLocal: parts.ymd, hh: parts.hour };
          }
        }
        return null;
      })
      .filter(Boolean)
      .filter(x => x.ymdLocal === ymd && x.hh >= win.hmin && x.hh <= win.hmax)
      .sort((a, b) => {
        // očuvaj hronologiju u slotu (po utc datetime)
        const ta = parseISO(a.rec.kickoff_utc) || parseISO(`${a.ymdLocal} ${String(a.hh).padStart(2, "0")}:00:00Z`);
        const tb = parseISO(b.rec.kickoff_utc) || parseISO(`${b.ymdLocal} ${String(b.hh).padStart(2, "0")}:00:00Z`);
        return ta - tb;
      })
      .map(x => x.rec);

    debug.filteredBySlot = candidates.length;

    if (!candidates.length) {
      return res.status(200).json({
        ok: true, ymd, slot,
        inspected, filtered: 0, targeted: 0, touched: 0,
        source: "refresh-odds:per-fixture",
        debug
      });
    }

    // 3) ROUND-ROBIN odabir u okviru slot liste (persistira offset u KV)
    const rrKey = `vb:rr:${ymd}:${slot}`;
    let rr = 0;
    const rrRaw = await kvGetRaw(rrKey);
    if (rrRaw != null) {
      try {
        if (typeof rrRaw === "string") {
          const jj = JSON.parse(rrRaw);
          rr = Number.isFinite(Number(jj?.offset)) ? Number(jj.offset) : (Number.isFinite(Number(rrRaw)) ? Number(rrRaw) : 0);
        } else if (typeof rrRaw === "object" && rrRaw) {
          rr = Number.isFinite(Number(rrRaw.offset)) ? Number(rrRaw.offset) : 0;
        } else {
          rr = Number.isFinite(Number(rrRaw)) ? Number(rrRaw) : 0;
        }
      } catch {
        rr = Number.isFinite(Number(rrRaw)) ? Number(rrRaw) : 0;
      }
    }
    rr = Math.max(0, Math.min(rr, Math.max(0, candidates.length - 1)));
    debug.rrOffset = rr;

    // uzmi CAP komada počev od rr; wrap-around po listi
    const tgt = [];
    for (let i = 0; i < Math.min(CAP, candidates.length); i++) {
      tgt.push(candidates[(rr + i) % candidates.length]);
    }
    const targets = tgt;
    const targeted = targets.length;
    const targetedIds = targets.map(t => t?.fixture_id).filter(Boolean);
    debug.targetedIds = targetedIds;

    if (!targeted) {
      return res.status(200).json({
        ok: true, ymd, slot,
        inspected, filtered: candidates.length, targeted: 0, touched: 0,
        source: "refresh-odds:per-fixture",
        debug
      });
    }

    // 4) Osveži kvote za targete
    const updatesById = new Map(); // fixture_id -> { price, books_count, raw_counts, implied, ev }
    for (const rec of targets) {
      const fid = rec?.fixture_id;
      if (!fid) continue;

      const oddsPayload = await fetchOddsForFixture(fid).catch(() => []);
      const { med, booksCount } = extract1X2FromOdds(oddsPayload);

      const pickCode = String(rec?.pick_code || "").toUpperCase();
      const modelProb = Number(rec?.model_prob);
      if (!pickCode || !Number.isFinite(modelProb)) continue;

      const bestPrice = med[pickCode];
      if (!Number.isFinite(bestPrice)) continue;

      const implied = 1 / bestPrice;
      const ev = bestPrice * modelProb - 1;

      updatesById.set(fid, {
        price: Number(bestPrice),
        books_count: Number(booksCount[pickCode] || 0),
        raw_counts: { "1": booksCount["1"] || 0, "X": booksCount["X"] || 0, "2": booksCount["2"] || 0 },
        implied: Number(implied.toFixed(4)),
        ev: Number(ev.toFixed(12))
      });
    }

    const touched = updatesById.size;

    // 5) Upis nazad u KV – patch u vbl & vbl_full + aliasi (ako postoje)
    if (touched > 0 && !DRY_RUN) {
      const keysToPatch = [
        `vbl:${ymd}:${slot}`,
        `vbl_full:${ymd}:${slot}`,
        `vb-locked:${ymd}:${slot}`,
        `vb:locked:${ymd}:${slot}`,
        `vb_locked:${ymd}:${slot}`,
        `locked:vbl:${ymd}:${slot}`
      ];

      for (const k of keysToPatch) {
        const raw = await kvGetRaw(k);
        if (!raw) continue;

        let obj = raw;
        if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch { continue; } }
        const fields = ["items", "value_bets", "football", "arr", "data"];
        let changed = false;

        for (const f of fields) {
          if (!Array.isArray(obj?.[f])) continue;
          for (const it of obj[f]) {
            const u = updatesById.get(it?.fixture_id);
            if (!u) continue;

            it.odds = Object.assign({}, it.odds, { price: u.price, books_count: u.books_count });
            it._implied = u.implied;
            it._ev = u.ev;
            it.source_meta = Object.assign({}, it.source_meta, { books_counts_raw: u.raw_counts });
            changed = true;
          }
        }

        if (changed) await kvSetJSON(k, obj);
      }
    }

    // 6) Sačuvaj round-robin offset (i kad nema touched, da ne zaglavimo na istim)
    const nextRR = (rr + targeted) % candidates.length;
    await kvSetJSON(rrKey, { offset: nextRR });

    return res.status(200).json({
      ok: true, ymd, slot,
      inspected, filtered: candidates.length, targeted, touched,
      source: "refresh-odds:per-fixture",
      debug
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
