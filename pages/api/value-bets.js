// FILE: pages/api/value-bets.js
export const config = { api: { bodyParser: false } };

// ---------- ENV / budget ----------
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const PASS_CAP = Math.max(10, Math.min(120, Number(process.env.AF_PASS1_CAP || 50)));      // koliko mečeva obrađujemo u prvom prolazu
const RUN_MAX = Math.max(50, Math.min(400, Number(process.env.AF_RUN_MAX_CALLS || 220)));  // safety kočnica
const MIN_ODDS = Math.max(1.2, Number(process.env.VB_MIN_ODDS || 1.30));                   // min kvota
const MAX_PER_FIX_MARKETS = 4; // 1X2, BTTS, Over 2.5, HT-FT

// ---------- helpers ----------
function hmNow() {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(new Date());
}
function beogradYMD(d = new Date()) {
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
  if (typeof x === "number") return x>1 ? x/100 : x;
  return null;
}
function cap(n, a, b){ return Math.max(a, Math.min(b, n)); }

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

// ---------- odds accumulator for 1X2/BTTS/HT-FT ----------
function collectOdds(rows) {
  const acc = { "1X2": { "1": [], "X": [], "2": [] }, "BTTS": { "Yes": [], "No": [] }, "HT/FT": {} };
  for (const row of rows || []) {
    const books = row?.bookmakers || [];
    for (const bm of books) {
      for (const bet of (bm?.bets||[])) {
        const name = String(bet?.name||"").toLowerCase();

        // 1X2
        if (name.includes("match winner") || name.includes("1x2") || name.includes("full time result")) {
          for (const v of (bet?.values||[])) {
            const lbl = String(v?.value||"").toUpperCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl==="HOME"||lbl==="1") acc["1X2"]["1"].push(odd);
            if (lbl==="DRAW"||lbl==="X") acc["1X2"]["X"].push(odd);
            if (lbl==="AWAY"||lbl==="2") acc["1X2"]["2"].push(odd);
          }
        }

        // BTTS
        if (name.includes("both teams to score") || name.includes("btts")) {
          for (const v of (bet?.values||[])) {
            const lbl = String(v?.value||"").toLowerCase(); const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl.includes("yes")) acc["BTTS"]["Yes"].push(odd);
            if (lbl.includes("no"))  acc["BTTS"]["No"].push(odd);
          }
        }

        // HT/FT
        if (name.includes("half time/full time") || name.includes("ht/ft")) {
          for (const v of (bet?.values||[])) {
            const lbl = String(v?.value||"").toUpperCase(); const odd = Number(v?.odd);
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
    "HT/FT": {}
  };
  for (const k of Object.keys(acc["HT/FT"])) odds["HT/FT"][k] = median(acc["HT/FT"][k]);
  return { odds, booksUsedEstimate: (rows?.[0]?.bookmakers||[]).length || 0 };
}

// ---------- main ----------
export default async function handler(req, res) {
  try {
    const now = belgradeNow();
    const horizonMs = 16 * 3600 * 1000; // gledamo ~16h unapred
    const endMs = now.getTime() + horizonMs;

    // 1) skupi fixtures (juče/danas/sutra) i filtriraj po prozoru
    const dNow  = beogradYMD(now);
    const dPrev = beogradYMD(new Date(now.getTime()-24*3600*1000));
    const dNext = beogradYMD(new Date(now.getTime()+24*3600*1000));
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
    // stabilno sortiranje da bi PASS_CAP bilo deterministično
    fixtures.sort((a,b)=> String(a?.league?.name||"").localeCompare(String(b?.league?.name||"")));

    // 2) po meču: predictions + odds (1X2 + BTTS + O2.5 + HT-FT)
    const hour = Number(hmNow().split(":")[0] || 0);
    const minBookies = (hour>=10 && hour<=21) ? 4 : 3;

    const picks = [];
    for (const f of fixtures.slice(0, PASS_CAP)) {
      if (calls >= RUN_MAX) break;

      // predictions
      const pr = await afGet(`/predictions?fixture=${f.fixture_id}`); calls++;
      const r = pr?.[0]?.predictions || pr?.[0] || {};
      const p1 = parsePct(r?.percent?.home);
      const px = parsePct(r?.percent?.draw);
      const p2 = parsePct(r?.percent?.away);
      const tot = [p1,px,p2].filter(Number.isFinite).reduce((a,b)=>a+b,0) || 0;
      const norm = (x)=> Number.isFinite(x) && tot>0 ? x/tot : null;
      const map1x2 = { "1": norm(p1), "X": norm(px), "2": norm(p2) };

      // odds (samo fixture-level; posle računamo medijane per market)
      const oddsResp = await afGet(`/odds?fixture=${f.fixture_id}`); calls++;
      const { odds, booksUsedEstimate } = collectOdds(oddsResp);
      if (booksUsedEstimate < minBookies) continue;

      // helper za dodavanje jednog pick-a
      const pushPick = (market, selection, prob, marketOdds) => {
        if (!Number.isFinite(prob) || prob <= 0) return;
        if (!Number.isFinite(marketOdds) || marketOdds < MIN_ODDS) return;
        const implied = 1/marketOdds;
        const ev = marketOdds*prob - 1;
        const edge_pp = (prob - implied)*100;
        picks.push({
          fixture_id: f.fixture_id, teams: f.teams, league: f.league,
          datetime_local: f.datetime_local,
          market, market_label: market,
          selection,
          type: "MODEL+ODDS",
          model_prob: prob,
          market_odds: marketOdds,
          implied_prob: implied,
          edge: Number.isFinite(ev)?ev:null,
          edge_pp: Math.round(edge_pp*10)/10,
          ev,
          movement_pct: 0,
          confidence_pct: Math.round(prob*100),
          bookmakers_count: booksUsedEstimate,
          explain: { summary: `Model ${Math.round(prob*100)}% vs ${Math.round(implied*100)}% · EV ${Math.round(ev*1000)/10}% · Bookies ${booksUsedEstimate}`, bullets: [] }
        });
      };

      // 1) 1X2: uzmi selekciju sa najvećom verovatnoćom
      const sel1x2 = Object.keys(map1x2).sort((a,b)=> (map1x2[b]||0)-(map1x2[a]||0))[0];
      const odds1x2 = sel1x2==="1"?odds["1X2"]["1"]:sel1x2==="2"?odds["1X2"]["2"]:odds["1X2"]["X"];
      pushPick("1X2", sel1x2, map1x2[sel1x2]||null, odds1x2);

      // 2) BTTS (Yes/No) ako predictions ima
      const pBTTSyes = parsePct(r?.both_teams_to_score?.yes);
      const pBTTSno  = parsePct(r?.both_teams_to_score?.no);
      const selBTTS  = (pBTTSyes||0) >= (pBTTSno||0) ? "Yes" : "No";
      const probBTTS = selBTTS==="Yes" ? pBTTSyes : pBTTSno;
      pushPick("BTTS", selBTTS, probBTTS, odds["BTTS"][selBTTS]);

      // 3) Over 2.5 (ako postoji procent)
      const pO25 = parsePct(r?.goals?.over_2_5);
      // kreiramo kvotu iz 1X2? Ne — uzimamo BTTS/Odds feed; mnogi bookovi drže OU u istom objektu, ali nije uvek prisutno.
      // Ako nema, preskačemo.
      const oOver25 = null; // nemamo direktno iz /odds-a stabilno; zadrži samo 1X2/BTTS/HT-FT za sada.

      // 4) HT-FT (ako postoji prognoza) – kvote iz HT/FT odds-a
      const htft = r?.half_time_full_time?.winner;
      if (htft) {
        const sel = String(htft).toUpperCase(); // npr. "X/1"
        const o = odds["HT/FT"]?.[sel] ?? null;
        const p = parsePct(r?.half_time_full_time?.percentage?.[htft]);
        pushPick("HT-FT", sel, p, o);
      }

      // safety: nemoj više od X marketa po meču (da ne preplavimo listu)
      if (picks.length > PASS_CAP * MAX_PER_FIX_MARKETS) break;
    }

    // sort: MODEL+ODDS first je već jedini tip; pa Confidence->EV
    picks.sort((a,b) => {
      const ca = Number(a.confidence_pct||0), cb = Number(b.confidence_pct||0);
      if (cb !== ca) return cb - ca;
      const eva = Number.isFinite(a.ev)?a.ev:-Infinity, evb = Number.isFinite(b.ev)?b.ev:-Infinity;
      return evb - eva;
    });

    return res.status(200).json({
      value_bets: picks,
      generated_at: new Date().toISOString(),
      calls_used: cap(RUN_MAX, 0, RUN_MAX) // samo info
    });
  } catch (e) {
    return res.status(200).json({ value_bets: [], _error: String(e && e.message || e) });
  }
}
