// FILE: pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_BASE  = "https://v3.football.api-sports.io";

const FRESH_HOURS = Number(process.env.INSIGHT_FRESH_HOURS ?? 12);
const MAX_FETCH_BLOCKS = Number(process.env.INSIGHT_MAX_FETCH ?? 6);

function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), da = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  }
}

async function kvGET(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json().catch(()=>null);
    const val = (j && typeof j==="object" && "result" in j) ? j.result : j;
    try { return typeof val==="string" ? JSON.parse(val) : val; } catch { return val; }
  }
  const t = await r.text().catch(()=>null);
  try { return JSON.parse(t); } catch { return t; }
}
async function kvSET(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
  return r.ok;
}
function toArray(raw) {
  try {
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner === "string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  } catch {}
  return [];
}
function isFresh(ts, maxHours = FRESH_HOURS) {
  if (!ts) return false;
  const ageH = (Date.now() - new Date(ts).getTime()) / 36e5;
  return ageH < maxHours;
}

// API-FOOTBALL
function afKey() { return process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || ""; }
async function afFetch(path) {
  const key = afKey(); if (!key) return null;
  const r = await fetch(`${AF_BASE}${path}`, { headers: { "x-apisports-key": key } });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return js?.response || null;
}

// Forma/H2H
function wdlForTeamInMatch(teamId, match) {
  const th = match?.teams?.home?.id, ta = match?.teams?.away?.id;
  const gh = match?.goals?.home, ga = match?.goals?.away;
  if (![th, ta].includes(teamId)) return { w: 0, d: 0, l: 0, gf: 0, ga: 0 };
  const isHome = teamId === th;
  const forG = isHome ? gh : ga;
  const agG  = isHome ? ga : gh;
  let w = 0, d = 0, l = 0;
  if (forG > agG) w = 1; else if (forG === agG) d = 1; else l = 1;
  return { w, d, l, gf: forG ?? 0, ga: agG ?? 0 };
}
function sumStats(list) {
  return list.reduce((acc, x) => ({
    w: acc.w + x.w, d: acc.d + x.d, l: acc.l + x.l,
    gf: acc.gf + x.gf, ga: acc.ga + x.ga,
  }), { w: 0, d: 0, l: 0, gf: 0, ga: 0 });
}
function fmtWDLGFGA({ w, d, l, gf, ga }) {
  return `${w}-${d}-${l} (GF:${gf}:GA:${ga})`;
}
async function getTeamFormCached(teamId) {
  const k = `vb:insight:team:${teamId}`;
  const cached = await kvGET(k).catch(()=>null);
  if (cached && isFresh(cached.at)) return cached;
  const resp = await afFetch(`/fixtures?team=${teamId}&last=5`);
  if (!Array.isArray(resp) || !resp.length) {
    const obj = { wdl: "—", at: new Date().toISOString() };
    await kvSET(k, obj); return obj;
  }
  const stats = resp.map(m => wdlForTeamInMatch(teamId, m));
  const agg   = sumStats(stats);
  const obj   = { wdl: fmtWDLGFGA(agg), at: new Date().toISOString() };
  await kvSET(k, obj);
  return obj;
}
async function getH2HCached(homeId, awayId) {
  const k = `vb:insight:h2h:${homeId}:${awayId}`;
  const cached = await kvGET(k).catch(()=>null);
  if (cached && isFresh(cached.at)) return cached;
  const resp = await afFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=5`);
  if (!Array.isArray(resp) || !resp.length) {
    const obj = { home: "—", at: new Date().toISOString() };
    await kvSET(k, obj); return obj;
  }
  const stats = resp.map(m => wdlForTeamInMatch(homeId, m));
  const agg   = sumStats(stats);
  const obj   = { home: fmtWDLGFGA(agg), at: new Date().toISOString() };
  await kvSET(k, obj);
  return obj;
}

function buildLineFrom(tHome, tAway, h2h, home, away, p) {
  const parts = [];
  if (tHome?.wdl && tAway?.wdl && tHome.wdl!=="—" && tAway.wdl!=="—") {
    parts.push(`Forma: ${home} ${tHome.wdl} · ${away} ${tAway.wdl}`);
  }
  if (h2h?.home && h2h.home !== "—") {
    parts.push(`H2H (L5): ${home} ${h2h.home}`);
  }
  if (!parts.length) {
    const mrk = `${p?.market_label || p?.market || ""}`.toUpperCase();
    const sel = `${p?.selection || ""}`;
    return `Duel: ${home} vs ${away}. Predlog: ${mrk} – ${sel}.`;
  }
  return parts.join(" · ");
}

export default async function handler(req, res) {
  try {
    const day = ymdInTZ(new Date(), TZ);
    const alt = ymdInTZ(new Date(), "UTC");

    // 1) probaj union
    let arr = toArray(await kvGET(`vb:day:${day}:last`));
    let usedKey = `vb:day:${day}:last`;

    // 2) ako nema, spoji AM/PM/LATE
    if (!arr.length) {
      const am  = toArray(await kvGET(`vb:day:${day}:am`));
      const pm  = toArray(await kvGET(`vb:day:${day}:pm`));
      const lt  = toArray(await kvGET(`vb:day:${day}:late`));
      arr = [...am, ...pm, ...lt];
      usedKey = `(am+pm+late/${day})`;
    }

    // 3) fallback na UTC dan
    if (!arr.length) {
      arr = toArray(await kvGET(`vb:day:${alt}:last`));
      usedKey = `vb:day:${alt}:last`;
      if (!arr.length) {
        const am  = toArray(await kvGET(`vb:day:${alt}:am`));
        const pm  = toArray(await kvGET(`vb:day:${alt}:pm`));
        const lt  = toArray(await kvGET(`vb:day:${alt}:late`));
        arr = [...am, ...pm, ...lt];
        usedKey = `(am+pm+late/${alt})`;
      }
    }

    if (!arr.length) {
      return res.status(200).json({ updated: 0, reason: "no snapshot", tried: `vb:day:${day}:last` });
    }

    let updated = 0;
    let fetchBlocks = 0;

    for (const p of arr) {
      try {
        const fid = p?.fixture_id;
        if (!fid) continue;

        const insightKey = `vb:insight:${fid}`;
        const seen = await kvGET(insightKey).catch(()=>null);
        if (seen?.line) continue;

        const homeId = p?.teams?.home?.id;
        const awayId = p?.teams?.away?.id;
        const home   = p?.teams?.home?.name || p?.teams?.home || "Home";
        const away   = p?.teams?.away?.name || p?.teams?.away || "Away";

        if (!homeId || !awayId) {
          const mrk = `${p?.market_label || p?.market || ""}`.toUpperCase();
          const sel = `${p?.selection || ""}`;
          const line = `Duel: ${home} vs ${away}. Predlog: ${mrk} – ${sel}.`;
          const ok = await kvSET(insightKey, { line, at: new Date().toISOString() });
          if (ok) updated++;
          continue;
        }

        if (fetchBlocks >= MAX_FETCH_BLOCKS) {
          const tf = await kvGET(`vb:insight:team:${homeId}`).catch(()=>null);
          const af = await kvGET(`vb:insight:team:${awayId}`).catch(()=>null);
          const hh = await kvGET(`vb:insight:h2h:${homeId}:${awayId}`).catch(()=>null);
          if (tf?.wdl || af?.wdl || hh?.home) {
            const line = buildLineFrom(tf, af, hh, home, away, p);
            const ok = await kvSET(insightKey, { line, at: new Date().toISOString() });
            if (ok) updated++;
          }
          continue;
        }

        const [tHome, tAway, h2h] = await Promise.all([
          getTeamFormCached(homeId),
          getTeamFormCached(awayId),
          getH2HCached(homeId, awayId),
        ]);
        fetchBlocks++;

        const line = buildLineFrom(tHome, tAway, h2h, home, away, p);
        const ok = await kvSET(insightKey, { line, at: new Date().toISOString() });
        if (ok) updated++;
      } catch {}
    }

    return res.status(200).json({ updated, usedKey, fetch_blocks: fetchBlocks });
  } catch (e) {
    return res.status(200).json({ updated: 0, error: String(e?.message || e) });
  }
}
