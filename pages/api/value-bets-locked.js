// pages/api/value-bets-locked.js
// KV-only shortlist sa pametnim fallbackom po slotovima i danima,
// plus podrška za ranije pointere tipa "vb:day:<YMD>:last" i varijante.
// Ne zove spoljne API-je.

const TZ = "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function shiftDays(d, days) {
  const nd = new Date(d.getTime());
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}
function currentHour(tz = TZ) {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date()));
}
// late = 00:00–09:59, am = 10:00–14:59, pm = 15:00–23:59
function slotOfHour(h) { return h < 10 ? "late" : h < 15 ? "am" : "pm"; }
function currentSlot(tz = TZ) { return slotOfHour(currentHour(tz)); }

function orderForSlot(slot) {
  if (slot === "late") return ["late", "am", "pm"];
  if (slot === "am")   return ["am", "pm", "late"];
  return ["pm", "am", "late"];
}

async function kvFetchJSON(key) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN nisu postavljeni");
  const url = `${base.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { ok: false, key, exists: false, value: null };
  let j = null;
  try { j = await r.json(); } catch {}
  const raw = j?.result ?? null;
  if (raw == null) return { ok: true, key, exists: false, value: null };
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { value = raw; }
  }
  return { ok: true, key, exists: true, value };
}

function takeItems(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.items)) return x.items;
  if (Array.isArray(x.value_bets)) return x.value_bets;
  if (Array.isArray(x.football)) return x.football;
  // dozvoli i „data“ wrapper
  if (Array.isArray(x.data?.items)) return x.data.items;
  if (Array.isArray(x.data?.value_bets)) return x.data.value_bets;
  if (Array.isArray(x.data?.football)) return x.data.football;
  return [];
}

function uniqueByFixture(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const id =
      it?.fixture_id ??
      it?.fixture?.id ??
      `${it?.league?.id || ""}:${it?.teams?.home?.name || it?.home}-${it?.teams?.away?.name || it?.away}`;
    if (!seen.has(id)) { seen.add(id); out.push(it); }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd = (req.query.ymd && String(req.query.ymd)) || ymdInTZ(now, TZ);
    const qSlot = (req.query.slot && String(req.query.slot)) || currentSlot(TZ);
    const n = Math.max(0, Math.min(200, Number(req.query.n ?? 0))); // 0 = bez limita
    const wantDebug = String(req.query.debug || "") === "1";

    // 1) danas: traženi slot → ostali slotovi (vbl, vbl_full)
    const candidates = [];
    for (const s of orderForSlot(qSlot)) {
      candidates.push({ key: `vbl:${ymd}:${s}`, label: `vbl:${ymd}:${s}` });
      candidates.push({ key: `vbl_full:${ymd}:${s}`, label: `vbl_full:${ymd}:${s}` });
    }

    // 2) juče i 3) prekjuče (pm→am→late; vbl, vbl_full)
    for (const delta of [-1, -2]) {
      const y = ymdInTZ(shiftDays(now, delta), TZ);
      for (const s of ["pm", "am", "late"]) {
        candidates.push({ key: `vbl:${y}:${s}`, label: `vbl:${y}:${s}` });
        candidates.push({ key: `vbl_full:${y}:${s}`, label: `vbl_full:${y}:${s}` });
      }
    }

    // 4) „vb“ pointeri i varijante za isti dan → juče → prekjuče
    const ymds = [ymd, ymdInTZ(shiftDays(now, -1), TZ), ymdInTZ(shiftDays(now, -2), TZ)];
    for (const y of ymds) {
      // prvo pokušaj day-last pointer
      candidates.push({ key: `vb:day:${y}:last`, label: `vb:day:${y}:last#ptr` });
      // pa potencijalne zaključane varijante po slotu
      for (const s of ["pm", "am", "late"]) {
        candidates.push({ key: `vb:locked:${y}:${s}`,   label: `vb:locked:${y}:${s}` });
        candidates.push({ key: `vb_locked:${y}:${s}`,   label: `vb_locked:${y}:${s}` });
        candidates.push({ key: `vb-locked:${y}:${s}`,   label: `vb-locked:${y}:${s}` });
        candidates.push({ key: `locked:vbl:${y}:${s}`, label: `locked:vbl:${y}:${s}` });
      }
    }

    const debugTried = [];
    let items = [];
    let chosen = null;

    // helper: ako pointer sadrži string koji izgleda kao ključ, pokušaj i njega
    async function tryPointerValue(val) {
      if (typeof val === "string") {
        // String može biti JSON-string ili direktno ime ključa
        // npr. "vbl:2025-08-31:am" ili "{\"key\":\"vbl:...\"}"
        try {
          const obj = JSON.parse(val);
          if (obj && typeof obj === "object" && typeof obj.key === "string") {
            debugTried.push(`→ ptr.key:${obj.key}`);
            const r2 = await kvFetchJSON(obj.key);
            if (r2.exists) {
              const got = takeItems(r2.value);
              if (got.length) return { items: got, via: `ptr:${obj.key}` };
            }
          }
        } catch { /* not JSON */ }
        // probaj direkt kao ključ
        debugTried.push(`→ ptr.asKey:${val}`);
        const r3 = await kvFetchJSON(val);
        if (r3.exists) {
          const got = takeItems(r3.value);
          if (got.length) return { items: got, via: `ptr:${val}` };
        }
      }
      // Ako nije string, možda već sadrži items
      const got = takeItems(val);
      if (got.length) return { items: got, via: "ptr:embedded" };
      return null;
    }

    for (const c of candidates) {
      debugTried.push(c.label);
      const r = await kvFetchJSON(c.key);
      if (!r.exists) continue;

      // Ako je ovo "vb:day:<YMD>:last", probaj pointer logiku
      if (c.label.endsWith("#ptr")) {
        const tryPtr = await tryPointerValue(r.value);
        if (tryPtr && tryPtr.items.length) {
          items = uniqueByFixture(tryPtr.items);
          chosen = { label: `${c.label}→${tryPtr.via}` };
          break;
        }
      }

      const got = takeItems(r.value);
      if (got.length) {
        items = uniqueByFixture(got);
        chosen = { label: c.label };
        break;
      }
    }

    if (!items.length) {
      return res.status(200).json({
        ok: true,
        slot: qSlot,
        ymd,
        items: [],
        value_bets: [],
        football: [],
        source: "vb-locked:kv:miss·fallback+vb",
        ...(wantDebug ? { debug_tried: debugTried } : {}),
      });
    }

    if (n > 0 && items.length > n) items = items.slice(0, n);

    return res.status(200).json({
      ok: true,
      slot: qSlot,
      ymd,
      items,
      value_bets: items,
      football: items,
      source: `vb-locked:kv:hit·${chosen?.label || "unknown"}`,
      ...(wantDebug ? { debug_tried: debugTried } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
