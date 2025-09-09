// FILE: components/TicketPanel.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";

// Maks kvote po kategoriji (možeš prebaciti u ENV ako želiš)
const MAX_BTTS = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_BTTS || 4.0);
const MAX_OU   = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_OU   || 4.0);
const MAX_HTFT = Number(process.env.NEXT_PUBLIC_TKT_MAX_ODDS_HTFT || 9.0);

// Default filteri
const MIN_CONF = 0;          // ti ćeš odlučiti na UI filteru; ovde default=0
const MIN_BKS_OU_BTTS = 1;   // minimalan broj bukija (po želji pooštri)
const MIN_BKS_HTFT = 1;

// Pomoćne
const toTime = (iso) => {
  try { return new Date(String(iso)); } catch { return null; }
};
const niceTime = (iso) => {
  const d = toTime(iso);
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
};
const score = (t) => {
  if (Number.isFinite(t?.confidence_pct)) return Number(t.confidence_pct);
  const edge = (t?.model_prob ?? 0) - (t?.implied_prob ?? 0);
  return Math.round(edge * 100);
};

function withinOdds(kind, odds) {
  if (!Number.isFinite(odds) || odds <= 0) return false;
  if (kind === "btts") return odds <= MAX_BTTS;
  if (kind === "ou25") return odds <= MAX_OU;
  if (kind === "htft") return odds <= MAX_HTFT;
  return false;
}
function meetsBookies(kind, n) {
  const x = Number(n || 0);
  if (kind === "btts" || kind === "ou25") return x >= MIN_BKS_OU_BTTS;
  if (kind === "htft") return x >= MIN_BKS_HTFT;
  return true;
}

// Čitanje ?slot iz URL-a, ako nije prosleđen kroz prop
function slotFromUrl() {
  if (typeof window === "undefined") return undefined;
  try {
    const s = new URL(window.location.href).searchParams.get("slot");
    return s || undefined;
  } catch { return undefined; }
}

// Ako ne proslediš `bets`, komponenta sama čita locked feed
function useLocked(slot) {
  const eff = slot ?? slotFromUrl();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let dead = false;
    const qs = eff ? `?slot=${encodeURIComponent(eff)}` : "";
    setLoading(true); setErr(null);
    fetch(`/api/value-bets-locked${qs}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => !dead && setData(j))
      .catch(e => !dead && setErr(String(e)))
      .finally(() => !dead && setLoading(false));
    return () => { dead = true; };
  }, [eff]);

  return { data, loading, err };
}

/**
 * Tickets right-rail panel (BTTS / OU 2.5 / HT/FT)
 *
 * Korišćenje:
 *   <TicketPanel />           // sam će da učita /api/value-bets-locked?slot=...
 *   <TicketPanel slot="pm" /> // eksplicitno za slot
 *
 * Ako ipak proslediš `bets`, koristiće njih (ali i dalje prikazuje samo BTTS/OU/HTFT).
 */
export default function TicketPanel({
  bets,
  slot,
  className,
  maxPerMarket = 3,
  hideFriendlies = false,
  minConfidence = MIN_CONF,
}) {
  // Ako nema bets, čitamo locked feed
  const { data, loading, err } = useLocked(bets?.length ? undefined : slot);

  // Izvor podataka: ili `bets` (ako prosleđeno), ili `data.tickets.*`
  const source = useMemo(() => {
    if (Array.isArray(bets) && bets.length > 0) {
      // očekujemo da su to već "ticket-like" zapisi
      return {
        btts: bets.filter(p => String(p.market || p.market_label).toLowerCase().includes("btts")),
        ou25: bets.filter(p => {
          const m = String(p.market || p.market_label).toLowerCase();
          return m.includes("over") || m.includes("under") || m.includes("ou");
        }),
        htft: bets.filter(p => {
          const m = String(p.market || p.market_label).toLowerCase();
          return m.includes("ht-ft") || m.includes("ht/ft");
        }),
        cap: 3,
      };
    }
    const t = data?.tickets || {};
    return { btts: t.btts || [], ou25: t.ou25 || [], htft: t.htft || [], cap: data?.policy_cap ?? 3 };
  }, [bets, data]);

  // Primena filtera i rangiranje
  const lists = useMemo(() => {
    const cook = (arr, kind) => {
      const filtered = (arr || []).filter((t) => {
        if (hideFriendlies &&
            (((t.league?.name || "").toLowerCase().includes("friendlies")) ||
              t.league?.country === "World")) return false;
        if (!withinOdds(kind, Number(t.market_odds))) return false;
        if (!meetsBookies(kind, Number(t.bookmakers_count))) return false;
        if (Number.isFinite(minConfidence) && score(t) < Number(minConfidence)) return false;
        return true;
      });
      const sorted = filtered
        .slice()
        .sort((a, b) => {
          const sb = score(b), sa = score(a);
          if (sb !== sa) return sb - sa;
          const tb = toTime(b.kickoff_utc)?.getTime() || 0;
          const ta = toTime(a.kickoff_utc)?.getTime() || 0;
          return ta - tb; // ranije prvo
        });
      return sorted.slice(0, maxPerMarket);
    };

    return {
      btts: cook(source.btts, "btts"),
      ou25: cook(source.ou25, "ou25"),
      htft: cook(source.htft, "htft"),
      cap: source.cap,
    };
  }, [source, hideFriendlies, minConfidence, maxPerMarket]);

  return (
    <aside
      className={[
        "w-full lg:w-80 xl:w-96 lg:sticky lg:top-4 space-y-4",
        className || "",
      ].join(" ")}
      aria-label="Tickets"
    >
      <h3 className="text-lg font-semibold">Tickets</h3>

      {err && <div className="text-sm text-red-400">Greška: {String(err)}</div>}
      {loading && <div className="text-sm opacity-70">Učitavanje…</div>}

      {(["btts","ou25","htft"]).map((key) => {
        const title = key === "btts" ? "BTTS" : key === "ou25" ? "OU 2.5" : "HT/FT";
        const rows = lists[key];
        return (
          <section key={key} className="rounded-2xl border border-white/5 bg-black/30 p-3">
            <header className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs opacity-60">{rows.length} od {lists.cap}</span>
            </header>

            <div className="space-y-2">
              {rows.map((t, i) => (
                <article
                  key={`${key}-${t.fixture_id || i}-${t.selection || ""}`}
                  className="rounded-xl bg-white/5 p-3"
                >
                  <div className="text-sm font-semibold truncate">
                    {(t.teams?.home || t.home?.name || "—")} — {(t.teams?.away || t.away?.name || "—")}
                  </div>
                  <div className="mt-0.5 text-xs opacity-70 truncate">
                    {(t.league?.name || "—")} · {niceTime(t.kickoff_utc || t?.datetime_local?.starting_at?.date_time)}
                  </div>

                  <div className="mt-2 flex items-center justify-between">
                    <div className="text-xs">
                      <div className="opacity-70">{t.market_label || t.market}</div>
                      <div className="font-medium">{t.selection}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold">
                        {Number.isFinite(t.market_odds) ? `@ ${Number(t.market_odds).toFixed(2)}` : "—"}
                      </div>
                      <div className="text-[11px] opacity-70">{score(t)}%</div>
                    </div>
                  </div>

                  <div className="mt-2 h-1.5 w-full rounded bg-white/10">
                    <div
                      className="h-full rounded bg-white/70"
                      style={{ width: `${Math.max(0, Math.min(100, score(t)))}%` }}
                    />
                  </div>

                  {Number.isFinite(t.bookmakers_count) && (
                    <div className="mt-1 text-[11px] opacity-60">
                      Bookmakers: {t.bookmakers_count}
                    </div>
                  )}
                </article>
              ))}

              {!loading && rows.length === 0 && (
                <div className="text-xs opacity-60">Nema dostupnih predloga.</div>
              )}
            </div>
          </section>
        );
      })}
    </aside>
  );
}
