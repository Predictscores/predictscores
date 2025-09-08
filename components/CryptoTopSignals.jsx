// components/CryptoTopSignals.jsx
// Render top-N kripto signala preko SignalCard, sa Entry / TP / SL nivoima.
// Ne zavisi od DataContext-a: sam čita /api/crypto i radi lokalni sort/limit.

import { useEffect, useState, useMemo } from "react";
import SignalCard from "./SignalCard";

function pickList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  return payload.items || payload.signals || payload.data || payload.results || [];
}

export default function CryptoTopSignals({ limit = 3 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/crypto", { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        const list = pickList(j)
          .filter(Boolean)
          .sort((a, b) => (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0));
        setItems(list);
      } catch {
        setItems([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const top = useMemo(() => items.slice(0, limit), [items, limit]);

  if (loading) {
    return (
      <div className="text-slate-300 text-sm py-4">
        Učitavam kripto signale…
      </div>
    );
  }

  if (!top.length) {
    return (
      <div className="text-slate-300 text-sm py-4">
        Trenutno nema kripto signala.
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-3 sm:grid-cols-2 grid-cols-1">
      {top.map((it) => (
        <SignalCard
          key={`${it.symbol || it.ticker || it.id}-${it.exchange || ""}`}
          // osnovno
          sport="crypto"
          ticker={(it.symbolUpper || it.symbol || it.ticker || "").toUpperCase()}
          title={(it.symbolUpper || it.symbol || it.ticker || "").toUpperCase()}
          subtitle={it.name || it.pair || it.exchange || "Crypto"}
          direction={it.direction || (String(it.signal || "").toLowerCase())}
          confidence={it.confidence_pct ?? it.confidence ?? 0}
          image={it.image}

          // NIVOI — pokrivamo više naziva (aliasi su i na API strani)
          entryPrice={it.entry ?? it.entryPrice ?? null}
          takeProfit={it.tp ?? it.takeProfit ?? it.tpPrice ?? null}
          stopLoss={it.sl ?? it.stopLoss ?? it.slPrice ?? null}
          rr={it.rr ?? it.riskReward ?? null}

          // dodatno (ako ih kartica koristi)
          exchange={it.exchange}
          pair={it.pair}
          validUntil={it.valid_until ?? it.validUntil ?? null}
        />
      ))}
    </div>
  );
}
