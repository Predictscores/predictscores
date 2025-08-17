// FILE: pages/api/value-bets.js
// Generator: 1X2 + BTTS + OU 2.5 + HT-FT
// Patch: prihvata i 1 bukija (ranije ≥4), stabilniji parsing, realni calls_used.

export const config = { api: { bodyParser: false } };

// ---------- ENV / budžet ----------
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const PASS_CAP = Math.max(10, Math.min(120, Number(process.env.AF_PASS1_CAP || 40))); // koliko mečeva obrađujemo
const RUN_MAX = Math.max(60, Math.min(400, Number(process.env.AF_RUN_MAX_CALLS || 300))); // safety kočnica
const MIN_ODDS = Math.max(1.2, Number(process.env.VB_MIN_ODDS || 1.25)); // min kvota koju prihvatamo

// minimalan broj bukija (PATCH: 1 dovoljno)
const MIN_BOOKIES_REQUIRED = 1;

// ---------- helpers ----------
function hmNow() {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(new Date());
}
function ymdTZ(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function belgradeNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: TZ })); }
function median(arr){ return arr && arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)] : null; }
function parsePct(x) {
  if (x == null) return null;
  if (typeof x === "string") {
    const v = parseFloat(String(x).replace("%","").trim());
    return Number.isFinite(v) ? v/100 : null;
  }
  if (typeof x === "number") return x > 1 ? x/100 : x;
  return null;
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function safeStr(x){ try { return String(x ?? ""); } catch { return ""; } }
function maskErr(e){ try { return String(e?.message || e); } catch { return "unknown"; } }

// ---------- API-Football helper ----------
async function afGet(path) {
  const key =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2;

  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": key }
  });
  if (!r.ok) throw new Error(`AF ${path} -> ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

// ---------- odds accumulator (1X2 / BTTS / OU 2.5 / HT-FT) ----------
function collectOdds(rows) {
  const acc = {
    "1X2": { "1": [], "X": [], "2": [] },
    "BTTS": { "Yes": [], "No": [] },
    "OU25": { "Over": [], "Under": [] },
    "HT/FT": {}
  };
  const booksUsed = new Set();

  for (const row of rows || []) {
    const books = row?.bookmakers || [];
    for (const bm of books) {
      const bkName = safeStr(bm?.name || bm?.title || bm?.bookmaker_name || bm?.id);
      const bets = bm?.bets || [];
      let contributed = false;

      for (const bet of bets) {
        const name = safeStr(bet?.name).toLowerCase();

        // 1X2 (Match Winner / Full Time Result)
        if (name.includes("match winner") || name.includes("1x2") || name.includes("full time result")) {
          for (const v of (bet?.values||[])) {
            const lbl = safeStr(v?.value).toUpperCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl === "HOME" || lbl === "1") acc["1X2"]["1"].push(odd), (contributed = true);
            if (lbl === "DRAW" || lbl === "X") acc["1X2"]["X"].push(odd), (contributed = true);
            if (lbl === "AWAY" || lbl === "2") acc["1X2"]["2"].push(odd), (contributed = true);
          }
        }

        // BTTS
        if (name.includes("both teams to score") || name.includes("btts")) {
          for (const v of (bet?.values||[])) {
            const lbl = safeStr(v?.value).toLowerCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl.includes("yes")) acc["BTTS"]["Yes"].push(odd), (contributed = true);
            if (lbl.includes("no"))  acc["BTTS"]["No"].push(odd),  (contributed = true);
          }
        }

        // Over/Under 2.5 (razni nazivi: over/under, totals, goals over/under)
        if (name.includes("over/under") || name.includes("totals") || name.includes("goals over") || name.includes("goals under")) {
          for (const v of (bet?.values || [])) {
            const lbl = safeStr(v?.value); const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || !lbl) continue;
            const l = lbl.toLowerCase();
            if (l.includes("over") && l.includes("2.5")) acc["OU25"]["Over"].push(odd), (contributed = true);
            if (l.includes("under") && l.includes("2.5")) acc["OU25"]["Under"].push(odd), (contributed = true);
          }
        }

        // HT/FT
        if (name.includes("half time/full time") || name.includes("ht/ft")) {
          for (const v of (bet?.values||[])) {
            const lbl = safeStr(v?.value).toUpperCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || !lbl) continue;
            (acc["HT/FT"][lbl] ||= []).push(odd); contributed = true;
          }
        }
      }

      if (contributed) booksUsed.add(bkName || `bk:${booksUsed.size+1}`);
    }
  }

  const odds = {
    "1X2": { "1": median(acc["1X2"]["1"]), "X": median(acc["1X2"]["X"]), "2": median(acc["1X2"]["2"]) },
    "BTTS": { "Yes": median(acc["BTTS"]["Yes"]), "No": median(acc["BTTS"]["No"]) },
    "OU25": { "Over": median(acc["OU25"]["Over"]), "Under": median(acc["OU25"]["Under"]) },
    "HT/FT": {}
  };
  for (const k of Object.keys(acc["HT/FT"])) odds["HT/FT"][k] = median(acc["HT/FT"][k]);

  return { odds, booksUsedEstimate: booksUsed.size };
}

// ---------- main ----------
export default async function handler(req, res) {
  let calls = 0;
  try {
    const now = belgradeNow();
    const horizonMs = 16 * 3600 * 1000; // ~16h unapred
    const endMs = now.getTime() + horizonMs;

    // 1) fixtures juče/danas/sutra, pa prozor
    const dNow  = ymdTZ(now);
    const dPrev = ymdTZ(new Date(now.getTime() - 24*3600*1000));
    const dNext = ymdTZ(new Date(now.getTime() + 24*3600*1000));
    const days = [dPrev, dNow, dNext];

    let fixtures = [];
    for (const ymd of days) {
      if (calls >= RUN_MAX) break;
      const arr = await afGet(`/fixtures?date=${ymd}`); calls++;
      for (const f of arr) {
        const t = new Date(f?.fixture?.date).getTime();
        if (!Number.isFinite(t)) continue;
        if (t > now.getTime() && t <= endMs) {
          fixtures.push({
            fixture_id: Number(f?.fixture?.id),
            league: { id:f?.league?.id, name:f?.league?.name, country:f?.league?.country, season:f?.league?.season },
            teams: { home:{ id:f?.teams?.home?.id, name:f?.teams?.home?.name }, away:{ id:f?.teams?.away?.id, name:f?.teams?.away?.name } },
            datetime_local: { starting_at: { date_time: f?.fixture?.date } }
          });
        }
      }
    }
    fixtures.sort((a,b)=> safeStr(a?.league?.name).localeCompare(safeStr(b?.league?.name)));

    const picks = [];
    for (const f of fixtures.slice(0, PASS_CAP)) {
      if (calls >= RUN_MAX) break;

      // predictions
      const prArr = await afGet(`/predictions?fixture=${f.fixture_id}`); calls++;
      const r0 = prArr && prArr[0] ? prArr[0] : null;
      const r = r0?.predictions || r0 || {};

      // 1X2 procenti
      const p1 = parsePct(r?.percent?.home);
      const px = parsePct(r?.percent?.draw);
      const p2 = parsePct(r?.percent?.away);
      const tot = [p1, px, p2].filter(Number.isFinite).reduce((a,b)=>a+b,0) || 0;
      const norm = (x)=> Number.isFinite(x) && tot>0 ? x/tot : null;
      const map1x2 = { "1": norm(p1), "X": norm(px), "2": norm(p2) };

      // odds
      const oddsResp = await afGet(`/odds?fixture=${f.fixture_id}`); calls++;
      const { odds, booksUsedEstimate } = collectOdds(oddsResp);

      // PATCH: prihvati i 1 bukija; ako nema nijednog ⇒ preskoči meč
      if (!Number.isFinite(booksUsedEstimate) || booksUsedEstimate < MIN_BOOKIES_REQUIRED) continue;

      // helper
      const pushPick = (market, selection, prob, marketOdds) => {
        if (!Number.isFinite(prob) || prob <= 0) return;
        if (!Number.isFinite(marketOdds) || marketOdds < MIN_ODDS) return;
        const implied = 1 / marketOdds;
        const ev = marketOdds * prob - 1;
        const edge_pp = (prob - implied) * 100;
        picks.push({
          fixture_id: f.fixture_id,
          teams: f.teams,
          league: f.league,
          datetime_local: f.datetime_local,
          market,
          market_label: market,
          selection,
          type: "MODEL+ODDS",
          model_prob: prob,
          market_odds: marketOdds,
          implied_prob: implied,
          edge: Number.isFinite(ev) ? ev : null,
          edge_pp: Math.round(edge_pp * 10) / 10,
          ev,
          movement_pct: 0,
          confidence_pct: Math.round(prob * 100),
          bookmakers_count: booksUsedEstimate,
          explain: { summary: `Model ${Math.round(prob*100)}% vs ${Math.round(implied*100)}% · EV ${Math.round(ev*1000)/10}% · Bookies ${booksUsedEstimate}`, bullets: [] }
        });
      };

      // 1) 1X2: uzmi najverovatniju selekciju
      const sel1x2 = Object.keys(map1x2).sort((a,b)=> (map1x2[b]||0)-(map1x2[a]||0))[0];
      const odds1x2 = sel1x2==="1"?odds["1X2"]["1"]:sel1x2==="2"?odds["1X2"]["2"]:odds["1X2"]["X"];
      pushPick("1X2", sel1x2, map1x2[sel1x2] || null, odds1x2);

      // 2) BTTS (Yes/No)
      const pBTTSyes = parsePct(r?.both_teams_to_score?.yes);
      const pBTTSno  = parsePct(r?.both_teams_to_score?.no);
      if (Number.isFinite(pBTTSyes) || Number.isFinite(pBTTSno)) {
        const selBTTS  = (pBTTSyes ?? 0) >= (pBTTSno ?? 0) ? "Yes" : "No";
        const probBTTS = selBTTS==="Yes" ? pBTTSyes : pBTTSno;
        const oBTTS = odds["BTTS"]?.[selBTTS] ?? null;
        pushPick("BTTS", selBTTS, probBTTS, oBTTS);
      }

      // 3) Over/Under 2.5
      const pO25 = parsePct(r?.goals?.over_2_5);
      if (Number.isFinite(pO25)) {
        const pU25 = clamp(1 - pO25, 0, 1);
        const selOU = (pO25 >= 0.5) ? "Over" : "Under";
        const probOU = selOU === "Over" ? pO25 : pU25;
        const oOU = odds["OU25"]?.[selOU] ?? null;
        pushPick("OU 2.5", selOU, probOU, oOU);
      }

      // 4) HT-FT (ako postoji prognoza)
      const htftKey = safeStr(r?.half_time_full_time?.winner).toUpperCase(); // npr. "X/1"
      const htftPctObj = r?.half_time_full_time?.percentage || r?.half_time_full_time || {};
      const pHTFT = parsePct(htftPctObj?.[htftKey]);
      if (htftKey && Number.isFinite(pHTFT)) {
        const oHF = odds["HT/FT"]?.[htftKey] ?? null;
        pushPick("HT-FT", htftKey, pHTFT, oHF);
      }

      if (picks.length > PASS_CAP * 6) break; // safety
    }

    // sort: EV desc, pa confidence, pa kickoff
    picks.sort((a,b) => {
      const eva = Number.isFinite(a.ev) ? a.ev : -Infinity;
      const evb = Number.isFinite(b.ev) ? b.ev : -Infinity;
      if (evb !== eva) return evb - eva;
      const ca = Number(a.confidence_pct || 0), cb = Number(b.confidence_pct || 0);
      if (cb !== ca) return cb - ca;
      const da = safeStr(a?.datetime_local?.starting_at?.date_time);
      const db = safeStr(b?.datetime_local?.starting_at?.date_time);
      return da.localeCompare(db);
    });

    return res.status(200).json({
      value_bets: picks,
      generated_at: new Date().toISOString(),
      calls_used: calls
    });
  } catch (e) {
    return res.status(200).json({ value_bets: [], _error: maskErr(e), calls_used: calls });
  }
}
