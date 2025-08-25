// components/HistoryPanel.jsx
// Drop-in: nema više ugnježdenih tabova; prikazuje samo istoriju (14d) ili poruku kada je prazno.

import React from "react";

function getDate(x) {
  return (
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff ||
    x?.date ||
    ""
  );
}

function getTeams(x) {
  const h = x?.teams?.home?.name || x?.home || x?.home_team || "";
  const a = x?.teams?.away?.name || x?.away || x?.away_team || "";
  return { h, a };
}

export default function HistoryPanel({
  history = [],
  note = "History (14d) prikaz ostaje isti — puni se iz nightly procesa.",
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      {Array.isArray(history) && history.length > 0 ? (
        <ul className="space-y-2">
          {history.map((item, idx) => {
            const id = item?.id || item?.fixture_id || `${idx}`;
            const when = getDate(item);
            const { h, a } = getTeams(item);
            const market = item?.market_label || item?.market || "";
            const pick = item?.selection || item?.pick || "";

            return (
              <li
                key={id}
                className="flex items-center justify-between rounded-xl bg-black/20 p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {h} — {a}
                  </div>
                  {when ? (
                    <div className="text-xs text-white/60">{when}</div>
                  ) : null}
                </div>

                <div className="text-right text-xs">
                  {market ? <div className="text-white/70">{market}</div> : null}
                  {pick ? <div className="font-semibold">{pick}</div> : null}
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
