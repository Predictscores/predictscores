// FILE: hooks/useValueBets.js
import { useEffect, useRef, useState } from "react";

/**
 * useValueBets with FALLBACK
 * 1) Pokuša /api/value-bets (unlocked, može nekad vratiti [])
 * 2) Ako je prazno/greška -> fallback na /api/football
 * 3) Rezultat (bilo koji) kesira 10 min u localStorage
 * Vraća: { bets, loading, error }
 */

const LS_TTL_MS = 10 * 60 * 1000; // 10 min

function sortValueBets(bets = []) {
  return bets
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
      const eA = a.edge ?? 0;
      const eB = b.edge ?? 0;
      if (eB !== eA) return eB - eA;
      return (b.model_prob ?? 0) - (a.model_prob ?? 0);
    });
}

function mapFootballToBets(arr = []) {
  // /api/football: [{ match, prediction: "1X2: X", odds, confidence, sources }]
  return arr.map((it, idx) => {
    const [home, away] = String(it.match || "").split(" vs ");
    const pred = String(it.prediction || "");
    const [market = "", selection = ""] = pred.split(":").map(s => s.trim());
    const oddsNum = Number(it.odds);
    const marketLabel =
      market === "OU2.5" ? "Over 2.5" : market; // sitna kozmetika

    return {
      fixture_id: `fb-${idx}-${home || "?"}-${away || "?"}`,
      teams: {
        home: { id: null, name: home || "Home" },
        away: { id: null, name: away || "Away" },
      },
      league: { id: null, name: "—", country: null, season: null },
      datetime_local: { starting_at: { date_time: null } }, // nema kickoff-a u tom endpointu
      market: market || "1X2",
      market_label: marketLabel || "1X2",
      selection: selection || "",
      type: "CONSENSUS",
      model_prob: null,
      market_odds: Number.isFinite(oddsNum) ? oddsNum : null,
      implied_prob: Number.isFinite(oddsNum) ? 1 / oddsNum : null,
      edge: null,
      edge_pp: null,
      ev: null,
      movement_pct: 0,
      confidence_pct: Number.isFinite(it.confidence) ? it.confidence : null,
      confidence_bucket: null,
      _score: Number.isFinite(it.confidence) ? it.confidence : 0,
      form_score: null,
      bookmakers_count: 0,
      explain: {
        summary: `Consensus ${pred} ${Number.isFinite(oddsNum) ? `@ ${oddsNum}` : ""}`.trim(),
        bullets: [],
      },
    };
  });
}

export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    const cacheKey = `vb_or_fb_${date || "today"}`;
    const now = Date.now();

    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (cached && now - cached.ts < LS_TTL_MS && Array.isArray(cached.data)) {
          setBets(cached.data);
          setLoading(false);
          return;
        }
      }
    } catch {}

    setLoading(true);
    setError(null);

    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    (async () => {
      try {
        // 1) pokušaj value-bets
        const res = await fetch("/api/value-bets", { cache: "default", signal: ac.signal });
        if (!res.ok) throw new Error(`/api/value-bets -> ${res.status}`);
        const j = await res.json();
        const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

        if (arr.length > 0) {
          const sorted = sortValueBets(arr);
          setBets(sorted);
          try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: sorted })); } catch {}
          return;
        }

        // 2) fallback na /api/football
        const fbRes = await fetch("/api/football", { cache: "no-store", signal: ac.signal });
        if (!fbRes.ok) throw new Error(`/api/football -> ${fbRes.status}`);
        const fbJson = await fbRes.json();
        const fbArr = Array.isArray(fbJson?.footballTop) ? fbJson.footballTop : [];
        const mapped = mapFootballToBets(fbArr);
        setBets(mapped);
        try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: mapped })); } catch {}
      } catch (e) {
        if (e.name !== "AbortError") {
          setError(e.message || String(e));
          setBets([]);
        }
      } finally {
        setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [date]);

  return { bets, loading, error };
}
