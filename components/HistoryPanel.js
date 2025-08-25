// components/HistoryPanel.jsx
// Prikazuje istoriju (14d) i jasno obeležava POGODAK / PROMAŠAJ / VOID.
// Ne renderuje nikakve pod-tabove, samo listu.

import React from "react";

const TZ = "Europe/Belgrade";

function getDateISO(x) {
  const dt =
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff ||
    x?.date ||
    null;
  return dt ? dt.replace(" ", "T") : null;
}

function fmtWhen(x) {
  const iso = getDateISO(x);
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function getTeams(x) {
  const h = x?.teams?.home?.name || x?.home || x?.home_team || "";
  const a = x?.teams?.away?.name || x?.away || x?.away_team || "";
  return { h, a };
}

// Robustno detektuj ishod iz raznih mogućih polja (zavisno od feed-a)
function resolveOutcome(x) {
  // boolean polja
  if (typeof x?.won === "boolean") return x.won ? "W" : "L";
  if (typeof x?.hit === "boolean") return x.hit ? "W" : "L";
  if (typeof x?.is_hit === "boolean") return x.is_hit ? "W" : "L";

  // tekstualna polja
  const s =
    (x?.outcome || x?.result || x?.settlement || x?.status || "")
      .toString()
      .toLowerCase();

  if (["w", "win", "won", "hit", "green", "correct"].includes(s)) return "W";
  if (["l", "lose", "lost", "miss", "red", "wrong"].includes(s)) return "L";
  if (["void", "push", "canceled", "cancelled", "abandoned"].includes(s)) return "V";
  return null; // nepoznato
}

function OutcomeBadge({ outcome }) {
  if (!outcome) return null;
  const map = {
    W: { txt: "HIT", cls: "bg-emerald-500/80 text-white" },
    L: { txt: "MISS", cls: "bg-rose-500/80 text-white" },
    V: { txt: "VOID", cls: "bg-gray-500/70 text-white" },
  };
  const m = map[outcome] || null;
  if (!m) return null;
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${m.cls}`}>
      {m.txt}
    </span>
  );
}

export default function HistoryPanel({
  history = [],
  note = "History (14d)",
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      {Array.isArray(history) && history.length > 0 ? (
        <ul className="space-y-2">
          {history.map((item, idx) => {
            const id = item?.id || item?.fixture_id || `${idx}`;
            const when = fmtWhen(item);
            const { h, a } = getTeams(item);
            const market = item?.market_label || item?.market || "";
            const pick = item?.selection || item?.pick || "";
            const oc = resolveOutcome(item);

            return (
              <li
                key={id}
                className="flex items-center justify-between rounded-xl bg-black/20 p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {h} — {a}
                  </div>
                  <div className="text-xs text-white/60">{when || "\u2014"}</div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right text-xs">
                    {market ? <div className="text-white/70">{market}</div> : null}
                    {pick ? <div className="font-semibold">{pick}</div> : null}
                  </div>
                  <OutcomeBadge outcome={oc} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-white/70">{note}</p>
      )}
    </div>
  );
}
