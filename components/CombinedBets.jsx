import React, { useEffect, useMemo, useState } from "react";
import HistoryPanel from "./HistoryPanel"; // History tab koristi baš ovaj panel

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function currentSlot(tz = TZ){
  const h = Number(new Intl.DateTimeFormat("en-GB",{hour:"2-digit",hour12:false,timeZone:tz}).format(new Date()));
  return h < 12 ? "am" : h < 20 ? "pm" : "late";
}

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
function fmtLocal(iso, timeZone = TZ) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
function teamName(side) {
  if (!side) return "—";
  if (typeof side === "string") return side || "—";
  if (typeof side === "object") return side.name || "—";
  return "—";
}
function flagEmoji(country = "") {
  const map = {
    Albania: "🇦🇱", Algeria: "🇩🇿", Argentina: "🇦🇷", Australia: "🇦🇺",
    Austria: "🇦🇹", Belgium: "🇧🇪", Bosnia: "🇧🇦", Brazil: "🇧🇷",
    Bulgaria: "🇧🇬", Chile: "🇨🇱", China: "🇨🇳", Colombia: "🇨🇴",
    Croatia: "🇭🇷", Cyprus: "🇨🇾", Czech: "🇨🇿", Denmark: "🇩🇰",
    Ecuador: "🇪🇨", England: "🏴", Estonia: "🇪🇪", Finland: "🇫🇮",
    France: "🇫🇷", Georgia: "🇬🇪", Germany: "🇩🇪", Greece: "🇬🇷",
    Hungary: "🇭🇺", Iceland: "🇮🇸", India: "🇮🇳", Iran: "🇮🇷",
    Ireland: "🇮🇪", Israel: "🇮🇱", Italy: "🇮🇹", Japan: "🇯🇵",
    Korea: "🇰🇷", Lithuania: "🇱🇹", Malaysia: "🇲🇾", Mexico: "🇲🇽",
    Morocco: "🇲🇦", Netherlands: "🇳🇱", Norway: "🇳🇴", Poland: "🇵🇱",
    Portugal: "🇵🇹", Romania: "🇷🇴", Russia: "🇷🇺", Saudi: "🇸🇦",
    Scotland: "🏴", Serbia: "🇷🇸", Slovakia: "🇸🇰", Slovenia: "🇸🇮",
    Spain: "🇪🇸", Sweden: "🇸🇪", Switzerland: "🇨🇭", Turkey: "🇹🇷",
    USA: "🇺🇸", Ukraine: "🇺🇦", Uruguay: "🇺🇾", Wales: "🏴",
  };
  const key = Object.keys(map).find((k) =>
    country && country.toLowerCase().includes(k.toLowerCase())
  );
  return key ? map[key] : "";
}

function ConfidenceBar({ pct }) {
  const v = Math.max(0, Math.min(100, Number(pct || 0)));
  return (
    <div className="h-2 w-full rounded bg-[#2a2f4a] overflow-hidden">
      <div
        className="h-2 rounded bg-[#4f6cf7]"
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

function WhyLine({ explain }) {
  const bullets = Array.isArray(explain?.bullets) ? explain.bullets : [];
  const text = bullets.filter(b => !/^forma:|^h2h/i.test((b||"").trim())).slice(0, 2).join(" · ");
  const forma = (() => {
    const f = bullets.find(b => /^forma:/i.test((b||"").trim()));
    const h = bullets.find(b => /^h2h/i.test((b||"").trim()));
    let s = "";
    if (f) s += f.replace(/^forma:\s*/i, "").trim();
    if (h) s += (s ? "  " : "") + h.replace(/^h2h\s*/i, "H2H ").replace(/^h2h \(l5\):\s*/i, "H2H (L5): ").trim();
    return s ? `Forma: ${s}` : "";
  })();
  return (
    <div className="text-xs text-slate-300 space-y-1">
      {text ? <div>{text}</div> : null}
      {forma ? <div className="opacity-80">{forma}</div> : null}
    </div>
  );
}

function TicketItem({ it }) {
  const league = it?.league?.name || "—";
  const country = it?.league?.country || "";
  const iso = toISO(it);
  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);
  const market = it?.market_label || it?.market || "";
  const sel = it?.selection || "";
  const odds = Number.isFinite(it?.market_odds) ? it.market_odds : it?.odds;
  const conf = Number(it?.confidence_pct || 0);

  return (
    <div className="p-4 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400">
        {league}{country ? ` · ${flagEmoji(country)}` : ""} · {fmtLocal(iso)}
      </div>
      <div className="font-semibold mt-0.5">
        {home} <span className="text-slate-400">vs</span> {away}
      </div>
      <div className="text-sm text-slate-200 mt-1">
        <span className="font-semibold">{market}</span>
        {market ? " → " : ""}{sel}
        {Number.isFinite(odds) ? (
          <span className="text-slate-300"> ({Number(odds).toFixed(2)})</span>
        ) : null}
      </div>

      {/* Zašto / Forma — 2 reda */}
      <div className="mt-2">
        <WhyLine explain={it?.explain} />
      </div>

      {/* Confidence bar */}
      <div className="mt-2">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Confidence</span>
          <span className="text-white font-semibold">{Math.round(conf)}%</span>
        </div>
        <div className="mt-1">
          <ConfidenceBar pct={conf} />
        </div>
      </div>

      <div className="mt-2 text-xs text-slate-300">
        Pick: <span className="font-semibold">{sel}</span>
        {Number.isFinite(odds) ? ` (${Number(odds).toFixed(2)})` : ""}
      </div>
    </div>
  );
}

function TicketsPanel({ items }) {
  // top 3 po svakom od 4 tržišta
  const byMarket = useMemo(() => {
    const res = {
      "1X2": [],
      "BTTS": [],
      "OU 2.5": [],
      "HT-FT": [],
    };
    for (const it of items) {
      const m = String(it?.market_label || it?.market || "").toUpperCase();
      if (m.includes("1X2") || m === "1X2" || m.includes("MATCH WINNER")) res["1X2"].push(it);
      else if (m.includes("BTTS")) res["BTTS"].push(it);
      else if (m.includes("OU 2.5") || m.includes("OVER") || m.includes("UNDER")) res["OU 2.5"].push(it);
      else if (m.includes("HT-FT") || m.includes("HT/FT")) res["HT-FT"].push(it);
    }
    for (const k of Object.keys(res)) res[k] = res[k].slice(0, 3);
    return res;
  }, [items]);

  const groups = Object.entries(byMarket);

  return (
    <div className="rounded-2xl bg-[#15182a] p-4">
      <div className="text-base font-semibold text-white mb-3">Top lige</div>
      {groups.map(([k, arr]) => (
        <div key={k} className="mb-3">
          <div className="text-sm font-semibold text-white mb-1">{k} (3)</div>
          {!arr.length ? (
            <div className="text-xs text-slate-400">Za sada nema preporuka za ovaj market.</div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {arr.map((it) => (
                <TicketItem key={it.fixture_id || `${it.league?.id}-${it?.selection}-${toISO(it)}`} it={it} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- data hooks ---------------- */

function useLockedFeed() {
  const [state, setState] = useState({ items: [], built_at: null, day: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      const slot = currentSlot(TZ);
      let j = await safeJson(`/api/value-bets-locked?slot=${slot}`);
      if (!alive) return;
      if (j?.ok === false) {
        setState((s) => ({ ...s, error: j.error || "Greška", items: [] }));
        return;
      }
      let items = Array.isArray(j?.items) ? j.items
        : Array.isArray(j?.value_bets) ? j.value_bets
        : [];
      if (!items.length){
        const fb = await safeJson(`/api/football?slot=${slot}&norebuild=1`);
        const fitems = Array.isArray(fb?.football) ? fb.football : Array.isArray(fb) ? fb : [];
        if (fitems.length) items = fitems;
      }
      const built_at = j?.built_at || j?.builtAt || null;
      const day = j?.ymd || j?.day || null;
      setState({ items, built_at, day, error: null });
    })();
    return () => { alive = false; };
  }, []);

  return state;
}

function useCryptoTop3() {
  const [state, setState] = useState({ items: [], error: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      const j = await safeJson("/api/crypto");
      if (!alive) return;
      if (j?.ok === false) setState({ items: [], error: j.error || "Greška" });
      else {
        const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j?.signals) ? j.signals : Array.isArray(j?.crypto) ? j.crypto : Array.isArray(j) ? j : [];
        setState({ items: arr.slice(0, 3), error: null });
      }
    })();
    return () => { alive = false; };
  }, []);
  return state;
}

/* ---------------- main ---------------- */

export default function CombinedBets() {
  const [tab, setTab] = useState("Combined"); // Combined | Football | Crypto
  const [sub, setSub] = useState("Kick-Off");  // Kick-Off | Confidence | History

  const { items: lockedList, built_at, day, error } = useLockedFeed();
  const { items: cryptoTop } = useCryptoTop3();

  function CombinedBody() {
    const list = lockedList;

    return (
      <div className="space-y-4">
        {/* gornji grid: lista + history */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* levi panel — lista */}
          <div className="lg:col-span-2">
            {error ? (
              <div className="p-4 rounded-xl bg-[#1f2339] text-red-300 text-sm">
                Greška: {String(error)}
              </div>
            ) : list.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">
                Trenutno nema predloga.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {list.map((it) => (
                  <TicketItem
                    key={it.fixture_id || `${it.league?.id}-${it?.selection}-${toISO(it)}`}
                    it={it}
                  />
                ))}
              </div>
            )}
          </div>

          {/* desni panel — 4 tiketa */}
          <div className="lg:col-span-1">
            <TicketsPanel items={list} />
          </div>
        </div>

        {/* donji grid: Crypto top 3 + History */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <div className="rounded-2xl bg-[#15182a] p-4">
              <div className="text-base font-semibold text-white mb-2">Crypto — Top 3</div>
              {!cryptoTop?.items?.length ? (
                <div className="text-slate-300 text-sm">Trenutno nema signala.</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {cryptoTop.items.map((c, i) => (
                    <div key={i} className="p-3 rounded-xl bg-[#1f2339]">
                      <div className="text-sm font-semibold">{c.symbol}</div>
                      <div className="text-xs text-slate-400">{c.name}</div>
                      <div className="mt-1 text-sm">
                        Signal: <b>{c.signal}</b> · Conf {c.confidence_pct}%
                      </div>
                      <div className="text-xs text-slate-400">
                        1h: {Math.round((c.h1_pct ?? 0)*10)/10}% · 24h: {Math.round((c.d24_pct ?? 0)*10)/10}%
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-1">
            <HistoryPanel />
          </div>
        </div>
      </div>
    );
  }

  function FootballBody() {
    // Oslanja se na isti locked feed; UI razlika je raspored
    const list = lockedList;
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          {list.length === 0 ? (
            <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">
              Trenutno nema predloga.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {list.map((it) => (
                <TicketItem key={it.fixture_id || `${it.league?.id}-${it?.selection}-${toISO(it)}`} it={it} />
              ))}
            </div>
          )}
        </div>
        <div className="lg:col-span-1">
          <TicketsPanel items={list} />
        </div>
      </div>
    );
  }

  function CryptoBody() {
    const { items: citems, error: cerr } = cryptoTop;
    return (
      <div className="rounded-2xl bg-[#15182a] p-4">
        <div className="text-base font-semibold text-white mb-2">Crypto — Top 3</div>
        {cerr ? (
          <div className="text-red-300 text-sm">Greška: {String(cerr)}</div>
        ) : !citems?.length ? (
          <div className="text-slate-300 text-sm">Trenutno nema signala.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {citems.map((c, i) => (
              <div key={i} className="p-3 rounded-xl bg-[#1f2339]">
                <div className="text-sm font-semibold">{c.symbol}</div>
                <div className="text-xs text-slate-400">{c.name}</div>
                <div className="mt-1 text-sm">
                  Signal: <b>{c.signal}</b> · Conf {c.confidence_pct}%
                </div>
                <div className="text-xs text-slate-400">
                  1h: {Math.round((c.h1_pct ?? 0)*10)/10}% · 24h: {Math.round((c.d24_pct ?? 0)*10)/10}%
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
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

      {tab === "Combined" ? (
        <CombinedBody />
      ) : tab === "Football" ? (
        <FootballBody />
      ) : (
        <CryptoBody />
      )}
    </div>
  );
}
