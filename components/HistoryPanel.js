// components/HistoryPanel.jsx
import React, { useMemo } from "react";
const TZ = "Europe/Belgrade";

function getDateISO(x) {
  const dt =
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff || x?.date || null;
  return dt ? dt.replace(" ", "T") : null;
}
function fmtWhen(x) {
  const iso = getDateISO(x);
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}
function teamName(it, side) {
  return it?.teams?.[side]?.name ?? it?.[side] ?? it?.[`${side}_name`] ?? "";
}
function outcomeOf(x) {
  if (typeof x?.won === "boolean") return x.won ? "W":"L";
  if (typeof x?.hit === "boolean") return x.hit ? "W":"L";
  if (typeof x?.is_hit === "boolean") return x.is_hit ? "W":"L";
  const s = (x?.outcome || x?.result || x?.settlement || x?.status || "").toString().toLowerCase();
  if (["w","win","won","hit","green","correct"].includes(s)) return "W";
  if (["l","lose","lost","miss","red","wrong"].includes(s))   return "L";
  if (["void","push","canceled","cancelled","abandoned"].includes(s)) return "V";
  return null;
}
function toDecimal(x) {
  if (x === null || x === undefined) return null;
  let s = String(x).trim();
  s = s.replace(",", ".").replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function decimalOdds(x) {
  const cand =
    toDecimal(x?.closing_odds_decimal) ??
    toDecimal(x?.closing_odds) ??
    toDecimal(x?.market_odds_decimal) ??
    toDecimal(x?.market_odds) ??
    toDecimal(x?.odds) ??
    null;
  if (!Number.isFinite(cand) || cand < 1.5 || cand > 20) return null; // MIN 1.50
  return cand;
}
function roiUnits(item) {
  const oc = outcomeOf(item);
  if (!oc || oc === "V") return 0;
  const odds = decimalOdds(item);
  if (!Number.isFinite(odds) || odds <= 1.5) return oc === "W" ? 0 : -1;
  return oc === "W" ? odds - 1 : -1; // stake=1
}
function OutcomeBadge({ oc }) {
  if (!oc) return null;
  const map = {
    W:{txt:"HIT",  cls:"bg-emerald-500/80 text-white"},
    L:{txt:"MISS", cls:"bg-rose-500/80 text-white"},
    V:{txt:"VOID", cls:"bg-gray-500/70 text-white"},
  };
  const m = map[oc];
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${m.cls}`}>{m.txt}</span>;
}

export default function HistoryPanel({ history = [], note="History (14d)" }) {
  const summary = useMemo(() => {
    let W=0,L=0,V=0,units=0;
    for (const x of Array.isArray(history) ? history : []) {
      const oc = outcomeOf(x);
      if (oc==="W") W++; else if (oc==="L") L++; else if (oc==="V") V++;
      units += roiUnits(x);
    }
    const played = W + L;
    const hitRate = played>0 ? Math.round((W/played)*100) : 0;
    return { W, L, V, units: Number(units.toFixed(2)), hitRate };
  }, [history]);

  if (!Array.isArray(history) || history.length===0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <p className="text-sm text-white/70">{note}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-white/10 bg-white/10 p-4 flex items-center justify-between">
        <div className="text-sm">
          <div className="text-white/70">Rezime (14d)</div>
          <div className="font-semibold">
            ROI: <span className={summary.units>=0?"text-emerald-400":"text-rose-400"}>
              {summary.units}u
            </span>
            &nbsp; | &nbsp; W-L-V: {summary.W}-{summary.L}-{summary.V}
            &nbsp; | &nbsp; Hit rate: {summary.hitRate}%
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <ul className="space-y-2">
          {history.map((it, idx) => {
            const id = it?.id || it?.fixture_id || `${idx}`;
            const when = getDateISO(it)
              ? new Date(getDateISO(it)).toLocaleString("sv-SE", {
                  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
                  hour: "2-digit", minute: "2-digit",
                }) : "";
            const home = teamName(it,"home") || "?";
            const away = teamName(it,"away") || "?";
            const market = it?.market_label || it?.market || "";
            const pick = it?.selection || it?.pick || "";
            const oc = outcomeOf(it);
            const odds = decimalOdds(it);
            const units = roiUnits(it);
            return (
              <li key={id} className="flex items-center justify-between rounded-xl bg-black/20 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{home} — {away}</div>
                  <div className="text-xs text-white/60">{when || "\u2014"}</div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right text-xs">
                    {market ? <div className="text-white/70">{market}</div> : null}
                    {pick ? <div className="font-semibold">{pick}</div> : null}
                    {Number.isFinite(odds) ? <div>Odds: {odds}</div> : null}
                    <div className={units>=0 ? "text-emerald-400" : "text-rose-400"}>
                      ROI: {units>=0?"+":""}{units.toFixed(2)}u
                    </div>
                  </div>
                  <OutcomeBadge oc={oc} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
