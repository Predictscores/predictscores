// pages/api/value-bets-locked.js
import { kv } from '@vercel/kv';

/** TZ i slot definicija */
const TZ = process.env.TZ_DISPLAY || 'Europe/Belgrade';
const SLOT_ORDER = ['late', 'am', 'pm'];

function ymdInTZ(d = new Date(), tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [{ value: y }, , { value: m }, , { value: da }] = f.formatToParts(d);
  return `${y}-${m}-${da}`;
}
function hourInTZ(iso, tz = TZ) {
  try {
    const d = new Date(iso);
    const f = new Intl.DateTimeFormat('en', { timeZone: tz, hour: '2-digit', hour12: false });
    const [{ value: h }] = f.formatToParts(d).filter(p => p.type === 'hour');
    return Number(h);
  } catch { return null; }
}
function slotForHour(h) {
  if (h == null) return null;
  if (h < 10) return 'late';
  if (h < 15) return 'am';
  return 'pm';
}
function slotForKickoffISO(iso, tz = TZ) {
  return slotForHour(hourInTZ(iso, tz));
}
function inSlotLocal(iso, slot, tz = TZ) {
  const s = slotForKickoffISO(iso, tz);
  return !slot || !s ? false : s === slot;
}

/** robustan extract kickoff ISO iz raznih struktura */
function kickoffISO(it) {
  return (
    it?.kickoff_utc ||
    it?.kickoff ||
    it?.time?.starting_at?.date_time ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.datetime_local?.date_time ||
    it?.fixture?.date ||
    null
  );
}

/** utili */
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const uniqBy = (xs, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const x of xs) {
    const k = keyFn(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
};
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

/** scoring bez “čvrstih pragova” (čisto data-driven rang) */
function evScore(it) {
  const mp = num(it?.model_prob);
  const imp = num(it?.implied_prob) ?? (num(it?.market_odds) ? 1 / num(it.market_odds) : null);
  const edge = (mp != null && imp != null) ? (mp - imp) : 0;
  const conf = num(it?.confidence_pct) ?? (mp != null ? mp * 100 : 0);
  // ELR/Kelly signal ako imamo kvotu
  const odds = num(it?.market_odds);
  const elr = (mp != null && odds != null) ? Math.log( (mp * odds) || 1 ) : 0;
  return 1000 * edge + 5 * elr + 0.1 * conf; // linearna kombinacija, bez rezanja
}

/** cap po slotu za tikete (bez obzira na UI) */
function capsFor(slot) {
  // Želeo si 6/15/15 i 6/20/20 — PM/LATE širi.
  const wide = slot === 'pm' || slot === 'late';
  return {
    btts: 6,
    ou25: wide ? 20 : 15,
    htft: wide ? 20 : 15,
  };
}

async function getKV(key) {
  const v = await kv.get(key);
  return { key, status: v ? 'hit' : 'miss', value: v };
}

/** čita 1×2 kandidate iz više izvora i garantuje rezultat za traženi slot */
async function readItemsForSlot(ymd, slot, trace) {
  // prioritet: striktni slot → fallback union → fallback last
  const keys = [
    `vbl_full:${ymd}:${slot}`,
    `vbl:${ymd}:${slot}`,
    `vb:day:${ymd}:${slot}`,
    `vb:day:${ymd}:union`,
    `vb:day:${ymd}:last`,
  ];
  let picked = null;
  for (const k of keys) {
    const r = await getKV(k);
    trace.push({ key: k, flavor: 'vercel-kv', status: r.status });
    if (r.value && Array.isArray(r.value) && r.value.length) {
      picked = { key: k, list: r.value };
      break;
    }
  }
  const before = picked?.list?.length || 0;
  let list = arr(picked?.list);

  // uvek preseci na slot lokalno (ako nije već isečeno na writer-u)
  list = list.filter((it) => inSlotLocal(kickoffISO(it), slot, TZ));

  // ako je i dalje prazno, pokušaj iz union/last dodatno filtriranje po slotu
  if (!list.length) {
    for (const k of [`vb:day:${ymd}:union`, `vb:day:${ymd}:last`]) {
      const r = await getKV(k);
      trace.push({ key: k, flavor: 'vercel-kv', status: r.status });
      if (r.value && Array.isArray(r.value) && r.value.length) {
        const tmp = r.value.filter((it) => inSlotLocal(kickoffISO(it), slot, TZ));
        if (tmp.length) {
          list = tmp;
          break;
        }
      }
    }
  }

  // blago sortiranje (raniji kick-off, pa veći konf.)
  list.sort((a, b) => {
    const ta = new Date(kickoffISO(a) || 0).getTime();
    const tb = new Date(kickoffISO(b) || 0).getTime();
    if (ta !== tb) return ta - tb;
    const ca = num(a?.confidence_pct) ?? 0;
    const cb = num(b?.confidence_pct) ?? 0;
    return cb - ca;
  });

  return { items: list, before, after: list.length, source: picked?.key || null };
}

/** čita i “puni” tikete po slotu (slot → dnevni → drugi slotovi), bez duplikata */
async function readTicketsFilled(ymd, slot, trace) {
  const cap = capsFor(slot);
  const order = [
    `tickets:${ymd}:${slot}`, // željeni slot
    `tickets:${ymd}`,         // dnevni
    // susedni slotovi kao backfill
    ...SLOT_ORDER.filter(s => s !== slot).map(s => `tickets:${ymd}:${s}`),
  ];

  let collected = { btts: [], ou25: [], htft: [] };
  let sourceHit = null;

  const pushUniq = (list, add) => {
    const all = uniqBy([...list, ...arr(add)], (x) =>
      `${x?.fixture_id || x?.id || x?.fixture || 'x'}|${x?.market || x?.market_label || 'm'}`
    );
    return all;
  };

  for (const k of order) {
    const r = await getKV(k);
    trace.push({ key: k, flavor: 'vercel-kv', status: r.status });
    if (r.status === 'hit' && r.value && typeof r.value === 'object') {
      if (!sourceHit) sourceHit = k;
      const v = r.value;
      collected.btts = pushUniq(collected.btts, v.btts);
      collected.ou25 = pushUniq(collected.ou25, v.ou25);
      collected.htft = pushUniq(collected.htft, v.htft);

      // preseci na traženi slot i samo mečevi koji još nisu počeli
      const now = Date.now();
      const inSlotNotStarted = (x) => {
        const iso = kickoffISO(x);
        const t = new Date(iso || 0).getTime();
        return inSlotLocal(iso, slot, TZ) && (t > now);
      };
      collected.btts = collected.btts.filter(inSlotNotStarted);
      collected.ou25 = collected.ou25.filter(inSlotNotStarted);
      collected.htft = collected.htft.filter(inSlotNotStarted);

      // sortiraj po data-driven skoru (EV/ELR/Conf), pa preseci na cap
      const topN = (xs, n) => arr(xs).sort((a, b) => evScore(b) - evScore(a)).slice(0, n);

      const needMore =
        (collected.btts.length < cap.btts) ||
        (collected.ou25.length < cap.ou25) ||
        (collected.htft.length < cap.htft);

      if (!needMore) {
        collected = {
          btts: topN(collected.btts, cap.btts),
          ou25: topN(collected.ou25, cap.ou25),
          htft: topN(collected.htft, cap.htft),
        };
        return { tickets: collected, tickets_source: sourceHit, policy_cap: cap };
      }
      // ako i dalje fali – nastavi kroz naredne izvore u `order`
    }
  }

  // završni top-N čak i ako nije pun (nema dovoljno u danu)
  const topN = (xs, n) => arr(xs).sort((a, b) => evScore(b) - evScore(a)).slice(0, n);
  collected = {
    btts: topN(collected.btts, cap.btts),
    ou25: topN(collected.ou25, cap.ou25),
    htft: topN(collected.htft, cap.htft),
  };

  return { tickets: collected, tickets_source: sourceHit, policy_cap: cap };
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const now = new Date();
    const ymd = q.ymd || ymdInTZ(now, TZ);
    const slot = (q.slot || slotForHour(hourInTZ(now, TZ))).toLowerCase();
    const debug = String(q.debug || '') === '1' || String(q.debug || '').toLowerCase() === 'true';

    const trace = [];

    // 1) 1×2 predlozi
    const { items, before, after, source } = await readItemsForSlot(ymd, slot, trace);

    // 2) Tiketi – uvek puni koliko je moguće, per-slot prioritet
    const { tickets, tickets_source, policy_cap } = await readTicketsFilled(ymd, slot, trace);

    const body = {
      ok: true,
      slot,
      ymd,
      items,
      football: [],  // (ostavljeno zbog kompatibilnosti UI)
      top3: [],
      tickets,
      tickets_source: tickets_source || null,
      policy_cap: policy_cap?.ou25 || 15, // za screenshot-kompat
      source: source ? source.replace(`${ymd}:`, '') : null,
    };

    if (debug) {
      body.debug = { trace, before, after };
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(body);
  } catch (e) {
    console.error('value-bets-locked error', e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
