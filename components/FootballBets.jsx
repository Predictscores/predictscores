// components/FootballBets.jsx
"use client";

import { useEffect, useMemo, useState } from "react";

const TZ = "Europe/Belgrade";

// late = 00:00–09:59, am = 10:00–14:59, pm = 15:00–23:59
function currentSlot(tz = TZ) {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(new Date())
  );
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}

// ⬇️ Dodato: vikend i pravilo za N po slotu
function isWeekend(tz = TZ) {
  const wd = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: tz }).format(new Date());
  return wd === "Sat" || wd === "Sun";
}
function desiredCountForSlot(slot, tz = TZ) {
  if (slot === "late") return 6;
  return isWeekend(tz) ? 20 : 15; // am/pm: 15 radnim danima, 20 vikendom
}

/* ===================== parsing ===================== */
function parseKickoff(it) {
  if (it?.kickoff_utc) return new Date(it.kickoff_utc);
  const iso =
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.datetime_local?.date_time ||
    it?.time?.starting_at?.date_time ||
    null;
  if (!iso) return null;
  const s = iso.includes("T") ? iso : iso.replace(" ", "T");
  return new Date(s + (s.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s) ? "" : "Z"));
}

function fmtLocal(date, tz = TZ) {
  if (!date) return "";
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return f.format(date);
}

function teamName(side) {
  if (!side) return "—";
  if (typeof side === "string") return side || "—";
  if (typeof side === "object") return side.name || side.team || "—";
  return "—";
}

function normalizeBet(it) {
  const league =
    it?.league_name || it?.league?.name || it?.league || it?.competition || "";
  const date = parseKickoff(it);

  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);

  const market = it?.market_label || it?.market || "1X2";
  const sel =
    it?.selection_label ||
    it?.pick ||
    it?.selection ||
    (it?.pick_code === "1"
      ? "Home"
      : it?.pick_code === "2"
      ? "Away"
      : it?.pick_code === "X"
      ? "Draw"
      : "");

  let odds =
    typeof it?.odds === "object" && it?.odds
      ? Number(it.odds.price)
      : Number(it?.market_odds ?? it?.odds);
  odds = Number.isFinite(odds) ? odds : null;

  let conf = Number(
    it?.confidence_pct ??
      (typeof it?.model_prob === "number"
        ? it.model_prob <= 1
          ? it.model_prob * 100
          : it.model_prob
        : 0)
  );
  conf = Number.isFinite(conf) ? Math.max(0, Math.min(100, conf)) : 0;

  return {
    id:
      it?.fixture_id ??
      it?.fixture?.id ??
      `${home}-${away}-${Date.parse(date || new Date())}`,
    league,
    date,
    home,
    away,
    market,
    sel,
    odds,
    conf,
    explain: it?.explain,
  };
}

/* ===================== data ===================== */
function useLockedValueBets() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const slot = currentSlot(TZ);
      const n = desiredCountForSlot(slot, TZ); // ⬅️ Dodato: broj stavki po slotu/danu
      const r = await fetch(`/api/value-bets-locked?slot=${slot}&n=${n}`, {
        cache: "no-store",
      });
      const ct = r.headers.get("content-type") || "";
      const body = ct.includes("application/json")
        ? await r.json()
        : await r.text().then((t) => {
            try {
              return JSON.parse(t);
            } catch {
              return { ok: false, error: "non-JSON" };
            }
          });
      const arr = Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body?.football)
        ? body.football
        : Array.isArray(body)
        ? body
        : [];
      setItems(arr.map(normalizeBet));
    } catch (e) {
      setError(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);
  return { items, loading, error, reload: load };
}

/* ===================== UI ===================== */
function ConfidenceBar({ pct }) {
  const v = Math.max(0, Math.min(100, Number(pct || 0)));
  return (
    <div className="h-2 w-full rounded bg-[#2a2f4a] overflow-hidden">
      <div className="h-2 rounded bg-[#4f6cf7]" style={{ width: `${v}%` }} />
    </div>
  );
}

function Row({ b }) {
  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400">{fmtLocal(b.date)}</div>
      <div className="font-semibold mt-0.5">
        {b.home} <span className="text-slate-400">vs</span> {b.away}
      </div>
      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{b.market}</span>
        {b.market ? " → " : ""}
        {b.sel || "—"}
        {b.odds ? (
          <span className="text-slate-300"> ({b.odds.toFixed(2)})</span>
        ) : (
          <span className="text-slate-500"> (—)</span>
        )}
      </div>
      <div className="mt-2">
        <ConfidenceBar pct={b.conf} />
      </div>
    </div>
  );
}

function Section({ title, rows = [] }) {
  return (
    <div className="rounded-2xl bg-[#15182a] p-4">
      <div className="text-base font-semibold text-white mb-3">{title}</div>
      {!rows.length ? (
        <div className="text-slate-400 text-sm">Trenutno nema predloga.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {rows.map((b) => (
            <Row key={b.id} b={b} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ===================== page ===================== */
export default function FootballBets() {
  const { items, loading, error } = useLockedValueBets();
  const [tab, setTab] = useState("ko"); // ko | conf | hist

  const koRows = useMemo(() => {
    return [...items].sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15));
  }, [items]);

  const confRows = useMemo(() => {
    return [...items].sort((a, b) => b.conf - a.conf);
  }, [items]);

  return (
    <div className="space-y-4">
      {/* TAB dugmad */}
      <div className="flex items-center gap-2">
        <button
          className={`px-3 py-1.5 rounded-lg text-sm ${
            tab === "ko" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
          }`}
          onClick={() => setTab("ko")}
          type="button"
        >
          Kick-Off
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-sm ${
            tab === "conf" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
          }`}
          onClick={() => setTab("conf")}
          type="button"
        >
          Confidence
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-sm ${
            tab === "hist" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
          }`}
          onClick={() => setTab("hist")}
          type="button"
        >
          History
        </button>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm">Učitavam…</div>
      ) : error ? (
        <div className="text-red-400 text-sm">Greška: {String(error)}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            {tab === "ko" && <Section title="Kick-Off" rows={koRows} />}
            {tab === "conf" && <Section title="Confidence" rows={confRows} />}
            {tab === "hist" && (
              <div className="rounded-2xl p-4 border border-neutral-800 bg-neutral-900/60 text-sm opacity-80">
                History (14d) puni se kada `history` job upiše rezultate u KV (hist:*).
              </div>
            )}
          </div>
          <div className="lg:col-span-1">{/* desni panel po želji */}</div>
        </div>
      )}
    </div>
  );
}
