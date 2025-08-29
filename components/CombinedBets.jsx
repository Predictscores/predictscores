import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel"; // History tab koristi baš ovaj panel

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

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

function fmtOdds(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x ?? "");
  return n.toFixed(n >= 10 ? 2 : 2);
}
function fmtDateISO(iso, tz = TZ) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return iso || "";
  const z = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return z;
}
function fmtTimeISO(iso, tz = TZ) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return iso || "";
  const hh = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return hh;
}
function kickoffLocal(iso, tz = TZ) {
  if (!iso) return { date: "", time: "" };
  return { date: fmtDateISO(iso, tz), time: fmtTimeISO(iso, tz) };
}
function koStamp(iso, tz = TZ) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return 0;
  // pretvorimo u lokal u target TZ, ali sortiranje po epoch (utc) je OK
  return d.getTime();
}

function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

function byConfidenceThenKO(a, b) {
  const ca = Number(a?.confidence_pct || 0);
  const cb = Number(b?.confidence_pct || 0);
  if (cb !== ca) return cb - ca;
  const ta = koStamp(a?.kickoff || a?.datetime_local?.date_time || "");
  const tb = koStamp(b?.kickoff || b?.datetime_local?.date_time || "");
  return ta - tb;
}

/* ---------------- tiny card for a pick ---------------- */

function TinyCard({ item }) {
  const ko = kickoffLocal(item?.kickoff || item?.datetime_local?.date_time || "");
  const league = `${item?.league?.name || ""}${item?.league?.country ? " · " + item.league.country : ""}`;
  const selection = `${item?.market_label || item?.market || "Match Winner"} → ${item?.selection || ""}`;
  const odds = fmtOdds(item?.odds ?? item?.market_odds);
  return (
    <div className="rounded-lg bg-[#0f172a] text-white p-3 space-y-1 border border-[#1f2937]">
      <div className="text-xs opacity-70">{league}</div>
      <div className="text-sm font-medium">
        {item?.teams?.home?.name} <span className="opacity-60">vs</span> {item?.teams?.away?.name}
      </div>
      <div className="text-xs opacity-80">{ko.date} {ko.time}</div>
      <div className="text-sm">{selection} <span className="opacity-80">({odds})</span></div>
      <div className="text-xs">Confidence <b>{item?.confidence_pct}%</b></div>
    </div>
  );
}

/* ---------------- main Combined block ---------------- */

export default function CombinedBets({ defaultSlot = "pm" }) {
  const [slot, setSlot] = useState(defaultSlot);
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto | History

  const [combined, setCombined] = useState([]); // top3
  const [football, setFootball] = useState([]); // 15
  const [crypto, setCrypto] = useState([]);     // crypto signals
  const [loading, setLoading] = useState(false);

  // upitni parametar za slot
  useEffect(() => {
    const url = new URL(window.location.href);
    const s = url.searchParams.get("slot");
    if (s && ["am","pm","late"].includes(s)) setSlot(s);
  }, []);

  // auto-load pri promeni slota
  useEffect(() => {
    loadAll(slot);
  }, [slot]);

  async function loadAll(slt) {
    setLoading(true);

    try {
      // TOP 3 locked (Combined)
      const c = await safeJson(`/api/value-bets-locked?slot=${encodeURIComponent(slt)}`);
      const cArr = Array.isArray(c?.items) ? c.items.slice(0, 3)
        : Array.isArray(c?.football) ? c.football.slice(0, 3)
        : Array.isArray(c?.value_bets) ? c.value_bets.slice(0, 3)
        : [];
      cArr.sort(byConfidenceThenKO);
      setCombined(cArr);

      // Football 15 (preferiraj /api/football)
      const f = await safeJson(`/api/football?slot=${encodeURIComponent(slt)}`);
      const fArr = Array.isArray(f?.football) ? f.football
        : Array.isArray(f?.items) ? f.items
        : Array.isArray(f?.value_bets) ? f.value_bets
        : [];
      // kao fallback, pokušaj &full=1 na locked
      let fOut = fArr.slice(0, 15);
      if (!fOut.length) {
        const cfull = await safeJson(`/api/value-bets-locked?slot=${encodeURIComponent(slt)}&full=1`);
        const cFullArr = Array.isArray(cfull?.items) ? cfull.items
          : Array.isArray(cfull?.football) ? cfull.football
          : Array.isArray(cfull?.value_bets) ? cfull.value_bets
          : [];
        fOut = cFullArr.slice(0, 15);
      }
      fOut.sort(byConfidenceThenKO);
      setFootball(fOut);

      // Crypto (ostavljeno kompatibilno)
      const k = await safeJson(`/api/crypto`);
      const kArr = Array.isArray(k?.signals) ? k.signals
        : Array.isArray(k?.items) ? k.items
        : [];
      setCrypto(kArr);
    } finally {
      setLoading(false);
    }
  }

  function TabButton({ label, active, onClick }) {
    return (
      <button
        onClick={onClick}
        className={classNames(
          "px-3 py-1 rounded-md text-sm",
          active ? "bg-[#1f2937] text-white" : "bg-[#111827] text-gray-300 hover:bg-[#1f2937]"
        )}
        type="button"
      >
        {label}
      </button>
    );
  }

  function SlotButton({ value }) {
    const active = slot === value;
    return (
      <button
        onClick={() => setSlot(value)}
        className={classNames(
          "px-2 py-1 rounded-md text-xs",
          active ? "bg-[#2563eb] text-white" : "bg-[#111827] text-gray-300 hover:bg-[#1f2937]"
        )}
        type="button"
      >
        {value.toUpperCase()}
      </button>
    );
  }

  function CombinedBody() {
    if (loading && !combined.length) return <div className="text-gray-300">Učitavam…</div>;
    if (!combined.length) {
      return (
        <div className="text-gray-300">
          Nema kombinovanih predloga za ovaj slot.
          <div className="mt-2">
            <button className="px-3 py-1 rounded-md bg-[#1f2937]" onClick={() => loadAll(slot)}>
              Osveži
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {combined.map((it, i) => <TinyCard key={i} item={it} />)}
      </div>
    );
  }

  function FootballBody() {
    if (loading && !football.length) return <div className="text-gray-300">Učitavam…</div>;
    if (!football.length) {
      return (
        <div className="text-gray-300">
          Nema football predloga za ovaj slot.
          <div className="mt-2">
            <button className="px-3 py-1 rounded-md bg-[#1f2937]" onClick={() => loadAll(slot)}>
              Osveži
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {football.slice(0, 15).map((it, i) => <TinyCard key={i} item={it} />)}
      </div>
    );
  }

  function CryptoBody() {
    if (loading && !crypto.length) return <div className="text-gray-300">Učitavam…</div>;
    if (!crypto.length) {
      return (
        <div className="text-gray-300">
          Nema crypto signala trenutno.
          <div className="mt-2">
            <button className="px-3 py-1 rounded-md bg-[#1f2937]" onClick={() => loadAll(slot)}>
              Osveži
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {crypto.map((it, i) => <TinyCard key={i} item={it} />)}
      </div>
    );
  }

  const tabs = useMemo(() => ([
    { label: "Combined", key: "Combined" },
    { label: "Football", key: "Football" },
    { label: "Crypto", key: "Crypto" },
    { label: "History", key: "History" },
  ]), []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={classNames(
              "px-3 py-1 rounded-md text-sm",
              tab === t.key ? "bg-[#1f2937] text-white" : "bg-[#111827] text-gray-300 hover:bg-[#1f2937]"
            )}
            type="button"
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <SlotButton value="am" />
          <SlotButton value="pm" />
          <SlotButton value="late" />
        </div>
      </div>

      {tab === "History" ? (
        <div className="rounded-lg border border-[#1f2937]">
          <HistoryPanel slot={slot} />
        </div>
      ) : null}

      {tab !== "History" ? (
        <div className="flex justify-between items-center">
          <div className="text-sm opacity-80">
            Slot: <b>{slot.toUpperCase()}</b>
          </div>
          <div>
            <button
              className="px-3 py-1 rounded-md bg-[#1f2937] text-sm"
              onClick={() => loadAll(slot)}
            >
              Osveži
            </button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-[#1f2937] p-3">
        <div className="flex items-center gap-2 mb-3">
          {["Combined", "Football", "Crypto"].map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={classNames(
                "px-3 py-1 rounded-md text-sm",
                tab === k ? "bg-[#2563eb] text-white" : "bg-[#111827] text-gray-300 hover:bg-[#1f2937]"
              )}
              type="button"
            >
              {k}
            </button>
          ))}
          <div className="ml-auto">
            <button
              onClick={() => setTab("History")}
              className={classNames(
                "px-3 py-1 rounded-md text-sm",
                tab === "History" ? "bg-[#2563eb] text-white" : "bg-[#111827] text-gray-300 hover:bg-[#1f2937]"
              )}
            >
              History
            </button>
          </div>
        </div>

        {tab === "Combined" ? (
          <CombinedBody />
        ) : tab === "Football" ? (
          <FootballBody />
        ) : (
          <CryptoBody />
        )}
      </div>
    </div>
  );
            }
