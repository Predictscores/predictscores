// pages/api/cron/apply-learning.js
// Normalize + settle + build daily history with ROI.
// No new deps; works with KV_REST_API_* and UPSTASH_REDIS_REST_* envs.

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
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmds),
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`KV pipeline HTTP ${r.status}: ${t}`);
  }
  return r.json();
}

async function kvGet(key) {
  const out = await kvPipeline([["GET", key]]);
  return out?.[0]?.result ?? null;
}
async function kvSet(key, val) {
  const out = await kvPipeline([["SET", key, val]]);
  return out?.[0]?.result ?? "OK";
}
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
async function kvSetJSON(key, obj) {
  return kvSet(key, JSON.stringify(obj));
}

function isPointerString(x) {
  return (
    typeof x === "string" &&
    /^vb:day:\d{4}-\d{2}-\d{2}:(am|pm|late|union)$/.test(x)
  );
}

function dedupeBySignature(items = []) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? "";
    const mkt = it.market ?? it.market_label ?? "";
    const sel = it.pick ?? it.selection ?? it.selection_label ?? "";
    const sig = `${fid}::${mkt}::${sel}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(it);
    }
  }
  return out;
}

async function readDayListLastOrNull(ymd) {
  const lastKey = `vb:day:${ymd}:last`;
  const last = await kvGetJSON(lastKey);
  if (Array.isArray(last)) return last;

  if (isPointerString(last)) {
    const deref = await kvGetJSON(String(last));
    if (Array.isArray(deref)) return deref;
  }

  if (typeof last === "string") {
    const s = last.trim();
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed; } catch {}
    }
  }
  return null;
}

async function buildDayUnion(ymd) {
  const slots = ["am", "pm", "late"];
  const chunks = [];
  for (const slot of slots) {
    const arr = await kvGetJSON(`vbl:${ymd}:${slot}`);
    if (Array.isArray(arr) && arr.length) chunks.push(...arr);
  }
  return dedupeBySignature(chunks);
}

async function ensureDayLastIsList(ymd) {
  const existing = await readDayListLastOrNull(ymd);
  if (existing && existing.length) {
    await kvSetJSON(`vb:day:${ymd}:union`, dedupeBySignature(existing));
    return existing;
  }
  const union = await kvGetJSON(`vb:day:${ymd}:union`);
  if (Array.isArray(union) && union.length) {
    await kvSetJSON(`vb:day:${ymd}:last`, union);
    return union;
  }
  const built = await buildDayUnion(ymd);
  await kvSetJSON(`vb:day:${ymd}:last`, built);
  await kvSetJSON(`vb:day:${ymd}:union`, built);
  return built;
}

/**
 * Heuristika za "settle" bez spoljnog API-ja:
 * - ako postoji KV final rezultat, koristi ga,
 * - inače ako kickoff < now-4h → označi PENDING (da ne lažiramo),
 * - ROI: stake 1, ako WIN i ima odds.price → +price, inače +0.
 * 
 * Ako kod već ima svoje "final score" ključeve, ovde možeš da ih mapiraš:
 *   scores:<fixture_id>        = { ft_home, ft_away, winner:"HOME|AWAY|DRAW" }
 *   finals:<fixture_id>        = { result:"WIN|LOSE|VOID|PUSH" }
 *   result:<fixture_id>        = "WIN|LOSE|VOID|PUSH"
 */
async function readResultForFixture(fid) {
  // razni mogući ključevi (što više fallback-ova)
  const candidates = [
    `finals:${fid}`,
    `scores:${fid}`,
    `result:${fid}`,
    `settled:${fid}`,
  ];
  for (const k of candidates) {
    const v = await kvGetJSON(k);
    if (v) return { key: k, value: v };
  }
  return null;
}

function decideOutcome(item, finalObj) {
  // Ako postoji direktan result string:
  if (typeof finalObj === "string") {
    const s = finalObj.toUpperCase();
    if (s.includes("WIN")) return "WIN";
    if (s.includes("LOSE")) return "LOSE";
    if (s.includes("VOID") || s.includes("PUSH")) return "VOID";
  }
  // Ako je objekat sa winner i tržištem 1X2:
  if (finalObj && typeof finalObj === "object") {
    const winner = (finalObj.winner || finalObj.result || "").toString().toUpperCase();
    const market = (item.market || item.market_label || "").toUpperCase();
    const pick = (item.pick || item.selection || item.selection_label || "").toUpperCase();

    // Minimalna pokrivenost za 1X2 (heuristika):
    if (market.includes("1X2")) {
      if (pick === "HOME" || pick === "1") return winner === "HOME" ? "WIN" : winner ? "LOSE" : "PENDING";
      if (pick === "DRAW" || pick === "X") return winner === "DRAW" ? "WIN" : winner ? "LOSE" : "PENDING";
      if (pick === "AWAY" || pick === "2") return winner === "AWAY" ? "WIN" : winner ? "LOSE" : "PENDING";
    }
    // Ostala tržišta: bez sigurnih pravila bez izvora — ostavi PENDING ako nemamo eksplicitno polje
  }
  return "PENDING";
}

function toKickoffISO(x) {
  return (
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff ||
    x?.kickoff_utc ||
    null
  );
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ymdParam = url.searchParams.get("ymd");
    const days = Math.max(1, Math.min(14, parseInt(url.searchParams.get("days") || "1", 10)));

    const today = new Date();
    const ymds = [];
    if (ymdParam) {
      ymds.push(ymdParam);
    } else {
      for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        ymds.push(d.toISOString().slice(0, 10));
      }
    }

    const reports = [];

    for (const ymd of ymds) {
      // 1) osiguraj LISTU za dan
      const list = await ensureDayLastIsList(ymd);
      const items = dedupeBySignature(list);

      let settled = 0, won = 0, lost = 0, voided = 0, pending = 0;
      let staked = 0, returned = 0;

      const now = Date.now();
      const settledItems = [];

      for (const it of items) {
        const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? null;
        const odds = Number(it?.odds?.price ?? 1) || 1;

        // default PENDING (ne izmišljamo ishode)
        let outcome = "PENDING";

        // pokušaj da nađeš rezultat u KV
        if (fid != null) {
          const finalKV = await readResultForFixture(fid);
          if (finalKV) {
            outcome = decideOutcome(it, finalKV.value);
          }
        }

        // ako nemamo rezultat a kickoff je davno, ostaje PENDING
        // (ne forsiramo WIN/LOSE bez izvora)
        if (outcome === "WIN") {
          staked += 1;
          returned += odds;
          settled += 1;
          won += 1;
        } else if (outcome === "LOSE") {
          staked += 1;
          returned += 0;
          settled += 1;
          lost += 1;
        } else if (outcome === "VOID" || outcome === "PUSH") {
          // ne utiče na ROI
          settled += 1;
          voided += 1;
        } else {
          pending += 1;
        }

        settledItems.push({ ...it, outcome });
      }

      const roi = staked > 0 ? (returned - staked) / staked : 0;

      const historyPayload = {
        ymd,
        counts: { total: items.length, settled, won, lost, voided, pending },
        roi: { staked, returned, roi },
        items: settledItems,
        meta: { builtAt: new Date().toISOString() },
      };

      // 2) upiši oba ključa zbog kompatibilnosti UI-a
      await kvSetJSON(`hist:${ymd}`, historyPayload);
      await kvSetJSON(`hist:day:${ymd}`, historyPayload);

      // 3) “last” ostaje LISTA (ne pointer)
      await kvSetJSON(`vb:day:${ymd}:last`, items);
      await kvSetJSON(`vb:day:${ymd}:union`, items);

      reports.push({
        ymd,
        totals: historyPayload.counts,
        roi: historyPayload.roi,
      });
    }

    res.status(200).json({ ok: true, days: ymds.length, report: reports });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
