// pages/api/cron/apply-learning.js
// Settle + history (sa povlačenjem finalnih rezultata iz API-FOOTBALL v3).
// Radi sa ENV: API_FOOTBALL_KEY ili NEXT_PUBLIC_API_FOOTBALL_KEY.
// KV fallback: KV_REST_API_* ili UPSTASH_REDIS_REST_* ili KV_URL.

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

function apiFootballKey() {
  return (
    process.env.API_FOOTBALL_KEY ||
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    ""
  );
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

/* ---------------- rezultat & settle helpers ---------------- */

function parseOUThreshold(it) {
  // podržava "Over 2.5" / "Under 2.5" / pick_code "O2.5"/"U2.5"
  const s =
    (it.selection_label || it.pick || it.selection || it.pick_code || "")
      .toString()
      .toUpperCase();
  const m = s.match(/([OU]|OVER|UNDER)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m) return parseFloat(m[2]);
  // fallback iz marketa "OU2.5"
  const m2 = String(it.market || it.market_label || "").match(/OU\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m2) return parseFloat(m2[1]);
  return 2.5; // najčešći prag
}

function pickSide(it) {
  const p = (it.selection_label || it.pick || it.selection || it.pick_code || "")
    .toString()
    .toUpperCase();
  if (p.startsWith("O") || p.startsWith("OVER")) return "OVER";
  if (p.startsWith("U") || p.startsWith("UNDER")) return "UNDER";
  if (p.includes("YES")) return "YES";
  if (p.includes("NO")) return "NO";
  if (p === "1" || p.includes("HOME")) return "HOME";
  if (p === "2" || p.includes("AWAY")) return "AWAY";
  if (p === "X" || p.includes("DRAW")) return "DRAW";
  // HT-FT: Home/Home, Draw/Draw, Home/Draw...
  if (p.includes("/")) return p;
  return p;
}

function winnerFromScore(h, a) {
  if (h > a) return "HOME";
  if (a > h) return "AWAY";
  return "DRAW";
}

function decideOutcomeFromFinals(it, finals) {
  // finals: { ft_home, ft_away, ht_home, ht_away, status, winner }
  if (!finals || typeof finals !== "object") return "PENDING";
  const market = (it.market || it.market_label || "").toUpperCase();
  const side = pickSide(it);
  const ftH = Number(finals.ft_home ?? finals.home ?? NaN);
  const ftA = Number(finals.ft_away ?? finals.away ?? NaN);
  const htH = Number(finals.ht_home ?? NaN);
  const htA = Number(finals.ht_away ?? NaN);
  const ftWinner = winnerFromScore(ftH, ftA);
  const htWinner = Number.isFinite(htH) && Number.isFinite(htA) ? winnerFromScore(htH, htA) : null;

  if (!Number.isFinite(ftH) || !Number.isFinite(ftA)) return "PENDING";

  // 1) 1X2
  if (market.includes("1X2") || market === "1X2") {
    if (side === "HOME") return ftWinner === "HOME" ? "WIN" : "LOSE";
    if (side === "DRAW") return ftWinner === "DRAW" ? "WIN" : "LOSE";
    if (side === "AWAY") return ftWinner === "AWAY" ? "WIN" : "LOSE";
  }

  // 2) OU
  if (market.includes("OU") || market.includes("OVER/UNDER") || market.includes("OVER") || market.includes("UNDER")) {
    const total = ftH + ftA;
    const thr = parseOUThreshold(it);
    if (side === "OVER") return total > thr ? "WIN" : "LOSE";
    if (side === "UNDER") return total < thr ? "WIN" : "LOSE";
  }

  // 3) BTTS
  if (market.includes("BTTS") || market.includes("BOTH") || market.includes("GG/NG")) {
    const btts = ftH > 0 && ftA > 0;
    if (side === "YES") return btts ? "WIN" : "LOSE";
    if (side === "NO") return btts ? "LOSE" : "WIN";
  }

  // 4) HT-FT
  if (market.includes("HT-FT") || market.includes("HT/FT")) {
    if (htWinner == null) return "PENDING";
    // side primeri: "HOME/HOME", "DRAW/DRAW", "HOME/DRAW", "DRAW/HOME", "AWAY/HOME", ...
    const parts = side.split("/").map((s) => s.trim());
    if (parts.length === 2) {
      const [htPick, ftPick] = parts;
      const okHT =
        htPick === "HOME" ? htWinner === "HOME" :
        htPick === "AWAY" ? htWinner === "AWAY" :
        htPick === "DRAW" ? htWinner === "DRAW" : false;
      const okFT =
        ftPick === "HOME" ? ftWinner === "HOME" :
        ftPick === "AWAY" ? ftWinner === "AWAY" :
        ftPick === "DRAW" ? ftWinner === "DRAW" : false;
      return okHT && okFT ? "WIN" : "LOSE";
    }
  }

  // Ostalo: bez eksplicitnih pravila → pending
  return "PENDING";
}

async function fetchFinalsFromAPIFootball(ids) {
  // ids: niz fixture ID-ova (max ~20 po batch-u)
  const key = apiFootballKey();
  if (!key || !ids.length) return {};
  const endpoint = `https://v3.football.api-sports.io/fixtures?ids=${ids.join(",")}`;
  const r = await fetch(endpoint, {
    headers: {
      "x-apisports-key": key,
    },
    cache: "no-store",
  });
  if (!r.ok) {
    // Nemoj da pukne ceo settle — samo vrati prazno
    return {};
  }
  const j = await r.json().catch(() => ({}));
  const map = {};
  for (const row of j?.response || []) {
    const fid = row?.fixture?.id;
    const ftH = row?.goals?.home;
    const ftA = row?.goals?.away;
    const htH = row?.score?.halftime?.home;
    const htA = row?.score?.halftime?.away;
    const status = row?.fixture?.status?.short; // "FT", "AET", "PEN", "NS"...
    if (fid != null) {
      map[fid] = {
        ft_home: ftH,
        ft_away: ftA,
        ht_home: htH,
        ht_away: htA,
        status,
        winner: winnerFromScore(Number(ftH), Number(ftA)),
        provider: "api-football",
      };
    }
  }
  return map;
}

async function ensureFinalsForFixtures(fixtureIds) {
  // Pročitaj postojeće finals:* iz KV; za nedostajuće zovi API u batch-evima.
  const finalsMap = {};
  // 1) pokušaj iz KV
  const cmds = fixtureIds.map((fid) => ["GET", `finals:${fid}`]);
  const out = cmds.length ? await kvPipeline(cmds) : [];
  for (let i = 0; i < fixtureIds.length; i++) {
    const fid = fixtureIds[i];
    const raw = out?.[i]?.result ?? null;
    if (raw) {
      try {
        finalsMap[fid] = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        // ignore parse
      }
    }
  }
  // 2) skupi nedostajuće
  const missing = fixtureIds.filter((fid) => !finalsMap[fid]);
  if (missing.length) {
    const chunk = (arr, n) => arr.reduce((a,_,i)=> (i%n? a[a.length-1].push(arr[i]) : a.push([arr[i]]), a), []);
    const batches = chunk(missing, 20);
    for (const batch of batches) {
      const fetched = await fetchFinalsFromAPIFootball(batch);
      for (const fid of Object.keys(fetched)) {
        finalsMap[fid] = fetched[fid];
        // upiši u KV (cache)
        await kvSetJSON(`finals:${fid}`, fetched[fid]);
      }
    }
  }
  return finalsMap;
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
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
      // 1) osiguraj LISTU kandidata
      const list = await ensureDayLastIsList(ymd);
      const items = dedupeBySignature(list);

      // 2) skup svih fixture_id
      const fids = Array.from(
        new Set(
          items
            .map((it) => it.fixture_id ?? it.id ?? it.fixtureId)
            .filter((x) => x != null)
        )
      );

      // 3) obezbedi finals:*
      const finals = await ensureFinalsForFixtures(fids);

      // 4) presudi ishode
      let settled = 0, won = 0, lost = 0, voided = 0, pending = 0;
      let staked = 0, returned = 0;
      const settledItems = [];

      for (const it of items) {
        const fid = it.fixture_id ?? it.id ?? it.fixtureId ?? null;
        const odds = Number(it?.odds?.price ?? 1) || 1;

        let outcome = "PENDING";
        const fin = fid != null ? finals[fid] : null;

        if (fin && fin.status && ["FT", "AET", "PEN"].includes(String(fin.status).toUpperCase())) {
          outcome = decideOutcomeFromFinals(it, fin);
        } else if (fin && Number.isFinite(fin.ft_home) && Number.isFinite(fin.ft_away)) {
          // ako status nije "FT" ali imamo FT golove, ipak presudi
          outcome = decideOutcomeFromFinals(it, fin);
        } else {
          outcome = "PENDING";
        }

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
          settled += 1;
          voided += 1;
        } else {
          pending += 1;
        }

        settledItems.push({ ...it, outcome, finals: fin || null });
      }

      const roi = staked > 0 ? (returned - staked) / staked : 0;

      const historyPayload = {
        ymd,
        counts: { total: items.length, settled, won, lost, voided, pending },
        roi: { staked, returned, roi },
        items: settledItems,
        meta: { builtAt: new Date().toISOString() },
      };

      // 5) upiši history + osveži last/union da ostanu LISTE
      await kvSetJSON(`hist:${ymd}`, historyPayload);
      await kvSetJSON(`hist:day:${ymd}`, historyPayload);
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
