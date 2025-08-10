// FILE: contexts/DataContext.js
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

export const DataContext = createContext(null); // <— važno: named export!
export const useData = () => useContext(DataContext);

// helpers
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const toNum = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const pct = (x) => clamp(Math.round(x * 100), 0, 100);
const fmtRel = (ms) => {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};
const toUTCDate = (s) => {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return isNaN(d) ? null : d;
};

function confidenceBucket(p) {
  if (p >= 90) return "Top";
  if (p >= 75) return "High";
  if (p >= 50) return "Moderate";
  return "Low";
}

const flag = (countryName) => {
  if (!countryName) return "";
  const map = {
    Japan: "🇯🇵",
    Germany: "🇩🇪",
    "South Korea": "🇰🇷",
    USA: "🇺🇸",
    England: "🏴",
    Scotland: "🏴",
    Spain: "🇪🇸",
    Italy: "🇮🇹",
    France: "🇫🇷",
    Norway: "🇳🇴",
    Sweden: "🇸🇪",
    Denmark: "🇩🇰",
    "Faroe-Islands": "🇫🇴",
    Iceland: "🇮🇸",
    Poland: "🇵🇱",
    Hungary: "🇭🇺",
    Estonia: "🇪🇪",
  };
  return map[countryName] || "";
};

export function DataProvider({ children }) {
  const [crypto, setCrypto] = useState([]);
  const [football, setFootball] = useState([]);
  const [loading, setLoading] = useState({ crypto: false, football: false });
  const [errors, setErrors] = useState({ crypto: null, football: null });

  const [cryptoNextRefreshAt, setCryptoNextRefreshAt] = useState(null);
  const [footballLastGeneratedAt, setFootballLastGeneratedAt] = useState(null);
  const [footballNextKickoffAt, setFootballNextKickoffAt] = useState(null);
  const tick = useRef(0);

  async function fetchCrypto() {
    try {
      setLoading((s) => ({ ...s, crypto: true }));
      setErrors((e) => ({ ...e, crypto: null }));
      const r = await fetch("/api/crypto", { cache: "no-store" });
      const j = await r.json();
      const list = Array.isArray(j?.crypto) ? j.crypto : [];

      const mapped = list.map((x) => {
        const em = toNum(x.expectedMove, 0);
        const rawC = toNum(x.confidence, 0);
        let confidencePct =
          rawC <= 1 ? Math.round(rawC * 100)
          : rawC <= 100 ? Math.round(rawC)
          : Math.round(50 + em * 20);
        confidencePct = clamp(confidencePct, 1, 99);
        return {
          symbol: x.symbol,
          price: toNum(x.price, 0),
          entryPrice: toNum(x.entryPrice, x.price),
          sl: toNum(x.sl, null),
          tp: toNum(x.tp, null),
          expectedMove: em,
          change1h: toNum(x.change1h, 0),
          change24h: toNum(x.change24h, 0),
          signal: x.signal || "LONG",
          confidencePct,
          confidenceBucket: confidenceBucket(confidencePct),
        };
      });

      mapped.sort((a, b) => (b.expectedMove - a.expectedMove) || (b.confidencePct - a.confidencePct));
      setCrypto(mapped);
      setCryptoNextRefreshAt(Date.now() + 10 * 60 * 1000);
    } catch (e) {
      setErrors((er) => ({ ...er, crypto: e?.message || String(e) }));
    } finally {
      setLoading((s) => ({ ...s, crypto: false }));
    }
  }

  async function fetchFootball() {
    try {
      setLoading((s) => ({ ...s, football: true }));
      setErrors((e) => ({ ...e, football: null }));
      const r = await fetch("/api/value-bets", { cache: "no-store" });
      const j = await r.json();
      const vb = Array.isArray(j?.value_bets) ? j.value_bets : [];

      const mapped = vb.map((p) => {
        const confPct = toNum(p.confidence_pct, NaN);
        const modelPct = pct(toNum(p.model_prob, 0));
        const confidencePct = Number.isNaN(confPct) ? modelPct : clamp(Math.round(confPct), 0, 100);
        const startStr = p?.datetime_local?.starting_at?.date_time || p?.datetime_local?.date_time || null;
        const startUtc = toUTCDate(startStr);
        return {
          id: p.fixture_id,
          market: p.market || "1X2",
          selection: String(p.selection || "").toUpperCase(),
          type: p.type || "MODEL",
          modelPct,
          confidencePct,
          confidenceBucket: confidenceBucket(confidencePct),
          marketOdds: toNum(p.market_odds, null),
          league: {
            id: p?.league?.id ?? null,
            name: p?.league?.name ?? "",
            country: p?.league?.country ?? null,
          },
          teams: {
            home: { name: p?.teams?.home?.name || "" },
            away: { name: p?.teams?.away?.name || "" },
          },
          startUtc,
          startIso: startStr || "",
          _score: toNum(p?._score, confidencePct),
          _flag: flag(p?.league?.country),
        };
      });

      mapped.sort((a, b) => b._score - a._score);
      setFootball(mapped);
      setFootballLastGeneratedAt(Date.now());

      const now = Date.now();
      const next = mapped
        .map((x) => x.startUtc?.getTime())
        .filter((t) => Number.isFinite(t) && t > now)
        .sort((a, b) => a - b)[0];
      setFootballNextKickoffAt(next || null);
    } catch (e) {
      setErrors((er) => ({ ...er, football: e?.message || String(e) }));
      setFootball([]);
    } finally {
      setLoading((s) => ({ ...s, football: false }));
    }
  }

  useEffect(() => {
    fetchCrypto();
    fetchFootball();
    const t = setInterval(() => { tick.current = Date.now(); }, 1000);
    const cryptoInt = setInterval(fetchCrypto, 10 * 60 * 1000);
    const footInt = setInterval(fetchFootball, 15 * 60 * 1000);
    return () => { clearInterval(t); clearInterval(cryptoInt); clearInterval(footInt); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cryptoNextRefreshLabel = useMemo(() => {
    if (!cryptoNextRefreshAt) return "—";
    return fmtRel(cryptoNextRefreshAt - Date.now());
  }, [tick.current, cryptoNextRefreshAt]);

  const footballLastGeneratedLabel = useMemo(() => {
    if (!footballLastGeneratedAt) return "—";
    const delta = Date.now() - footballLastGeneratedAt;
    const m = Math.floor(delta / 60000);
    return m <= 0 ? "just now" : `${m}m ago`;
  }, [tick.current, footballLastGeneratedAt]);

  const footballNextKickoffLabel = useMemo(() => {
    if (!footballNextKickoffAt) return "—";
    return fmtRel(footballNextKickoffAt - Date.now());
  }, [tick.current, footballNextKickoffAt]);

  const top3Football = useMemo(() => football.slice(0, 3), [football]);
  const topCrypto = useMemo(() => crypto.slice(0, 10), [crypto]);

  const value = {
    crypto,
    football,
    top3Football,
    topCrypto,
    loading,
    errors,
    cryptoNextRefreshLabel,
    footballLastGeneratedLabel,
    footballNextKickoffLabel,
    refreshAll: async () => {
      await Promise.all([fetchCrypto(), fetchFootball()]);
    },
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export default DataProvider; // <— default export (ako ga negde importuješ kao default)
