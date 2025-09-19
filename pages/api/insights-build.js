// pages/api/insights-build.js
import { arrFromAny, toJson } from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

/* ---------- TZ (samo TZ_DISPLAY) ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: raw });
    return raw;
  } catch {
    return "Europe/Belgrade";
  }
}
const TZ = pickTZ();

/* ---------- KV (Vercel KV / Upstash) ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}
async function kvGETitems(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      const res = j && ("result" in j ? j.result : j);
      const obj = toJson(res);
      const items = arrFromAny(obj);
      trace && trace.push({ get: key, ok: r.ok, flavor: b.flavor, count: items.length });
      if (!r.ok) continue;
      return { items, obj, flavor: b.flavor, kvResult: res };
    } catch (e) {
      trace && trace.push({ get: key, ok: false, err: String(e?.message || e) });
    }
  }
  return { items: [], obj: null, flavor: null, kvResult: null };
}
async function kvSET(key, value, trace) {
  const saved = [];
  const body = typeof value === "string" ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.tok}`, "Content-Type": "application/json" },
        cache: "no-store",
        body,
      });
      saved.push({ flavor: b.flavor, ok: r.ok });
    } catch (e) {
      saved.push({ flavor: b.flavor, ok: false, err: String(e?.message || e) });
    }
  }
  trace && trace.push({ set: key, saved });
  return saved;
}

/* ---------- utils ---------- */
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour: "2-digit" }).format(d));
function canonicalSlot(x) {
  x = String(x || "auto").toLowerCase();
  return x === "late" || x === "am" || x === "pm" ? x : "auto";
}
function autoSlot(d, tz) {
  const h = hourInTZ(d, tz);
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}
// Uvek "danas" (workflow prosleđuje ymd kad je drugi dan potreban)
function targetYmdForSlot(now, slot, tz) {
  return ymdInTZ(now, tz);
}
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/* ---------- selection helpers ---------- */
const num = (v) => (Number.isFinite(v) ? v : Number(v));
const MIN_ODDS = (() => {
  const v = Number(process.env.MIN_ODDS);
  return Number.isFinite(v) && v > 1 ? v : 1.5;
})();
const pickPrice = (v) => {
  const n = num(v);
  return Number.isFinite(n) ? n : null;
};
const kickoffISO = (it) => it?.fixture?.date || it?.fixture_date || it?.kickoff || it?.kickoff_utc || it?.ts || null;
const confPct = (it) => (Number.isFinite(it?.confidence_pct) ? it.confidence_pct : Number(it?.confidence) || 0);
const byStrength = (a, b) => confPct(b) - confPct(a) || new Date(kickoffISO(a)).getTime() - new Date(kickoffISO(b)).getTime();

/* ---------- tickets snapshot record ---------- */
function snapshotItem(it, market_key, price, books_count, pick, extra = {}) {
  const fx = it?.fixture?.id || it?.fixture_id || it?.id || null;
  return {
    fixture_id: fx,
    league: it?.league || it?.fixture?.league || null,
    teams: it?.teams || it?.fixture?.teams || null,
    kickoff: kickoffISO(it),
    market_key,
    pick,
    price_snapshot: price ?? null,
    books_count_snapshot: Number(books_count) || 0,
    frozen: true,
    snapshot_at: new Date().toISOString(),
    ...extra,
  };
}

/* ---------- derive helpers for Top-3 ---------- */
function marketPickFromItem(it) {
  const mk = (it?.market_key || it?.market || "").toString().toLowerCase();
  const pickTxt = (it?.pick || it?.selection_label || "").toString().toLowerCase();
  const m = it?.markets || {};
  if (/^h2h|1x2|match\s*winn?er/.test(mk)) {
    let side = null;
    if (/home|1\b/.test(pickTxt)) side = "home";
    else if (/draw|x\b|tie/.test(pickTxt)) side = "draw";
    else if (/away|2\b/.test(pickTxt)) side = "away";
    const price = side ? m?.h2h?.[side] : null;
    return { market_key: "h2h", pick: side || "home", price: price ?? null, books: m?.h2h?.books_count };
  }
  if (/btts|both\s*teams\s*to\s*score/.test(mk)) {
    const price = m?.btts?.yes ?? null;
    return { market_key: "btts", pick: "yes", price, books: m?.btts?.books_count };
  }
  if (/ou|over\/under|goals/.test(mk) || /2\.5/.test(pickTxt)) {
    const price = m?.ou25?.over ?? null;
    return { market_key: "ou25", pick: "over", price, books: m?.ou25?.books_count };
  }
  if (/ht\s*\/\s*ft|htft|half\s*time.*full\s*time/.test(mk)) {
    const hh = m?.htft?.hh;
    const aa = m?.htft?.aa;
    const chose = Number.isFinite(hh) && Number.isFinite(aa)
      ? (hh >= aa ? { p: hh, code: "hh" } : { p: aa, code: "aa" })
      : Number.isFinite(hh)
      ? { p: hh, code: "hh" }
      : Number.isFinite(aa)
      ? { p: aa, code: "aa" }
      : null;
    return chose ? { market_key: "htft", pick: chose.code, price: chose.p, books: m?.htft?.books_count } : null;
  }
  if (/fh|first.*half/.test(mk)) {
    const price = m?.fh_ou15?.over ?? null;
    return { market_key: "fh_ou15", pick: "over", price, books: m?.fh_ou15?.books_count };
  }
  return null;
}

/* ---------- merge Top-3 + tickets u vb:day:<ymd>:combined ---------- */
function dedupKey(e) {
  const f = e?.fixture_id || e?.fixture?.id || e?.id;
  return `${f || "?"}__${String(e?.market_key || "").toLowerCase()}__${String(e?.pick || "").toLowerCase()}`;
}
async function mergeCombined({ ymd, slot, top3Items, ticketsSnap, trace }) {
  const key = `vb:day:${ymd}:combined`;
  const prev = await kvGETitems(key, trace);
  const prevArr = prev.items || [];
  const by = new Map(prevArr.map((e) => [dedupKey(e), e]));
  let added = 0;

  for (const it of top3Items || []) {
    const mp = marketPickFromItem(it);
    if (!mp) continue;
    const entry = snapshotItem(it, mp.market_key, mp.price, mp.books, mp.pick, {
      source: "top3",
      slot,
    });
    entry.visible_for_history = entry.market_key === "h2h";
    const keyD = dedupKey(entry);
    if (!by.has(keyD)) {
      by.set(keyD, entry);
      added++;
    }
  }

  function enrichAndAdd(list, market_key) {
    for (const row of list || []) {
      const e = { ...row, source: "ticket", slot, market_key: market_key || row.market_key };
      e.visible_for_history = e.market_key === "h2h";
      const keyD = dedupKey(e);
      if (!by.has(keyD)) {
        by.set(keyD, e);
        added++;
      }
    }
  }
  enrichAndAdd(ticketsSnap?.btts, "btts");
  enrichAndAdd(ticketsSnap?.ou25, "ou25");
  enrichAndAdd(ticketsSnap?.htft, "htft");
  enrichAndAdd(ticketsSnap?.fh_ou15, "fh_ou15");

  if (added > 0) {
    const merged = Array.from(by.values());
    await kvSET(key, merged, trace);
    trace && trace.push({ combined_key: key, added, total: merged.length });
  } else {
    trace && trace.push({ combined_key: key, added: 0, note: "no-op" });
  }
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();
    const wantDebug = String(req.query?.debug || "") === "1";

    const qSlot = canonicalSlot(req.query.slot);
    const slot = qSlot === "auto" ? autoSlot(now, TZ) : qSlot;

    const qYmd = String(req.query.ymd || "").trim();
    const ymd = isValidYmd(qYmd) ? qYmd : targetYmdForSlot(now, slot, TZ);

    const tried = [`vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`, `vb:day:${ymd}:${slot}`, `vb:day:${ymd}:union`];
    let baseArr = null;
    let source = null;
    let chosenFlavor = null;
    let chosenResult;
    let debugFlavor = null;
    let debugResult;

    for (const key of tried) {
      const attempt = await kvGETitems(key, trace);
      if (!debugFlavor && attempt.flavor) debugFlavor = attempt.flavor;
      if (debugResult === undefined && attempt.kvResult !== undefined) debugResult = attempt.kvResult;
      if (attempt.items.length) {
        baseArr = attempt.items;
        source = key;
        chosenFlavor = attempt.flavor;
        chosenResult = attempt.kvResult;
        break;
      }
    }

    const resolvedFlavor = chosenFlavor || debugFlavor || "unknown";
    const resolvedResult = chosenResult !== undefined ? chosenResult : debugResult;

    if (!baseArr) {
      const payload = {
        ok: true,
        ymd,
        slot,
        source: null,
        counts: { btts: 0, ou25: 0, htft: 0, fh_ou15: 0 },
        note: "no-source-items",
      };
      if (wantDebug) {
        payload.debug = {
          sourceFlavor: resolvedFlavor,
          kvObject: typeof resolvedResult === "object",
        };
      }
      return res.status(200).json(payload);
    }

    const sorted = baseArr.slice().sort((a, b) => byStrength(a, b));

    const groups = { btts: [], ou25: [], htft: [], fh_ou15: [] };
    for (const it of baseArr) {
      const m = it?.markets || {};
      if (m?.btts) {
        const p = pickPrice(m.btts.yes);
        if (p && p >= MIN_ODDS) groups.btts.push({ it, price: p, books: m?.btts?.books_count, pick: "yes" });
      }
      if (m?.ou25) {
        const p = pickPrice(m.ou25.over);
        if (p && p >= MIN_ODDS) groups.ou25.push({ it, price: p, books: m?.ou25?.books_count, pick: "over" });
      }
      if (m?.htft) {
        const hh = pickPrice(m.htft.hh);
        const aa = pickPrice(m.htft.aa);
        const chosen = hh && aa ? (hh >= aa ? { p: hh, code: "hh" } : { p: aa, code: "aa" }) : hh ? { p: hh, code: "hh" } : aa ? { p: aa, code: "aa" } : null;
        if (chosen && chosen.p >= MIN_ODDS) groups.htft.push({ it, price: chosen.p, books: m?.htft?.books_count, pick: chosen.code });
      }
      if (m?.fh_ou15) {
        const p = pickPrice(m.fh_ou15.over);
        if (p && p >= MIN_ODDS) groups.fh_ou15.push({ it, price: p, books: m?.fh_ou15?.books_count, pick: "over" });
      }
    }
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => byStrength(a.it, b.it));

    const top = {
      btts: groups.btts.slice(0, 4),
      ou25: groups.ou25.slice(0, 4),
      htft: groups.htft.slice(0, 4),
      fh_ou15: groups.fh_ou15.slice(0, 4),
    };

    const totalNew = top.btts.length + top.ou25.length + top.htft.length + top.fh_ou15.length;
    const keySlot = `tickets:${ymd}:${slot}`;

    if (totalNew === 0) {
      const payload = {
        ok: true,
        ymd,
        slot,
        source,
        counts: { btts: 0, ou25: 0, htft: 0, fh_ou15: 0 },
        note: "no-clobber (no-valid-candidates)",
      };
      if (wantDebug) {
        payload.debug = {
          sourceFlavor: resolvedFlavor,
          kvObject: typeof resolvedResult === "object",
        };
      }
      return res.status(200).json(payload);
    }

    const snap = { btts: [], ou25: [], htft: [], fh_ou15: [] };
    for (const row of top.btts) snap.btts.push(snapshotItem(row.it, "btts", row.price, row.books, row.pick));
    for (const row of top.ou25) snap.ou25.push(snapshotItem(row.it, "ou25", row.price, row.books, row.pick));
    for (const row of top.htft) snap.htft.push(snapshotItem(row.it, "htft", row.price, row.books, row.pick));
    for (const row of top.fh_ou15) snap.fh_ou15.push(snapshotItem(row.it, "fh_ou15", row.price, row.books, row.pick));

    await kvSET(keySlot, snap, trace);
    const day = await kvGETitems(`tickets:${ymd}`, trace);
    const dayValue = day.obj;
    const hasDay = dayValue && typeof dayValue === "object" && (
      Array.isArray(dayValue.btts) ||
      Array.isArray(dayValue.ou25) ||
      Array.isArray(dayValue.htft) ||
      Array.isArray(dayValue.fh_ou15)
    );
    if (!hasDay) await kvSET(`tickets:${ymd}`, snap, trace);

    const top3 = [];
    for (const it of sorted.slice(0, 3)) {
      const mp = marketPickFromItem(it);
      if (!mp) continue;
      top3.push({ it, ...mp });
    }

    await mergeCombined({ ymd, slot, top3Items: top3.map((x) => x.it), ticketsSnap: snap, trace });

    const counts = {
      btts: snap.btts.length,
      ou25: snap.ou25.length,
      htft: snap.htft.length,
      fh_ou15: snap.fh_ou15.length,
    };

    const payload = {
      ok: true,
      ymd,
      slot,
      source,
      tickets_key: keySlot,
      counts,
      min_odds: MIN_ODDS,
    };
    if (wantDebug) {
      payload.debug = {
        sourceFlavor: resolvedFlavor,
        kvObject: typeof resolvedResult === "object",
      };
    }
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
