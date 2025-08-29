// components/CombinedBets.jsx
import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel";

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

/* ================= helpers ================= */

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

function classNames(...arr) { return arr.filter(Boolean).join(" "); }

function fmtOdds(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x ?? "");
  return n.toFixed(2);
}
function fmtDateISO(iso, tz = TZ) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return iso || "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function fmtTimeISO(iso, tz = TZ) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return iso || "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
function kickoffLocal(iso, tz = TZ) {
  if (!iso) return { date: "", time: "" };
  return { date: fmtDateISO(iso, tz), time: fmtTimeISO(iso, tz) };
}
function koStamp(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return 0;
  return d.getTime();
}
function byKickoffAsc(a, b) {
  const ta = koStamp(a?.kickoff || a?.datetime_local?.date_time || "");
  const tb = koStamp(b?.kickoff || b?.datetime_local?.date_time || "");
  return ta - tb;
}
function byConfidenceDesc(a, b) {
  const ca = Number(a?.confidence_pct || 0);
  const cb = Number(b?.confidence_pct || 0);
  return cb - ca;
}

/* ================= cards ================= */

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

function CryptoCard({ s }) {
  // maksimalno kompatibilno sa raznim payload-ima
  const pair = s?.pair || s?.symbol || s?.ticker || s?.asset || "";
  const tf   = s?.tf || s?.timeframe || s?.interval || "";
  const side = s?.side || s?.direction || s?.action || s?.signal || "";
  const price= s?.entry ?? s?.price ?? s?.last ?? s?.mark ?? null;
  const sl   = s?.sl ?? s?.stop ?? s?.stop_loss ?? null;
  const tp   = s?.tp ?? s?.take ?? s?.take_profit ?? s?.target ?? null;
  const conf = s?.confidence_pct ?? s?.confidence ?? s?.score ?? null;

  return (
    <div className="rounded-lg bg-[#0f172a] text-white p-3 space-y-1 border border-[#1f2937]">
      <div className="text-sm font-medium">{pair} {tf ? <span className="opacity-70">· {tf}</span> : null}</div>
      <div className="text-sm">Signal → <b>{String(side || "—")}</b>{price!=null ? <span className="opacity-80"> @ {Number(price) ? Number(price).toFixed(4) : price}</span> : null}</div>
      <div className="text-xs opacity-80">
        {sl!=null ? <>SL: <b>{sl}</b></> : null}
        {sl!=null && tp!=null ? " · " : null}
        {tp!=null ? <>TP: <b>{tp}</b></> : null}
      </div>
      {conf!=null ? <div className="text-xs">Confidence <b>{conf}%</b></div> : null}
    </div>
  );
}

/* ================= main ================= */

export default function CombinedBets({ defaultSlot = "pm" }) {
  const [slot, setSlot] = useState(defaultSlot);

  // gornje kartice
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto
  // unutrašnji tabovi u Football kartici
  const [footballTab, setFootballTab] = useState("Kickoff"); // Kickoff | Confidence | History

  // podaci
  const [combined, setCombined] = useState([]); // top3
  const [football, setFootball] = useState([]); // do 15
  const [crypto, setCrypto] = useState([]);     // crypto signals
  const [loading, setLoading] = useState(false);

  // slušaj ?slot=am|pm|late iz URL-a (bez lokalnih dugmića)
  useEffect(() => {
    const url = new URL(window.location.href);
    const s = url.searchParams.get("slot");
    if (s && ["am","pm","late"].includes(s)) setSlot(s);
  }, []);

  useEffect(() => { loadAll(slot); }, [slot]);

  async function loadAll(slt) {
    setLoading(true);
    try {
      // Combined = TOP3 iz locked seta (bez &full=1)
      const c = await safeJson(`/api/value-bets-locked?slot=${encodeURIComponent(slt)}`);
      const cArr = Array.isArray(c?.items) ? c.items
        : Array.isArray(c?.football) ? c.football
        : Array.isArray(c?.value_bets) ? c.value_bets
        : [];
      setCombined((cArr || []).slice(0, 3));

      // Football = zaključani full-set (stabilna struktura) -> 15
      const cf = await safeJson(`/api/value-bets-locked?slot=${encodeURIComponent(slt)}&full=1`);
      let fArr = Array.isArray(cf?.items) ? cf.items
        : Array.isArray(cf?.football) ? cf.football
        : Array.isArray(cf?.value_bets) ? cf.value_bets
        : [];
      // fallback na /api/football ako full nema ništa
      if (!fArr.length) {
        const f = await safeJson(`/api/football?slot=${encodeURIComponent(slt)}`);
        fArr = Array.isArray(f?.football) ? f.football
          : Array.isArray(f?.items) ? f.items
          : Array.isArray(f?.value_bets) ? f.value_bets
          : [];
      }
      setFootball((fArr || []).slice(0, 15));

      // Crypto – koristi svoj renderer
      const k = await safeJson(`/api/crypto`);
      const kArr = Array.isArray(k?.signals) ? k.signals
        : Array.isArray(k?.items) ? k.items
        : [];
      setCrypto(kArr || []);
    } finally {
      setLoading(false);
    }
  }

  /* --------- tela kartica --------- */

  function CombinedBody() {
    if (loading && !combined.length) return <div className="text-gray-300">Učitavam…</div>;
    if (!combined.length) return <div className="text-gray-300">Nema kombinovanih predloga za ovaj slot.</div>;
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {combined.map((it, i) => <TinyCard key={i} item={it} />)}
      </div>
    );
  }

  function FootballBody() {
    const innerTabs = ["Kickoff", "Confidence", "History"];
    const sortedKickoff = [...football].sort(byKickoffAsc);
    const sortedConfidence = [...football].sort(byConfidenceDesc);

    return (
      <div className="space-y-3">
        {/* unutrašnji Football tabovi (horizontalni skrol na mobilnom) */}
        <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap pb-1">
          {innerTabs.map(t => (
            <button
              key={t}
              onClick={() => setFootballTab(t)}
              className={classNames(
                "px-3 py-1 rounded-md text-sm shrink-0",
                footballTab === t ? "bg-[#2563eb] text-white" : "bg-[#111827] text-gray-300 hover:bg-[#1f2937]"
              )}
              type="button"
            >
              {t}
            </button>
          ))}
        </div>

        {footballTab === "History" ? (
          <div className="rounded-lg border border-[#1f2937]">
            <HistoryPanel slot={slot} />
          </div>
        ) : footballTab === "Confidence" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3">
            {sortedConfidence.slice(0, 15).map((it, i) => <TinyCard key={i} item={it} />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3">
            {sortedKickoff.slice(0, 15).map((it, i) => <TinyCard key={i} item={it} />)}
          </div>
        )}
      </div>
    );
  }

  function CryptoBody() {
    if (loading && !crypto.length) return <div className="text-gray-300">Učitavam…</div>;
    if (!crypto.length) return <div className="text-gray-300">Nema crypto signala trenutno.</div>;
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
        {crypto.map((s, i) => <CryptoCard key={i} s={s} />)}
      </div>
    );
  }

  /* --------- tabs header --------- */

  const tabs = useMemo(() => ([
    { label: "Combined", key: "Combined" },
    { label: "Football", key: "Football" },
    { label: "Crypto",   key: "Crypto"   },
  ]), []);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {tabs.map(t => (
          <TabButton
            key={t.key}
            label={t.label}
            active={tab === t.key}
            onClick={() => setTab(t.key)}
          />
        ))}
      </div>

      <div className="rounded-lg border border-[#1f2937] p-3">
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
