import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";

const TZ = "Europe/Belgrade";

/* ---------------- helpers ---------------- */

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok:false, error:"non-JSON", raw:t }; }
  } catch (e) {
    return { ok:false, error: String(e?.message || e) };
  }
}

function toISO(x) {
  return (
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff ||
    null
  );
}
function fmt(dtStr) {
  try {
    const d = new Date(dtStr);
    return d.toLocaleString("sr-RS", { timeZone: TZ, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  } catch { return dtStr || ""; }
}

/* ---------------- component ---------------- */

export default function CombinedBets({ initialFootball = [], defaultSlot = "am" }) {
  // Tabovi ostaju identični kao i ranije: "Combined", "Football", "Crypto", "History"
  const [activeTab, setActiveTab] = useState("Combined");
  const [slot, setSlot] = useState(String(defaultSlot || "am").toLowerCase());

  // Football data – čitamo isključivo iz /api/value-bets-locked?slot=…
  const [football, setFootball] = useState(initialFootball || []);
  const [loadingFb, setLoadingFb] = useState(false);

  // Crypto (ostaje kako jeste – ne diramo u ovom koraku)
  const [crypto, setCrypto] = useState([]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoadingFb(true);
      const r = await safeJson(`/api/value-bets-locked?slot=${slot}`);
      const arr =
        (Array.isArray(r?.items) ? r.items : null) ||
        (Array.isArray(r?.value_bets) ? r.value_bets : null) ||
        (Array.isArray(r?.football) ? r.football : null) ||
        (Array.isArray(r) ? r : []);
      if (mounted) {
        setFootball(arr || []);
        setLoadingFb(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [slot]);

  const fbTop3 = useMemo(() => football.slice(0, 3), [football]);

  /* ------------- UI blokovi (isti raspored kao ranije) ------------- */

  const Tabs = (
    <div className="flex gap-2 mb-3">
      {["Combined", "Football", "Crypto", "History"].map((t) => (
        <button
          key={t}
          onClick={() => setActiveTab(t)}
          className={`px-3 py-1 rounded ${activeTab === t ? "bg-gray-200 dark:bg-gray-700" : "bg-gray-100 dark:bg-gray-800"}`}
        >
          {t}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-2">
        <label className="text-sm opacity-70">Slot:</label>
        <select
          value={slot}
          onChange={(e) => setSlot(e.target.value)}
          className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-800"
        >
          <option value="late">late</option>
          <option value="am">am</option>
          <option value="pm">pm</option>
        </select>
      </div>
    </div>
  );

  const FootballList = (
    <div>
      {loadingFb && <div className="text-sm opacity-70 mb-2">Učitavanje…</div>}
      {football.length === 0 && !loadingFb && (
        <div className="text-sm opacity-70">Nema dostupnih predloga za izabrani slot.</div>
      )}
      <ul className="space-y-2">
        {football.map((m, i) => (
          <li key={`${m?.fixture_id || m?.id || i}`} className="p-3 rounded border">
            <div className="text-xs opacity-70">
              {(m?.league?.country ? `${m.league.country} — ` : "")}
              {m?.league?.name || m?.league_name || ""}
            </div>
            <div className="text-base">
              {(m?.home_name || m?.teams?.home?.name || "Unknown")} vs {(m?.away_name || m?.teams?.away?.name || "Unknown")}
            </div>
            <div className="text-xs opacity-70">
              {toISO(m) ? `Kick-off: ${fmt(toISO(m))}` : ""}
              {typeof m?.__odds === "number" ? ` • Odds: ${m.__odds}` : ""}
              {typeof m?.tier === "number" ? ` • Tier: ${m.tier}` : ""}
              {typeof m?.confidence_pct === "number" ? ` • Conf: ${m.confidence_pct}%` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );

  const CombinedView = (
    <div className="grid md:grid-cols-2 gap-4">
      <div>
        <h2 className="font-semibold mb-2">Top 3 Football</h2>
        <ul className="space-y-2">
          {fbTop3.map((m, i) => (
            <li key={`fb3-${m?.fixture_id || m?.id || i}`} className="p-3 rounded border">
              <div className="text-xs opacity-70">
                {(m?.league?.country ? `${m.league.country} — ` : "")}
                {m?.league?.name || m?.league_name || ""}
              </div>
              <div className="text-base">
                {(m?.home_name || m?.teams?.home?.name || "Unknown")} vs {(m?.away_name || m?.teams?.away?.name || "Unknown")}
              </div>
              <div className="text-xs opacity-70">
                {toISO(m) ? `Kick-off: ${fmt(toISO(m))}` : ""}
                {typeof m?.__odds === "number" ? ` • Odds: ${m.__odds}` : ""}
                {typeof m?.tier === "number" ? ` • Tier: ${m.tier}` : ""}
                {typeof m?.confidence_pct === "number" ? ` • Conf: ${m.confidence_pct}%` : ""}
              </div>
            </li>
          ))}
          {fbTop3.length === 0 && <li className="text-sm opacity-70">Nema aktuelnih predloga.</li>}
        </ul>
      </div>

      <div>
        <h2 className="font-semibold mb-2">Top 3 Crypto</h2>
        <ul className="space-y-2">
          {crypto.slice(0, 3).map((c, i) => (
            <li key={`c3-${c?.symbol || i}`} className="p-3 rounded border">
              <div className="text-base">{c?.name || c?.symbol || "—"}</div>
              <div className="text-xs opacity-70">{c?.signal ? `Signal: ${c.signal}` : ""}</div>
            </li>
          ))}
          {crypto.length === 0 && <li className="text-sm opacity-70">Nema kripto signala.</li>}
        </ul>
      </div>
    </div>
  );

  return (
    <div className="p-3">
      {Tabs}
      {activeTab === "Combined" && CombinedView}
      {activeTab === "Football" && FootballList}
      {activeTab === "Crypto" && <div className="text-sm opacity-70">Kripto deo ostaje neizmenjen u ovom koraku.</div>}
      {activeTab === "History" && <HistoryPanel />}
    </div>
  );
          }
