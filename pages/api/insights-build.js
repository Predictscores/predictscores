// pages/api/insights-build.js
// Gradi/finalizuje tikete za dati slot i ZADRŽAVA ih “zamrznute” do sledećeg slota.
// Uvek cilja do **4** parа po tržištu (BTTS / OU2.5 / HT-FT), uz:
//   • max 2 meča po ligi  (UEFA do 6 ukupno u feedu – ostaje na rebuild-u)
//   • min kvota 1.5 (kada postoji kvota; koristi median iz refresh-odds)
// Ako nema dovoljno validnih parova, upisaće koliko postoji (ali cilj je 4).

export const config = { api: { bodyParser: false } };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();

const MIN_ODDS = 1.5;           // prag na median kvotu
const PER_LEAGUE_CAP = 2;       // max 2 meča po ligi u tiketu
const TARGET_PER_TICKET = 4;    // uvek ciljamo na 4

// --- Helpers: KV
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store"
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  try { return j && j.result ? JSON.parse(j.result) : null; } catch { return null; }
}
async function kvSet(key, val) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(val) })
  });
  return r.ok;
}

// --- Time utils
function nowInTZ() {
  const now = new Date();
  return new Date(now.toLocaleString("en-GB", { timeZone: TZ }));
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function slotFromQuery(q) {
  const s = (q.slot || "").toString().trim().toLowerCase();
  if (s === "am" || s === "pm" || s === "late") return s;
  const H = parseInt(new Date(nowInTZ()).getHours(), 10);
  if (H < 10) return "late";
  if (H < 15) return "am";
  return "pm";
}

// --- Scoring utils (robustno i jednostavno)
function safeConf(it) {
  const c = Number(it?.confidence_pct);
  return Number.isFinite(c) ? c : 50;
}
function leagueId(it) {
  return it?.league?.id ?? it?.league_id ?? "unknown";
}
function priceFrom(obj) {
  const p = Number(obj?.price);
  return Number.isFinite(p) ? p : null;
}
function passMinOdds(p) {
  return p == null ? true : p >= MIN_ODDS;
}

function pickTop(items, want, pickLeagueCap = PER_LEAGUE_CAP) {
  const byLg = new Map();
  const out = [];
  for (const it of items) {
    const lg = leagueId(it);
    const have = byLg.get(lg) || 0;
    if (have >= pickLeagueCap) continue;
    out.push(it);
    byLg.set(lg, have + 1);
    if (out.length >= want) break;
  }
  return out;
}

// Candidate builders
function bttsCandidates(list) {
  const cand = [];
  for (const it of list) {
    const m = it?.markets?.btts;
    const y = priceFrom(m?.Y);
    if (!passMinOdds(y)) continue;
    cand.push({
      fixture_id: it.fixture_id,
      league: it.league,
      teams: it.teams,
      pick: "Yes",
      pick_code: "Y",
      market: "BTTS",
      market_label: "BTTS",
      odds: { price: y, books_count: Number(m?.Y?.books_count || 0) },
      confidence_pct: safeConf(it),
      kickoff_utc: it.kickoff_utc
    });
  }
  // Rang: višI confidence, zatim veći books_count, zatim kvota
  cand.sort((a,b)=> (b.confidence_pct - a.confidence_pct)
                    || (b.odds.books_count - a.odds.books_count)
                    || (b.odds.price - a.odds.price));
  return cand;
}

function ou25Candidates(list) {
  const cand = [];
  for (const it of list) {
    const m = it?.markets?.ou25;
    const o = priceFrom(m?.over);
    if (!passMinOdds(o)) continue;
    cand.push({
      fixture_id: it.fixture_id,
      league: it.league,
      teams: it.teams,
      pick: "Over 2.5",
      pick_code: "O",
      market: "OU2.5",
      market_label: "O/U 2.5",
      odds: { price: o, books_count: Number(m?.over?.books_count || 0) },
      confidence_pct: safeConf(it),
      kickoff_utc: it.kickoff_utc
    });
  }
  cand.sort((a,b)=> (b.confidence_pct - a.confidence_pct)
                    || (b.odds.books_count - a.odds.books_count)
                    || (b.odds.price - a.odds.price));
  return cand;
}

function htftCandidates(list) {
  // Ako nema posebnog marketa, koristimo 1X2 pick_code kao naznaku (HT-FT "D-H" i sl. ne računamo bez podataka)
  // Zadržaćemo iste postojeće kriterijume (confidence + kvota ako postoji).
  const cand = [];
  for (const it of list) {
    // U nedostatku "HT-FT" kvota, uzećemo 1X2 sa min_odds
    const px = priceFrom(it?.odds);
    if (!passMinOdds(px)) continue;
    if (!it?.pick_code) continue;
    cand.push({
      fixture_id: it.fixture_id,
      league: it.league,
      teams: it.teams,
      pick: it.pick || it.selection_label || it.pick_code,
      pick_code: it.pick_code, // 1 / X / 2 (proxy)
      market: "HT-FT",
      market_label: "HT-FT",
      odds: { price: px, books_count: Number(it?.odds?.books_count || 0) },
      confidence_pct: safeConf(it),
      kickoff_utc: it.kickoff_utc
    });
  }
  cand.sort((a,b)=> (b.confidence_pct - a.confidence_pct)
                    || (b.odds.books_count - a.odds.books_count)
                    || (b.odds.price - a.odds.price));
  return cand;
}

export default async function handler(req, res) {
  try {
    const slot = slotFromQuery(req.query);
    const d = nowInTZ();
    const day = ymd(d);

    const keyFull = `vbl_full:${day}:${slot}`;
    const keyTickets = `tickets:${day}:${slot}`;

    const full = await kvGet(keyFull);
    if (!full || !Array.isArray(full.items)) {
      return res.status(200).json({ ok: true, ymd: day, slot, source: keyFull, counts: { btts: 0, ou25: 0, htft: 0 } });
    }

    // Kandidati iz full liste
    const base = full.items || [];

    const candBTTS = bttsCandidates(base);
    const candOU25 = ou25Candidates(base);
    const candHTFT = htftCandidates(base);

    const picksBTTS = pickTop(candBTTS, TARGET_PER_TICKET);
    const picksOU25 = pickTop(candOU25, TARGET_PER_TICKET);
    const picksHTFT = pickTop(candHTFT, TARGET_PER_TICKET);

    const tickets = { btts: picksBTTS, ou25: picksOU25, htft: picksHTFT };

    await kvSet(keyTickets, tickets);

    return res.status(200).json({
      ok: true,
      ymd: day,
      slot,
      source: keyFull,
      tickets_key: keyTickets,
      counts: {
        btts: picksBTTS.length,
        ou25: picksOU25.length,
        htft: picksHTFT.length
      }
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
