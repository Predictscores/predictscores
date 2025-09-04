// components/CombinedBets.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";

const TZ = "Europe/Belgrade";

/* ===================== slot ===================== */
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

// vikend + pravilo za broj stavki
function isWeekend(tz = TZ) {
  const wd = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: tz,
  }).format(new Date());
  return wd === "Sat" || wd === "Sun";
}
function desiredCountForSlot(slot, tz = TZ) {
  if (slot === "late") return 6;
  return isWeekend(tz) ? 20 : 15; // am/pm: 15 radnim danima, 20 vikendom
}

/* ===================== helpers ===================== */
async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await r.json();
    const t = await r.text();
    try {
      return JSON.parse(t);
    } catch {
      return { ok: false, error: "non-JSON", raw: t };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function parseKickoff(it) {
  if (it?.kickoff_utc) return new Date(it.kickoff_utc); // ISO sa zonom
  const iso =
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.datetime_local?.date_time ||
    it?.time?.starting_at?.date_time ||
    null;
  if (!iso) return null;
  const s = iso.includes("T") ? iso : iso.replace(" ", "T");
  // ako nema zonu, tretiramo kao UTC (dodaj Z)
  return new Date(s + (/[Z+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
}

function fmtLocal(date, tz = TZ) {
  if (!date) return "—";
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
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

function ConfidenceBar({ pct }) {
  const v = Math.max(0, Math.min(100, Number(pct || 0)));
  return (
    <div className="h-2 w-full rounded bg-[#2a2f4a] overflow-hidden">
      <div className="h-2 rounded bg-[#4f6cf7]" style={{ width: `${v}%` }} />
    </div>
  );
}

function WhyLine({ explain }) {
  const bullets = Array.isArray(explain?.bullets) ? explain.bullets : [];
  const text = bullets
    .filter((b) => !/^forma:|^h2h/i.test((b || "").trim()))
    .slice(0, 2)
    .join(" · ");
  const forma = (() => {
    const x = bullets.find((b) => /^forma:/i.test((b || "").trim()));
    return x ? x.replace(/^forma:\s*/i, "").trim() : "";
  })();
  const h2h = (() => {
    const x = bullets.find((b) => /^h2h/i.test((b || "").trim()));
    return x ? x.replace(/^h2h:\s*/i, "").trim() : "";
  })();
  if (!text && !forma && !h2h) return null;
  return (
    <div className="text-xs text-slate-400">
      {text}
      {forma ? (text ? " · " : "") + `Forma: ${forma}` : ""}
      {h2h ? ((text || forma) ? " · " : "") + `H2H: ${h2h}` : ""}
    </div>
  );
}

function FootballCard({ bet }) {
  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400">
        {bet.league} · {fmtLocal(bet.date)}
      </div>
      <div className="font-semibold mt-0.5">
        {bet.home} <span className="text-slate-400">vs</span> {bet.away}
      </div>
      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{bet.market}</span>
        {bet.market ? " → " : ""}
        {bet.sel || "—"}
        {bet.odds ? (
          <span className="text-slate-300"> ({bet.odds.toFixed(2)})</span>
        ) : (
          <span className="text-slate-500"> (—)</span>
        )}
      </div>
      <div className="mt-2">
        <ConfidenceBar pct={bet.conf} />
      </div>
      {bet.explain ? (
        <div className="mt-2">
          <WhyLine explain={bet.explain} />
        </div>
      ) : null}
    </div>
  );
}

/* ===================== data hooks ===================== */
function useFootballFeed() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setLoading(true);
      setErr(null);
      const slot = currentSlot(TZ);
      const n = desiredCountForSlot(slot, TZ);
      const j = await safeJson(`/api/value-bets-locked?slot=${slot}&n=${n}`);
      const arr = Array.isArray(j?.items)
        ? j.items
        : Array.isArray(j?.football)
        ? j.football
        : Array.isArray(j)
        ? j
        : [];
      setList(arr.map(normalizeBet));
    } catch (e) {
      setErr(String(e?.message || e));
      setList([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return { list, err, loading, reload: load };
}

function useCryptoTop3() {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setLoading(true);
      setErr(null);
      const j = await safeJson(`/api/crypto`);
      const arr = Array.isArray(j?.signals) ? j.signals : Array.isArray(j) ? j : [];
      setItems(arr.slice(0, 3));
    } catch (e) {
      setErr(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);
  return { items, err, loading };
}

/* ===================== sections ===================== */
function CombinedBody({ footballTop3, cryptoTop3 }) {
  return (
    <div className="space-y-4">
      {/* Football Top 3 */}
      <div className="rounded-2xl bg-[#15182a] p-4">
        <div className="text-base font-semibold text-white mb-3">Football — Top 3</div>
        {!footballTop3.length ? (
          <div className="text-slate-400 text-sm">Trenutno nema predloga.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {footballTop3.map((b) => (
              <FootballCard key={b.id} bet={b} />
            ))}
          </div>
        )}
      </div>

      {/* Crypto Top 3 */}
      <div className="rounded-2xl bg-[#15182a] p-4">
        <div className="text-base font-semibold text-white mb-3">Crypto — Top 3</div>
        {!cryptoTop3.length ? (
          <div className="text-slate-400 text-sm">Trenutno nema kripto signala.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {cryptoTop3.map((c, i) => (
              <div key={c?.symbol || i} className="p-4 rounded-xl bg-[#1f2339]">
                <div className="text-sm font-semibold">{c.symbol}</div>
                <div className="text-xs text-slate-400">{c.name}</div>
                <div className="mt-1 text-sm">
                  Signal: <b>{c.signal}</b> · Conf {Math.round(Number(c.confidence_pct || 0))}%
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FootballBody({ list }) {
  const [tab, setTab] = useState("ko"); // ko | conf | hist

  const koRows = useMemo(
    () => [...list].sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15)),
    [list]
  );
  const confRows = useMemo(() => [...list].sort((a, b) => b.conf - a.conf), [list]);

  return (
    <div className="space-y-4">
      {/* Unutrašnji tabovi */}
      <div className="flex items-center gap-2">
        <button
          className={`px-3 py-1.5 rounded-lg text-sm ${tab === "ko" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`}
          onClick={() => setTab("ko")}
          type="button"
        >
          Kick-Off
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-sm ${tab === "conf" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`}
          onClick={() => setTab("conf")}
          type="button"
        >
          Confidence
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-sm ${tab === "hist" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`}
          onClick={() => setTab("hist")}
          type="button"
        >
          History
        </button>
      </div>

      {tab !== "hist" ? (
        <div className="rounded-2xl bg-[#15182a] p-4">
          <div className="text-base font-semibold text-white mb-3">
            {tab === "ko" ? "Kick-Off" : "Confidence"}
          </div>
          {! (tab === "ko" ? koRows : confRows).length ? (
            <div className="text-slate-400 text-sm">Trenutno nema predloga.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {(tab === "ko" ? koRows : confRows).map((b) => (
                <FootballCard key={b.id} bet={b} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl p-4 border border-neutral-800 bg-neutral-900/60 text-sm opacity-80">
          History (14d) se puni iz KV `hist:*` kada job upiše rezultate posle završetka mečeva.
        </div>
      )}
    </div>
  );
}

function CryptoBody({ list }) {
  return (
    <div className="rounded-2xl bg-[#15182a] p-4">
      <div className="text-base font-semibold text-white mb-3">Crypto — Top 3</div>
      {!list.length ? (
        <div className="text-slate-400 text-sm">Trenutno nema kripto signala.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {list.map((c, i) => (
            <div key={c?.symbol || i} className="p-4 rounded-xl bg-[#1f2339]">
              <div className="text-sm font-semibold">{c.symbol}</div>
              <div className="text-xs text-slate-400">{c.name}</div>
              <div className="mt-1 text-sm">
                Signal: <b>{c.signal}</b> · Conf {Math.round(Number(c.confidence_pct || 0))}%
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===================== main ===================== */
export default function CombinedBets() {
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto
  const fb = useFootballFeed();
  const crypto = useCryptoTop3();

  // Combined: Top 3 po confidence
  const top3Football = useMemo(
    () => [...fb.list].sort((a, b) => b.conf - a.conf).slice(0, 3),
    [fb.list]
  );

  return (
    <div className="mt-4 space-y-4">
      {/* Gornji tabovi */}
      <div className="flex items-center gap-2">
        {["Combined", "Football", "Crypto"].map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === name ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
            }`}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>

      {/* Sadržaj tabova */}
      {tab === "Combined" &&
        (fb.loading ? (
          <div className="text-slate-400 text-sm">Učitavam…</div>
        ) : fb.err ? (
          <div className="text-red-400 text-sm">Greška: {fb.err}</div>
        ) : (
          <CombinedBody footballTop3={top3Football} cryptoTop3={crypto.items} />
        ))}

      {tab === "Football" &&
        (fb.loading ? (
          <div className="text-slate-400 text-sm">Učitavam…</div>
        ) : fb.err ? (
          <div className="text-red-400 text-sm">Greška: {fb.err}</div>
        ) : (
          <FootballBody list={fb.list} />
        ))}

      {tab === "Crypto" &&
        (crypto.loading ? (
          <div className="text-slate-400 text-sm">Učitavam…</div>
        ) : crypto.err ? (
          <div className="text-red-400 text-sm">Greška: {crypto.err}</div>
        ) : (
          <CryptoBody list={crypto.items} />
        ))}
    </div>
  );
}
