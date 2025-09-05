// pages/api/cron/rebuild.js
// Robusno popunjavanje dnevnih ključeva za UI:
// 1) vbl:<YMD>:{am,pm,late} → union
// 2) ako prazno: /api/score-sync?ymd=<YMD> → probaj opet
// 3) ako prazno: /api/score-sync?days=3 → probaj opet
// 4) ako prazno: fallback iz vb:day:<YMD>:last (lista ili pointer)
// 5) ako prazno: pogledaj vbl:<YMD+1>:* i zadrži samo one čiji kickoff_utc po Europe/Belgrade upada u <YMD>
// Na kraju UVEK upisuje:
//   vb:day:<YMD>:union    (LISTA)
//   vb:day:<YMD>:last     (ISTO KAO union, LISTA – radi UI kompatibilnosti)
//   vb:day:<YMD>:combined (Top 3)

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
function shiftYmd(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0,10);
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

async function readArrayMaybeJSON(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim().startsWith("[")) {
    try { return JSON.parse(val); } catch {}
  }
  return [];
}
async function readArrayKey(key) { return readArrayMaybeJSON(await kvGetJSON(key)); }

async function buildUnionFromSlots(ymd) {
  const slots = ["am", "pm", "late"];
  const cmds = slots.map(s => ["GET", `vbl:${ymd}:${s}`]);
  const out = await kvPipeline(cmds);
  const chunks = [];
  for (let i = 0; i < slots.length; i++) {
    const raw = out?.[i]?.result ?? null;
    if (!raw) continue;
    const arr = await readArrayMaybeJSON(raw);
    if (arr.length) chunks.push(...arr); // mora spread; nikakav ".arr"
  }
  return dedupeBySignature(chunks);
}

function localYmdFromUTC(iso, tz = "Europe/Belgrade") {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const y = parts.find(p => p.type === "year")?.value;
    const m = parts.find(p => p.type === "month")?.value;
    const dd = parts.find(p => p.type === "day")?.value;
    return `${y}-${m}-${dd}`;
  } catch { return null; }
}
function inLocalDay(it, ymd, tz = "Europe/Belgrade") {
  const utc = it?.kickoff_utc || it?.kickoffUTC || it?.kickoffUtc || null;
  if (utc) {
    const ly = localYmdFromUTC(utc, tz);
    return ly === ymd;
  }
  const k = (it?.kickoff || "").toString();
  if (k.length >= 10) return k.slice(0,10) === ymd;
  return false;
}

async function tryHit(url) { try { await fetch(url, { cache: "no-store" }).then(r => r.text()); } catch {} }

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymd = url.searchParams.get("ymd") || ymdInTZ("Europe/Belgrade");
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const base = `${proto}://${req.headers.host}`;

    // 1) probaj slotove za YMD
    let union = await buildUnionFromSlots(ymd);

    // 2) ako prazno → prvo score-sync za taj YMD
    if (!union.length) {
      await tryHit(`${base}/api/score-sync?ymd=${encodeURIComponent(ymd)}`);
      union = await buildUnionFromSlots(ymd);
    }

    // 3) ako prazno → probaj i varijantu koja puni po days (neki tokovi ignorišu ymd)
    if (!union.length) {
      await tryHit(`${base}/api/score-sync?days=3`);
      union = await buildUnionFromSlots(ymd);
    }

    // 4) ako prazno → fallback na vb:day:<YMD>:last (lista ili pointer)
    if (!union.length) {
      const lastVal = await kvGetJSON(`vb:day:${ymd}:last`);
      if (Array.isArray(lastVal) && lastVal.length) {
        union = dedupeBySignature(lastVal);
      } else if (typeof lastVal === "string") {
        const arr = await readArrayKey(String(lastVal));
        if (arr.length) union = dedupeBySignature(arr);
      }
    }

    // 5) ako prazno → pogledaj sutrašnje slotove i zadrži mečeve koji po lokalnom datumu spadaju u današnji YMD
    if (!union.length) {
      const ymdPlus = shiftYmd(ymd, +1);
      const fromTomorrow = await buildUnionFromSlots(ymdPlus);
      const filtered = fromTomorrow.filter(it => inLocalDay(it, ymd, "Europe/Belgrade"));
      if (filtered.length) union = dedupeBySignature(filtered);
    }

    // 6) upiši ključeve za UI
    await kvSetJSON(`vb:day:${ymd}:union`, union);
    await kvSetJSON(`vb:day:${ymd}:last`, union);            // LISTA (UI očekuje listu)
    const combined = top3Combined(union);
    await kvSetJSON(`vb:day:${ymd}:combined`, combined);

    res.status(200).json({
      ok: true,
      ymd,
      counts: { union: union.length, last: union.length, combined: combined.length },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
