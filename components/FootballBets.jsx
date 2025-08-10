import React from "react";
import { useData } from "../contexts/DataContext";

// mala pomoćna trakica za confidence
function Bar({ value }) {
  return (
    <div className="w-full h-2 bg-gray-700/60 rounded-full overflow-hidden">
      <div
        className="h-full bg-emerald-400 rounded-full transition-all"
        style={{ width: `${Math.max(2, Math.min(100, Math.round(value)))}%` }}
      />
    </div>
  );
}

function Badge({ children, tone = "default" }) {
  const tones = {
    default: "bg-slate-700 text-slate-100",
    fallback: "bg-slate-800 text-slate-300 border border-slate-600",
    high: "bg-emerald-600 text-white",
    moderate: "bg-sky-600 text-white",
    low: "bg-amber-600 text-white",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${tones[tone] || tones.default}`}>
      {children}
    </span>
  );
}

export default function FootballBets({ limit = 10, useTop3 = false }) {
  const { football, top3Football } = useData();
  const rows = useTop3 ? top3Football : football.slice(0, limit);

  if (!rows.length) {
    return (
      <div className="w-full">
        <div className="rounded-xl bg-amber-50/90 text-amber-900 px-4 py-3 text-sm">
          No suggestions available.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {rows.map((r) => {
        const confTone =
          r.confidenceBucket === "Top"
            ? "high"
            : r.confidenceBucket === "High"
            ? "high"
            : r.confidenceBucket === "Moderate"
            ? "moderate"
            : "low";

        return (
          <div
            key={r.id}
            className="w-full bg-[#1f2339] rounded-2xl shadow p-4 md:p-5 flex flex-col justify-between min-h-[160px]"
          >
            {/* Gornji red: naslov + liga */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-lg md:text-xl font-semibold truncate">
                  {r.teams.home.name} <span className="text-slate-400 font-normal">vs</span> {r.teams.away.name}
                </div>
                <div className="mt-1 text-xs text-slate-300 flex items-center gap-2">
                  <span className="text-base">{r._flag}</span>
                  <span className="truncate">{r.league?.name || "League"}</span>
                  {r.startIso ? (
                    <>
                      <span>•</span>
                      <span>{r.startIso.replace("T", " ").slice(11, 16)}</span>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Badge tone="default">1X2</Badge>
                <Badge tone="default">{r.selection}</Badge>
                {r.type && <Badge tone="fallback">{r.type}</Badge>}
              </div>
            </div>

            {/* Donji red: model/kvota + confidence */}
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
              <div className="text-sm text-slate-200">
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">Model:</span>
                  <span className="font-semibold">{r.modelPct}%</span>
                  {r.marketOdds ? (
                    <>
                      <span className="text-slate-500">•</span>
                      <span className="text-slate-300">Odds:</span>
                      <span className="font-semibold">{r.marketOdds}</span>
                    </>
                  ) : (
                    <span className="ml-2 text-slate-400">(no market)</span>
                  )}
                </div>
              </div>

              <div className="text-sm">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Badge tone={confTone}>{r.confidenceBucket}</Badge>
                    <span className="text-slate-300">Confidence</span>
                  </div>
                  <span className="text-slate-200 font-semibold">{r.confidencePct}%</span>
                </div>
                <Bar value={r.confidencePct} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
