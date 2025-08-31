// pages/api/kv-scan.js
// Brza dijagnostika: proverava poznate ključeve za danas/juče/prekjuče i vraća "exists" + count.

const TZ = "Europe/Belgrade";
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function shiftDays(d, days) { const nd = new Date(d.getTime()); nd.setUTCDate(nd.getUTCDate() + days); return nd; }

async function kvGet(base, token, key) {
  const url = `${base.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { exists: false, items: 0, raw: null };
  let j = null; try { j = await r.json(); } catch {}
  let v = j?.result ?? null;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch {} }
  let items = 0;
  const arr = Array.isArray(v) ? v
    : Array.isArray(v?.items) ? v.items
    : Array.isArray(v?.value_bets) ? v.value_bets
    : Array.isArray(v?.football) ? v.football
    : Array.isArray(v?.data?.items) ? v.data.items
    : [];
  items = arr.length || 0;
  return { exists: v != null, items, raw: null };
}

export default async function handler(req, res) {
  try {
    const base = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!base || !token) return res.status(500).json({ ok:false, error:"KV env missing" });

    const now = new Date();
    const days = [0,-1,-2];
    const slots = ["late","am","pm"];
    const rows = [];

    for (const d of days) {
      const ymd = ymdInTZ(shiftDays(now, d), TZ);

      // vbl / vbl_full
      for (const s of slots) {
        rows.push({ ymd, s, key: `vbl:${ymd}:${s}` });
        rows.push({ ymd, s, key: `vbl_full:${ymd}:${s}` });
      }
      // vb pointer + varijante
      rows.push({ ymd, s: "-", key: `vb:day:${ymd}:last` });
      for (const s of slots) {
        rows.push({ ymd, s, key: `vb:locked:${ymd}:${s}` });
        rows.push({ ymd, s, key: `vb_locked:${ymd}:${s}` });
        rows.push({ ymd, s, key: `vb-locked:${ymd}:${s}` });
        rows.push({ ymd, s, key: `locked:vbl:${ymd}:${s}` });
      }
    }

    const out = [];
    for (const r of rows) {
      const got = await kvGet(base, token, r.key);
      out.push({ key: r.key, ymd: r.ymd, slot: r.s, exists: got.exists, items: got.items });
    }

    return res.status(200).json({ ok:true, out });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
