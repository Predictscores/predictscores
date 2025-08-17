// FILE: pages/api/value-bets.js
// Generator za value betove: 1X2 + BTTS + OU 2.5 + HT-FT
// Izvor: API-Football (predikcije + kvote)
// Minimalni trošak i zaštite (PASS_CAP, RUN_MAX, min bookies)
// Nema novih obaveznih ENV-ova (koristi tvoj postojeći API_FOOTBALL_KEY ili NEXT_PUBLIC_API_FOOTBALL_KEY)

export const config = { api: { bodyParser: false } };

// ---------- ENV / budžet ----------
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const PASS_CAP = Math.max(10, Math.min(120, Number(process.env.AF_PASS1_CAP || 50))); // koliko mečeva obrađujemo
const RUN_MAX = Math.max(50, Math.min(400, Number(process.env.AF_RUN_MAX_CALLS || 220))); // safety kočnica
const MIN_ODDS = Math.max(1.2, Number(process.env.VB_MIN_ODDS || 1.30)); // min kvota koju prihvatamo

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
    const v = parseFloat(x.replace("%","").trim());
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

// ---------- odds accumulator za 1X2 / BTTS / OU 2.5 / HT-FT ----------
function collectOdds(rows) {
  const acc = {
    "1X2": { "1": [], "X": [], "2": [] },
    "BTTS": { "Yes": [], "No": [] },
    "OU25": { "Over": [], "Under": [] },
    "HT/FT": {}
  };
  let booksUsed = new Set();

  for (const row of rows || []) {
    const books = row?.bookmakers || row?.bookmakers?.data || row?.bookmakers?.rows || [];
    for (const bk of books) {
      const bets = bk?.bets || bk?.bets?.data || bk?.bets?.rows || [];
      if (!bets || !bets.length) continue;
      booksUsed.add(safeStr(bk?.name || bk?.title || bk?.bookmaker_name));

      for (const bet of bets) {
        const name = safeStr(bet?.name).toLowerCase();

        // 1X2 (Match Winner)
        if (name.includes("1x2") || name.includes("match winner")) {
          for (const v of (bet?.values || [])) {
            const lbl = safeStr(v?.value).toUpperCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl === "1") acc["1X2"]["1"].push(odd);
            if (lbl === "X") acc["1X2"]["X"].push(odd);
            if (lbl === "2") acc["1X2"]["2"].push(odd);
          }
        }

        // BTTS
        if (name.includes("both teams to score") || name.includes("btts")) {
          for (const v of (bet?.values || [])) {
            const lbl = safeStr(v?.value).toLowerCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl.includes("yes")) acc["BTTS"]["Yes"].push(odd);
            if (lbl.includes("no"))  acc["BTTS"]["No"].push(odd);
          }
        }

        // Over/Under 2.5 (razni nazivi: over/under, totals, goals over/under)
        if (name.includes("over/under") || name.includes("totals") || name.includes("goals over") || name.includes("goals under")) {
          for (const v of (bet?.values || [])) {
            const lbl = safeStr(v?.value); const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || !lbl) continue;
            const l = lbl.toLowerCase();
            // uhvati 2.5 bez obzira na redosled "over 2.5" / "2.5 over"
            if (l.includes("over") && l.includes("2.5")) acc["OU25"]["Over"].push(odd);
            if (l.includes("under") && l.includes("2.5")) acc["OU25"]["Under"].push(odd);
          }
        }

        // HT/FT
        if (name.includes("half time/full time") || name.includes("ht/ft")) {
          for (const v of (bet?.values || [])) {
            const lbl = safeStr(v?.value).toUpperCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd) || !lbl) continue;
            (acc["HT/FT"][lbl] ||= []).push(odd);
          }
        }
      }
    }
  }

  const odds = {
    "1X2": { "1": median(acc["1X2"]["1"]), "X": median(acc["1X2"]["X"]), "2": median(acc["1X2"]["2"]) },
    "BTTS": { "Yes": median(acc["BTTS"]["Yes"]), "No": median(acc["BTTS"]["No"]) },
    "OU25": { "Over": median(acc["OU25"]["Over"]), "Under": median(acc["OU25"]["Under"]) },
    "HT/FT": {}
  };
  for (const k of Object.keys(acc["HT/FT"])) odds["HT/FT"][k] = median(acc["HT/FT"][k]);

  // grub estimator koliko različitih bukija je doprinelo
  const booksUsedEstimate = Math.max(0, booksUsed.size);
  return { odds, booksUsedEstimate };
}

// ---------- main ----------
export default async function handler(req, res) {
  try {
    const now = belgradeNow();
    const horizonMs = 16 * 3600 * 1000; // gledamo ~16h unapred
    const endMs = now.getTime() + horizonMs;

    // 1) skupi fixtures (juče/danas/sutra) i filtriraj po prozoru
    const dNow  = ymdTZ(now);
    const dPrev = ymdTZ(new Date(now.getTime() - 24*3600*1000));
    const dNext = ymdTZ(new Date(now.getTime() + 24*3600*1000));
    const days = [dPrev, dNow, dNext];

    let fixtures = [];
    let calls = 0;
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
    // stabilno sortiraj da PASS_CAP bude deterministično
    fixtures.sort((a,b)=> safeStr(a?.league?.name).localeCompare(safeStr(b?.league?.name)));

    // 2) po meču: predictions + odds (1X2 + BTTS + OU25 + HT-FT)
    const hour = Number(hmNow().split(":")[0] || 0);
    const minBookies = (hour >= 10 && hour <= 21) ? 4 : 3;

    const picks = [];
    for (const f of fixtures.slice(0, PASS_CAP)) {
      if (calls >= RUN_MAX) break;

      // predictions (po meču)
      const predsArr = await afGet(`/predictions?fixture=${f.fixture_id}`); calls++;
      const r = predsArr && predsArr[0] ? predsArr[0] : null;
      if (!r) continue;

      // mapiraj 1X2 procente
      const p1 = parsePct(r?.percent?.home);
      const px = parsePct(r?.percent?.draw);
      const p2 = parsePct(r?.percent?.away);
      const tot = [p1, px, p2].filter(Number.isFinite).reduce((a,b)=>a+b,0) || 0;
      const norm = (x)=> Number.isFinite(x) && tot>0 ? x/tot : null;
      const map1x2 = { "1": norm(p1), "X": norm(px), "2": norm(p2) };

      // odds (medijani po marketu)
      const oddsResp = await afGet(`/odds?fixture=${f.fixture_id}`); calls++;
      const { odds, booksUsedEstimate } = collectOdds(oddsResp);
      if (booksUsedEstimate < minBookies) continue;

      // helper za dodavanje jednog pick-a
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

      // 1) 1X2: selekcija sa najvećom verovatnoćom
      const sel1x2 = Object.keys(map1x2).sort((a,b)=> (map1x2[b]||0)-(map1x2[a]||0))[0];
      const odds1x2 = sel1x2==="1"?odds["1X2"]["1"]:sel1x2==="2"?odds["1X2"]["2"]:odds["1X2"]["X"];
      pushPick("1X2", sel1x2, map1x2[sel1x2] || null, odds1x2);

      // 2) BTTS (Yes/No)
      const pBTTSyes = parsePct(r?.both_teams_to_score?.yes);
      const pBTTSno  = parsePct(r?.both_teams_to_score?.no);
      const selBTTS  = (pBTTSyes ?? 0) >= (pBTTSno ?? 0) ? "Yes" : "No";
      const probBTTS = selBTTS==="Yes" ? pBTTSyes : pBTTSno;
      pushPick("BTTS", selBTTS, probBTTS, odds["BTTS"]?.[selBTTS]);

      // 3) Over/Under 2.5 (koristimo p(over_2_5); p(under) = 1 - p(over))
      const pO25 = parsePct(r?.goals?.over_2_5);
      if (Number.isFinite(pO25)) {
        const pU25 = clamp(1 - pO25, 0, 1);
        const selOU = (pO25 >= 0.5) ? "Over" : "Under";
        const probOU = selOU === "Over" ? pO25 : pU25;
        const o = odds["OU25"]?.[selOU] ?? null;
        pushPick("OU 2.5", selOU, probOU, o);
      }

      // 4) HT-FT (ako postoji prognoza) – kvote iz HT/FT odds-a
      const htft = r?.half_time_full_time?.winner;
      if (htft) {
        const sel = safeStr(htft).toUpperCase(); // npr. "X/1"
        const p = parsePct(r?.half_time_full_time?.percentage?.[htft]);
        const o = odds["HT/FT"]?.[sel] ?? null;
        pushPick("HT-FT", sel, p, o);
      }

      if (picks.length > PASS_CAP * 4) break; // 4 tržišta po meču maksimalno
      if (calls >= RUN_MAX) break;
    }

    // sort: prvo veći EV, pa veći confidence, pa raniji kickoff
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
      calls_used: clamp(RUN_MAX, 0, RUN_MAX)
    });
  } catch (e) {
    return res.status(200).json({ value_bets: [], _error: maskErr(e) });
  }
}
