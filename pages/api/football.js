// FILE: pages/api/football.js

/**
 * Football predictions endpoint (robust fallback).
 *
 * Izvori:
 *  - API-Football /predictions  (glavni signal: 1X2, BTTS, HT/FT + procenti)
 *  - API-Football /odds         (pokušaj kvota; ako nema, ostavi null)
 *  - SportMonks (opciono; ako plan vrati nešto – koristi za konsenzus)
 *
 * Pravila:
 *  1) Ako postoji konsenzus (isti match+market+pick u ≥2 izvora) → prikaži to (top 10).
 *  2) Ako konsenzusa nema → prikaži API-Football predictions (top 12 po procentu).
 *
 * Napomena: kvote se ne zahtevaju (mogu biti null).
 */

const API_FOOTBALL_KEY =
  process.env.API_FOOTBALL_KEY ||
  process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
  "";

const SPORTMONKS_KEY = process.env.SPORTMONKS_KEY || "";

// ---- Helpers

function pctToNumber(p) {
  if (p == null) return null;
  if (typeof p === "number") return p;
  const s = String(p).trim().replace("%", "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function groupKey(p) {
  return `${p.match}||${p.market}||${p.pick}`;
}

// ---- API-Football helpers

async function afFetch(path, { ttl = 0 } = {}) {
  if (!API_FOOTBALL_KEY) throw new Error("API_FOOTBALL_KEY missing");
  const url = `https://v3.football.api-sports.io${path}`;
  const res = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
    // cache: "no-store"  // po želji
  });
  if (!res.ok) throw new Error(`AF ${path} -> ${res.status}`);
  return res.json();
}

async function afFixturesTodayOrNext(limit = 50) {
  // Prefer “today” za evropske utakmice, uz fallback na next
  try {
    const today = new Date().toISOString().slice(0, 10); // UTC datum je ok za shortlist
    const j = await afFetch(`/fixtures?date=${today}`);
    const list = Array.isArray(j?.response) ? j.response : [];
    if (list.length) return list.slice(0, limit);
  } catch (_) {}
  // fallback
  const j2 = await afFetch(`/fixtures?next=${limit}`);
  return Array.isArray(j2?.response) ? j2.response : [];
}

async function afPredictionsForFixture(fixtureId) {
  const j = await afFetch(`/predictions?fixture=${fixtureId}`);
  return Array.isArray(j?.response) ? j.response[0]?.predictions || j.response[0] : null;
}

async function afOddsForFixture(fixtureId) {
  // Agregiramo median kvotu po tržištu/izboru (ako postoji)
  try {
    const j = await afFetch(`/odds?fixture=${fixtureId}`);
    const rows = Array.isArray(j?.response) ? j.response : [];
    const acc = { "1X2": { "1": [], "X": [], "2": [] }, "BTTS": { "Yes": [], "No": [] }, "HT/FT": {} };

    for (const row of rows) {
      const books = row?.bookmakers || [];
      for (const bm of books) {
        const bets = bm?.bets || [];
        for (const bet of bets) {
          const name = (bet?.name || "").toLowerCase();

          // 1X2 / Full Time Result
          if (name.includes("match winner") || name.includes("1x2") || name.includes("full time result")) {
            for (const v of bet.values || []) {
              const lbl = (v?.value || "").toUpperCase();
              const odd = Number(v?.odd);
              if (!Number.isFinite(odd)) continue;
              if (lbl === "HOME" || lbl === "1") acc["1X2"]["1"].push(odd);
              if (lbl === "DRAW" || lbl === "X") acc["1X2"]["X"].push(odd);
              if (lbl === "AWAY" || lbl === "2") acc["1X2"]["2"].push(odd);
            }
          }

          // BTTS
          if (name.includes("both teams to score") || name.includes("btts")) {
            for (const v of bet.values || []) {
              const lbl = (v?.value || "").toLowerCase();
              const odd = Number(v?.odd);
              if (!Number.isFinite(odd)) continue;
              if (lbl.includes("yes")) acc["BTTS"]["Yes"].push(odd);
              if (lbl.includes("no"))  acc["BTTS"]["No"].push(odd);
            }
          }

          // HT/FT (Half Time/Full Time)
          if (name.includes("half time/full time") || name.includes("ht/ft")) {
            acc["HT/FT"] = acc["HT/FT"] || {};
            for (const v of bet.values || []) {
              const lbl = (v?.value || "").toUpperCase(); // npr "X/2"
              const odd = Number(v?.odd);
              if (!Number.isFinite(odd) || !lbl) continue;
              acc["HT/FT"][lbl] = acc["HT/FT"][lbl] || [];
              acc["HT/FT"][lbl].push(odd);
            }
          }
        }
      }
    }

    const median = (arr) =>
      arr && arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;

    const odds = {
      "1X2": { "1": median(acc["1X2"]["1"]), "X": median(acc["1X2"]["X"]), "2": median(acc["1X2"]["2"]) },
      "BTTS": { "Yes": median(acc["BTTS"]["Yes"]), "No": median(acc["BTTS"]["No"]) },
      "HT/FT": {}
    };

    for (const k of Object.keys(acc["HT/FT"])) {
      odds["HT/FT"][k] = median(acc["HT/FT"][k]);
    }
    return odds;
  } catch {
    return null;
  }
}

// ---- SportMonks (opciono, zavisi od plana; koristimo samo ako vrati nešto smisleno)

async function smFetchBetween(fromYmd, toYmd) {
  if (!SPORTMONKS_KEY) return null;
  const url = `https://soccer.sportmonks.com/api/v2.0/fixtures/between/${fromYmd}/${toYmd}?api_token=${SPORTMONKS_KEY}&include=odds,localTeam,visitorTeam`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function sportmonksPreds() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const j = await smFetchBetween(today, tomorrow);
    const data = Array.isArray(j?.data) ? j.data.slice(0, 30) : [];
    const out = [];

    for (const f of data) {
      const home = f?.localTeam?.data?.name || "Home";
      const away = f?.visitorTeam?.data?.name || "Away";
      const matchName = `${home} vs ${away}`;
      const oddsWrapper = f?.odds?.data || [];

      for (const market of oddsWrapper) {
        const name = (market?.name || "").toLowerCase();

        if (name.includes("1x2")) {
          for (const v of market?.odds || []) {
            const pick = (v?.label || "").toUpperCase(); // "1","X","2"
            const odd = Number(v?.price || v?.value);
            const conf = Number.isFinite(odd) ? Math.min(100, Math.round((1 - 1 / odd) * 100)) : 0;
            out.push({ match: matchName, market: "1X2", pick, odds: Number.isFinite(odd) ? odd : null, confidence: conf, source: "sportmonks" });
          }
        }

        if (name.includes("both to score") || name.includes("btts")) {
          for (const v of market?.odds || []) {
            const pick = /yes/i.test(v?.label) ? "Yes" : "No";
            const odd = Number(v?.price || v?.value);
            const conf = Number.isFinite(odd) ? Math.min(100, Math.round((1 - 1 / odd) * 100)) : 0;
            out.push({ match: matchName, market: "BTTS", pick, odds: Number.isFinite(odd) ? odd : null, confidence: conf, source: "sportmonks" });
          }
        }

        if (name.includes("half time/full time") || name.includes("ht/ft")) {
          for (const v of market?.odds || []) {
            const pick = String(v?.label || "").toUpperCase(); // npr "X/2"
            const odd = Number(v?.price || v?.value);
            const conf = Number.isFinite(odd) ? Math.min(100, Math.round((1 - 1 / odd) * 100)) : 0;
            if (pick) out.push({ match: matchName, market: "HT/FT", pick, odds: Number.isFinite(odd) ? odd : null, confidence: conf, source: "sportmonks" });
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---- Konsenzus i fallback AF predictions

function buildConsensus(preds) {
  // grupiši i uzmi samo kombinacije sa count ≥ 2
  const map = new Map();
  for (const p of preds) {
    const k = groupKey(p);
    if (!map.has(k)) map.set(k, { ...p, count: 0, confidences: [], oddsList: [], srcs: [] });
    const e = map.get(k);
    e.count += 1;
    e.confidences.push(p.confidence || 0);
    if (p.odds != null) e.oddsList.push(p.odds);
    e.srcs.push(p.source);
  }

  const out = [];
  for (const e of map.values()) {
    if (e.count < 2) continue;
    const avgConf = Math.round(e.confidences.reduce((a, b) => a + b, 0) / e.confidences.length);
    const odds = e.oddsList.length ? e.oddsList.sort((a, b) => a - b)[Math.floor(e.oddsList.length / 2)] : null;
    out.push({ match: e.match, prediction: `${e.market}: ${e.pick}`, odds, confidence: avgConf, sources: Array.from(new Set(e.srcs)) });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, 10);
}

async function afPredsFallback() {
  // 1) uzmi fixturеs
  const fixtures = await afFixturesTodayOrNext(40);

  // 2) izvuci predictions za svaku
  const raw = [];
  await Promise.all(
    fixtures.map(async (it) => {
      try {
        const fxId = it?.fixture?.id;
        const teams = it?.teams;
        if (!fxId || !teams?.home?.name || !teams?.away?.name) return;
        const matchName = `${teams.home.name} vs ${teams.away.name}`;

        const preds = await afPredictionsForFixture(fxId);
        if (!preds) return;

        // 1X2
        const pHome = pctToNumber(preds?.percent?.home);
        const pDraw = pctToNumber(preds?.percent?.draw);
        const pAway = pctToNumber(preds?.percent?.away);
        let best = null;
        if ([pHome, pDraw, pAway].some((x) => x != null)) {
          const entries = [
            { label: "1", v: pHome ?? -1 },
            { label: "X", v: pDraw ?? -1 },
            { label: "2", v: pAway ?? -1 },
          ].sort((a, b) => b.v - a.v);
          best = entries[0];
        }
        if (best && best.v >= 0) {
          raw.push({ match: matchName, market: "1X2", pick: best.label, odds: null, confidence: Math.round(best.v), source: "api-football" });
        }

        // BTTS
        const bttsWinner = preds?.advice?.toLowerCase().includes("btts") ? null : null; // AF često nema direktan procenat BTTS
        // Ako postoji strukturirani blok:
        if (preds?.both_to_score?.winner) {
          const key = String(preds.both_to_score.winner).toLowerCase(); // "yes"/"no"
          const pct = pctToNumber(preds?.both_to_score?.percentage?.[key]);
          raw.push({
            match: matchName,
            market: "BTTS",
            pick: key === "yes" ? "Yes" : "No",
            odds: null,
            confidence: pct != null ? Math.round(pct) : 0,
            source: "api-football",
          });
        }

        // HT/FT
        if (preds?.half_time_full_time?.winner) {
          const key = String(preds.half_time_full_time.winner).toUpperCase(); // "X/2" itd
          const pct = pctToNumber(preds?.half_time_full_time?.percentage?.[preds.half_time_full_time.winner]);
          raw.push({
            match: matchName,
            market: "HT/FT",
            pick: key,
            odds: null,
            confidence: pct != null ? Math.round(pct) : 0,
            source: "api-football",
          });
        }

        // 3) (opciono) pokušaj da pridružiš kvote ZA OVE fixture-e – batchevanje radi budžeta
        // Da bismo štedeli pozive, kvote će se dohvatiti u manjem broju kasnije (vidi dole).
      } catch (_) {}
    })
  );

  // 3) Rangiraj po confidence i skrati, pa tek onda probaj kvote za te top mečeve
  raw.sort((a, b) => b.confidence - a.confidence);
  const top = raw.slice(0, 12);

  // Pokušaj kvote iz /odds samo za top fixturеs (po imenu meča mapiranje)
  // Napomena: bez tačnog fixtureId mapiranje je nepouzdano; zato iznova iz fixtures-a vadimo odds po ID-u.
  const byMatch = Object.fromEntries(
    fixtures.map((it) => [ `${it?.teams?.home?.name} vs ${it?.teams?.away?.name}`, it?.fixture?.id ])
  );

  await Promise.all(
    top.map(async (t) => {
      try {
        const fxId = byMatch[t.match];
        if (!fxId) return;
        const odds = await afOddsForFixture(fxId);
        if (!odds) return;
        // upiši kvotu ako postoji za konkretan market/pick
        if (t.market === "1X2" && odds?.["1X2"]?.[t.pick] != null) t.odds = odds["1X2"][t.pick];
        if (t.market === "BTTS" && odds?.["BTTS"]?.[t.pick] != null) t.odds = odds["BTTS"][t.pick];
        if (t.market === "HT/FT" && odds?.["HT/FT"]?.[t.pick] != null) t.odds = odds["HT/FT"][t.pick];
      } catch (_) {}
    })
  );

  // Formatiraj za UI
  return top.map((t) => ({
    match: t.match,
    prediction: `${t.market}: ${t.pick}`,
    odds: t.odds ?? null,
    confidence: t.confidence || 0,
    sources: ["api-football"],
  }));
}

// ---- Handler

export default async function handler(req, res) {
  try {
    // 1) Skupi preds iz više izvora
    const [smList, afFallbackList] = await Promise.all([
      sportmonksPreds(),     // može biti prazan ako plan/limit
      (async () => {
        // AF preds za konsenzus građu (ne kao fallback lista!)
        const fixtures = await afFixturesTodayOrNext(30);
        const tmp = [];
        await Promise.all(
          fixtures.map(async (it) => {
            try {
              const fxId = it?.fixture?.id;
              const teams = it?.teams;
              if (!fxId || !teams?.home?.name || !teams?.away?.name) return;
              const matchName = `${teams.home.name} vs ${teams.away.name}`;
              const preds = await afPredictionsForFixture(fxId);
              if (!preds) return;

              // 1X2
              const pHome = pctToNumber(preds?.percent?.home);
              const pDraw = pctToNumber(preds?.percent?.draw);
              const pAway = pctToNumber(preds?.percent?.away);
              let best = null;
              if ([pHome, pDraw, pAway].some((x) => x != null)) {
                const entries = [
                  { label: "1", v: pHome ?? -1 },
                  { label: "X", v: pDraw ?? -1 },
                  { label: "2", v: pAway ?? -1 },
                ].sort((a, b) => b.v - a.v);
                best = entries[0];
              }
              if (best && best.v >= 0) {
                tmp.push({ match: matchName, market: "1X2", pick: best.label, odds: null, confidence: Math.round(best.v), source: "api-football" });
              }

              if (preds?.both_to_score?.winner) {
                const key = String(preds.both_to_score.winner).toLowerCase();
                const pct = pctToNumber(preds?.both_to_score?.percentage?.[key]);
                tmp.push({ match: matchName, market: "BTTS", pick: key === "yes" ? "Yes" : "No", odds: null, confidence: pct != null ? Math.round(pct) : 0, source: "api-football" });
              }

              if (preds?.half_time_full_time?.winner) {
                const key = String(preds.half_time_full_time.winner).toUpperCase();
                const pct = pctToNumber(preds?.half_time_full_time?.percentage?.[preds.half_time_full_time.winner]);
                tmp.push({ match: matchName, market: "HT/FT", pick: key, odds: null, confidence: pct != null ? Math.round(pct) : 0, source: "api-football" });
              }
            } catch (_) {}
          })
        );
        return tmp;
      })(),
    ]);

    // 2) Pokušaj KONSENZUS (AF + SM)
    const consensus = buildConsensus([...(smList || []), ...(afFallbackList || [])]);

    let footballTop;
    if (consensus && consensus.length > 0) {
      footballTop = consensus;
    } else {
      // 3) Ako konsenzus nema → robust AF fallback (top 12, pokušaj odds)
      footballTop = await afPredsFallback();
      if (!footballTop.length) {
        // Ako i to zakaže, vrati bar stub da UI ne bude prazan
        footballTop = [
          { match: "No consensus", prediction: "—", odds: null, confidence: 0, sources: ["stub"] },
        ];
      }
    }

    res.status(200).json({ footballTop, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error("Football API error:", err);
    res.status(200).json({
      footballTop: [
        { match: "Service temporary", prediction: "—", odds: null, confidence: 0, sources: ["stub"] },
      ],
      generated_at: new Date().toISOString(),
      _error: String(err?.message || err),
    });
  }
}
