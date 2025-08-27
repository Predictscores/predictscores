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

function toISO(x) {
  return (
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_local?.date_time ||
    x?.time?.starting_at?.date_time ||
    x?.kickoff ||
    null
  );
}
function fmtLocal(iso) {
  if (!iso) return "—";
  const d = new Date(String(iso).replace(" ", "T"));
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
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
        className="h-2 bg-sky-400"
        style={{ width: `${v}%`, transition: "width .3s ease" }}
        aria-label={`Confidence ${v}%`}
      />
    </div>
  );
}

function WhyLine({ explain }) {
  // Dva reda max: "Zašto: ..." i kompaktan "Forma/H2H ..."
  const bullets = Array.isArray(explain?.bullets) ? explain.bullets : [];
  const summary = explain?.summary || "";

  const why =
    bullets.length > 0
      ? String(bullets[0]).replace(/^[-•]\s*/, "")
      : summary || "Model/EV balans.";
  const formLine =
    bullets.length > 1 ? String(bullets[1]).replace(/^[-•]\s*/, "") : "";

  return (
    <div className="text-xs text-slate-300 leading-snug">
      <div>Zašto: {why}</div>
      {formLine ? <div>{formLine}</div> : null}
    </div>
  );
}

/* ---------------- singl kartica ---------------- */

function MatchCard({ it }) {
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

      {/* Confidence sa procentom */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
          <span>Confidence</span>
          <span className="font-mono">{conf.toFixed(0)}%</span>
        </div>
        <ConfidenceBar pct={conf} />
      </div>
    </div>
  );
}

/* ---------------- tickets (samo u Football Kick-Off/Confidence) ---------------- */

function TicketItem({ it }) {
  const home = teamName(it?.teams?.home || it?.home);
  const away = teamName(it?.teams?.away || it?.away);
  const iso = toISO(it);
  const sel = it?.selection || "";
  const odds = Number.isFinite(it?.market_odds) ? it.market_odds : it?.odds;
  return (
    <div className="p-2.5 rounded-lg bg-[#1a1e33]">
      <div className="text-[11px] text-slate-400">{fmtLocal(iso)}</div>
      <div className="text-sm font-medium truncate">
        {home} <span className="text-slate-400">vs</span> {away}
      </div>
      <div className="text-xs text-slate-300">
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
      const m = String(it?.market || it?.market_label || "").toUpperCase();
      if (m === "1X2") res["1X2"].push(it);
      else if (m === "BTTS" || m === "BTTS 1H" || m === "BTTS2H") res["BTTS"].push(it);
      else if (m === "OU" || m === "OVER/UNDER" || m === "O/U") {
        const sel = String(it?.selection || "").toUpperCase();
        if (sel.includes("2.5")) res["OU 2.5"].push(it);
      } else if (m === "HT-FT" || m === "HT/FT" || m === "HALFTIME/FULLTIME") {
        res["HT-FT"].push(it);
      }
    }
    for (const k of Object.keys(res)) {
      res[k].sort((a, b) => (Number(b?.confidence_pct || 0) - Number(a?.confidence_pct || 0)));
      res[k] = res[k].slice(0, 3);
    }
    return res;
  }, [items]);

  return (
    <div className="space-y-4">
      {Object.entries(byMarket).map(([title, arr]) => (
        <div key={title} className="p-3 rounded-xl bg-[#1f2339]">
          <div className="text-sm font-semibold mb-2">{title}</div>
          {arr.length === 0 ? (
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
      const j = await safeJson("/api/value-bets-locked");
      if (!alive) return;
      if (j?.ok === false) {
        setState((s) => ({ ...s, error: j.error || "Greška", items: [] }));
        return;
      }
      const items = Array.isArray(j?.items) ? j.items
        : Array.isArray(j?.value_bets) ? j.value_bets
        : [];
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
        const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
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

  const { items, error } = useLockedFeed();
  const cryptoTop = useCryptoTop3();

  /* ---- Football lists ---- */
  const kickoffList = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      const ta = new Date(String(toISO(a) || 0).replace(" ", "T")).getTime();
      const tb = new Date(String(toISO(b) || 0).replace(" ", "T")).getTime();
      return ta - tb;
    });
    return arr;
  }, [items]);

  const confidenceList = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => (Number(b?.confidence_pct || 0) - Number(a?.confidence_pct || 0)));
    return arr;
  }, [items]);

  /* ---- Combined (Top-3 + Top-3) ---- */
  const top3Football = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) => Number(b?.confidence_pct || 0) - Number(a?.confidence_pct || 0)
    );
    // opcioni filter da izbegne mečeve koji su odavno prošli (npr. > 90 min)
    const now = Date.now();
    const filtered = sorted.filter((it) => {
      const t = new Date(String(toISO(it) || 0).replace(" ", "T")).getTime();
      if (!Number.isFinite(t)) return false;
      return t > now - 90 * 60 * 1000; // zadrži one do 90 min unazad
    });
    return filtered.slice(0, 3);
  }, [items]);

  function FootballBody() {
    const list = sub === "Kick-Off" ? kickoffList : confidenceList;

    return (
      <div>
        {/* sub tabovi */}
        <div className="flex items-center gap-2 mb-4">
          {["Kick-Off", "Confidence", "History"].map((name) => (
            <button
              key={name}
              onClick={() => setSub(name)}
              className={`px-3 py-1.5 rounded-lg text-sm ${
                sub === name ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
              }`}
              type="button"
            >
              {name}
            </button>
          ))}
        </div>

        {sub === "History" ? (
          // HISTORY: renderuje samo završene mečeve iz /api/history, bez "Zašto/Forma" i bez tiketa
          <HistoryPanel label="Football — History" />
        ) : (
          // Kick-Off / Confidence: glavni grid + desni panel sa 4 tiketa
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* glavni grid (3 kolone na >=lg) */}
            <div className="lg:col-span-3">
              {error ? (
                <div className="p-4 rounded-xl bg-[#1f2339] text-rose-300 text-sm">
                  Greška: {error}
                </div>
              ) : list.length === 0 ? (
                <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">
                  Trenutno nema predloga.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {list.map((it) => (
                    <MatchCard
                      key={it.fixture_id || `${it.league?.id}-${it?.selection}-${toISO(it)}`}
                      it={it}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* desni panel — 4 tiketa po marketima (samo u Football) */}
            <div className="lg:col-span-1">
              <TicketsPanel items={list} />
            </div>
          </div>
        )}
      </div>
    );
  }

  function CryptoBody() {
    const { items: citems, error: cerr } = cryptoTop;
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {cerr ? (
          <div className="p-4 rounded-xl bg-[#1f2339] text-rose-300 text-sm md:col-span-3">
            Greška: {cerr}
          </div>
        ) : citems.length === 0 ? (
          <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm md:col-span-3">
            Nema kripto podataka.
          </div>
        ) : (
          citems.map((c, idx) => (
            <div key={idx} className="p-4 rounded-xl bg-[#1f2339]">
              <div className="text-xs text-slate-400">{c?.symbol || "—"}</div>
              <div className="font-semibold">{c?.signal || "—"}</div>
              <div className="text-xs text-slate-300">
                TP: {c?.tp ?? "—"} · SL: {c?.sl ?? "—"}
              </div>
              {/* ovde može da ide i mali graf ako već postoji u tvom projektu */}
            </div>
          ))
        )}
      </div>
    );
  }

  function CombinedBody() {
    const { items: citems, error: cerr } = cryptoTop;

    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Levo: Top-3 Football iz locked feed (nema tiketa) */}
        <div>
          <div className="text-sm text-slate-300 mb-2">Top 3 — Football</div>
          {error ? (
            <div className="p-4 rounded-xl bg-[#1f2339] text-rose-300 text-sm">
              Greška: {error}
            </div>
          ) : top3Football.length === 0 ? (
            <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">
              Trenutno nema predloga.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {top3Football.map((it) => (
                <MatchCard
                  key={it.fixture_id || `${it.league?.id}-${it?.selection}-${toISO(it)}`}
                  it={it}
                />
              ))}
            </div>
          )}
        </div>

        {/* Desno: Top-3 Crypto (isti izgled kao tvoj postojeći sažetak) */}
        <div>
          <div className="text-sm text-slate-300 mb-2">Top 3 — Crypto</div>
          {cerr ? (
            <div className="p-4 rounded-xl bg-[#1f2339] text-rose-300 text-sm">
              Greška: {cerr}
            </div>
          ) : (citems || []).length === 0 ? (
            <div className="p-4 rounded-xl bg-[#1f2339] text-slate-300 text-sm">
              Nema kripto podataka.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {citems.slice(0, 3).map((c, idx) => (
                <div key={idx} className="p-4 rounded-xl bg-[#1f2339]">
                  <div className="text-xs text-slate-400">{c?.symbol || "—"}</div>
                  <div className="font-semibold">{c?.signal || "—"}</div>
                  <div className="text-xs text-slate-300">
                    TP: {c?.tp ?? "—"} · SL: {c?.sl ?? "—"}
                  </div>
                  {/* ako imaš mini chart komponentu, ubaci je ovde */}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* glavni tabovi */}
      <div className="flex items-center gap-2 mb-6">
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
