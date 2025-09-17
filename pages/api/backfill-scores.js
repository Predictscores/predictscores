// FILE: pages/api/backfill-scores.js
import { afxGetJson } from "../../lib/sources/apiFootball";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const MAX_DAYS = 14;
const MAX_IDS_PER_CALL = 20; // batch veličina

/* ---------- KV helpers ---------- */
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
}

/* ---------- util ---------- */
function ymdList(days) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    out.push(fmt.format(d)); // "YYYY-MM-DD"
  }
  return out;
}
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function extractScore(fx) {
  const sc = fx?.score || {};
  const ht = sc?.halftime || {};
  const ft = sc?.fulltime || {};
  const ftH = Number.isFinite(Number(ft?.home)) ? Number(ft.home) : Number(sc?.home);
  const ftA = Number.isFinite(Number(ft?.away)) ? Number(ft.away) : Number(sc?.away);
  const htH = Number.isFinite(Number(ht?.home)) ? Number(ht.home) : null;
  const htA = Number.isFinite(Number(ht?.away)) ? Number(ht.away) : null;
  const short = fx?.fixture?.status?.short || "";
  return { ftH, ftA, htH, htA, short };
}
function isFinal(short) {
  const s = String(short).toUpperCase();
  return s === "FT" || s === "AET" || s === "PEN";
}

export default async function handler(req, res) {
  try {
    const qDays = Number(req.query.days || 10);
    const days = Math.max(1, Math.min(MAX_DAYS, qDays));

    // 1) Skupi fixture_id iz poslednjih X dana
    const ymds = ymdList(days);
    const allIds = new Set();
    for (const ymd of ymds) {
      const snap = await kvGet(`vb:day:${ymd}:last`);
      if (!Array.isArray(snap)) continue;
      for (const p of snap) {
        const fid = p?.fixture_id;
        if (fid) allIds.add(Number(fid));
      }
    }
    const ids = Array.from(allIds);

    // 2) Preskoči one koji već imaju score
    const need = [];
    for (const id of ids) {
      const sc = await kvGet(`vb:score:${id}`);
      if (!sc || sc.ftH == null || sc.ftA == null) need.push(id);
    }

    // 3) Batch fetch rezultata
    let written = 0, skipped = ids.length - need.length, fetched = 0, finals = 0;
    let budgetStop = false;
    const batches = chunk(need, MAX_IDS_PER_CALL);
    for (const group of batches) {
      const idStr = group.join("-");
      const json = await afxGetJson(`/fixtures?ids=${idStr}`, { priority: "P2" });
      if (!json) { budgetStop = true; break; }
      const rows = Array.isArray(json?.response) ? json.response : [];
      fetched += rows.length;
      for (const fx of rows) {
        const id = fx?.fixture?.id;
        if (!id) continue;
        const { ftH, ftA, htH, htA, short } = extractScore(fx);
        if (!Number.isFinite(ftH) || !Number.isFinite(ftA)) continue;
        await kvSet(`vb:score:${id}`, { ftH, ftA, htH, htA, status: short, built_at: new Date().toISOString() });
        written += 1;
        if (isFinal(short)) finals += 1;
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      days,
      candidates: ids.length,
      already_had: skipped,
      fetched,
      written,
      finals_recorded: finals,
      budget_exhausted: budgetStop,
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
