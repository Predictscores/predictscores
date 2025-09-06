// pages/api/cron/rebuild.js
// Rebuild "locked" dnevne ključeve za zadati slot.
// Ako nema kandidata u vb:day:*, fallback na vbl/vbl_full kako bi Snapshot dobio ne-prazan feed.
// Ne menja istoriju: pišemo samo u vb:day:* ključeve, format kompatibilan sa postojećim reader-ima.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ---------------- KV (Vercel REST, RW/RO token) ---------------- */
function getKvCfgs() {
  const url = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const rw  = process.env.KV_REST_API_TOKEN || "";
  const ro  = process.env.KV_REST_API_READ_ONLY_TOKEN || "";
  const out = [];
  if (url && rw) out.push({ flavor: "vercel-kv:rw", url, token: rw });
  if (url && ro) out.push({ flavor: "vercel-kv:ro", url, token: ro });
  return out;
}

async function kvGET_first(key, diag) {
  const cfgs = getKvCfgs();
  for (const c of cfgs) {
    try {
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${c.token}` },
        cache: "no-store",
      });
      const ok = r.ok;
      const j  = ok ? await r.json().catch(() => null) : null;
      const val = j && typeof j.result === "string" ? j.result : null;
      diag && (diag[c.flavor] = diag[c.flavor] || {},
               diag[c.flavor][key] = ok ? (val ? `hit(len=${val.length})` : "miss(null)") : `miss(http ${r.status})`,
               diag[c.flavor]._url = c.url);
      if (val) return { raw: val, flavor: c.flavor, url: c.url };
    } catch (e) {
      diag && (diag[c.flavor] = diag[c.flavor] || {},
               diag[c.flavor][key] = `miss(err:${String(e?.message||e).slice(0,60)})`);
    }
  }
  return { raw: null, flavor: null, url: null };
}

async function kvSET_all(key, valueString, diag) {
  // valueString treba da bude STRING; pišemo {"value": valueString} da ostanemo kompatibilni
  const cfgs = getKvCfgs().filter(c => c.flavor.includes(":rw"));
  let okAny = false;
  for (const c of cfgs) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ value: valueString }),
      });
      const ok = r.ok;
      diag && (diag[c.flavor] = diag[c.flavor] || {},
               diag[c.flavor][`SET ${key}`] = ok ? "ok" : `http ${r.status}`);
      okAny = okAny || ok;
    } catch (e) {
      diag && (diag[c.flavor] = diag[c.flavor] || {},
               diag[c.flavor][`SET ${key}`] = `err:${String(e?.message||e).slice(0,60)}`);
    }
  }
  return okAny;
}

/* ---------------- parsing helpers (robust) ---------------- */
function J(s){ try{ return JSON.parse(s); }catch{ return null; } }
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v1 = J(raw);
  if (Array.isArray(v1)) return v1;
  if (v1 && typeof v1 === "object" && "value" in v1) {
    if (Array.isArray(v1.value)) return v1.value;
    if (typeof v1.value === "string") {
      const v2 = J(v1.value);
      if (Array.isArray(v2)) return v2;
      if (v2 && typeof v2 === "object") {
        if (Array.isArray(v2.items)) return v2.items;
        if (Array.isArray(v2.value_bets)) return v2.value_bets;
        if (Array.isArray(v2.football)) return v2.football;
        if (Array.isArray(v2.list)) return v2.list;
        if (Array.isArray(v2.data)) return v2.data;
      }
    }
    return null;
  }
  if (v1 && typeof v1 === "object") {
    if (Array.isArray(v1.items)) return v1.items;
    if (Array.isArray(v1.value_bets)) return v1.value_bets;
    if (Array.isArray(v1.football)) return v1.football;
    if (Array.isArray(v1.list)) return v1.list;
    if (Array.isArray(v1.data)) return v1.data;
  }
  return null;
}

/* ---------------- time helpers ---------------- */
function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour:"2-digit", hour12:false });
  return parseInt(fmt.format(d),10);
}
// Usklađeno sa reader-om: late 00–09, am 10–14, pm 15–23
function deriveSlot(h){ if (h<10) return "late"; if (h<15) return "am"; return "pm"; }

/* ---------------- kickoff helpers + slot filter (align with locked reader) ---------------- */
function kickoffDate(x){
  const s =
    x?.kickoff_utc ||
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_utc ||
    x?.start_time?.utc ||
    x?.start_time;
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function inSlotLocal(item, slot) {
  const d = kickoffDate(item);
  if (!d) return true; // ako ne znamo vreme, ne odbacuj
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control","no-store");
    const q = req.query || {};
    const now = new Date();
    const ymd = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
    const wantDebug = String(q.debug ?? "") === "1";
    const diag = wantDebug ? {} : null;

    // 1) pokušaj primarnih kandidata u vb:day:*
    const primKeys = [
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
    ];
    let candidates = null, src = null;
    for (const k of primKeys) {
      const { raw } = await kvGET_first(k, diag);
      const arr = arrFromAny(unpack(raw));
      if (arr && arr.length) { candidates = arr; src = k; break; }
    }

    // 2) fallback: vbl/vbl_full ako primarni ne postoje
    if (!candidates || !candidates.length) {
      const fbKeys = [
        `vbl:${ymd}:${slot}`,
        `vbl_full:${ymd}:${slot}`,
      ];
      for (const k of fbKeys) {
        const { raw } = await kvGET_first(k, diag);
        const arr = arrFromAny(unpack(raw));
        if (arr && arr.length) { candidates = arr; src = `${k}→fallback`; break; }
      }
    }

    if (!candidates || !candidates.length) {
      // ništa ne diramo
      return res.status(200).json({
        ok: true,
        ymd,
        mutated: false,
        counts: { union: 0, last: 0, combined: 0 },
        note: "no candidates → keys NOT mutated",
        ...(wantDebug ? { debug: diag } : {})
      });
    }

    // slot-filter: zadrži samo utakmice koje pripadaju traženom slotu
    const beforeCount = candidates.length;
    candidates = candidates.filter(x => inSlotLocal(x, slot));
    const afterCount = candidates.length;
    if (diag) {
      diag._slot_filter = { slot, before: beforeCount, after: afterCount };
    }

    // 3) upiši kandidata u vb:day:* (kompatibilan format: {"value":"[...]"})
    const payloadString = JSON.stringify(candidates);            // "[{...}]"
    const stored = JSON.stringify({ value: payloadString });     // {"value":"[...]"}
    const kSlot   = `vb:day:${ymd}:${slot}`;
    const kUnion  = `vb:day:${ymd}:union`;
    const kLast   = `vb:day:${ymd}:last`;

    await kvSET_all(kSlot,  stored, diag);
    await kvSET_all(kUnion, stored, diag);
    await kvSET_all(kLast,  stored, diag);

    return res.status(200).json({
      ok: true,
      ymd,
      mutated: true,
      counts: {
        union: candidates.length,
        last:  candidates.length,
        combined: candidates.length,
      },
      source: src,
      ...(wantDebug ? { debug: diag } : {})
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}

// helpers used above
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.items)) return x.items;
  if (Array.isArray(x.value_bets)) return x.value_bets;
  if (Array.isArray(x.football)) return x.football;
  if (Array.isArray(x.list)) return x.list;
  if (Array.isArray(x.data)) return x.data;
  return null;
}
