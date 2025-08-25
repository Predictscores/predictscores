// components/FootballBets.jsx
"use client";

import { useEffect, useMemo, useState } from "react";

/* ===================== data ===================== */
function useLockedValueBets() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);

      const r = await fetch("/api/value-bets-locked", { cache: "no-store" });
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
        : Array.isArray(body?.value_bets)
        ? body.value_bets
        : [];

      setItems(arr);
    } catch (e) {
      setError(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // periodični refresh samo 1x/min — bez ikakvih cron-ova
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  return { items, loading, error, reload: load };
}

/* ===================== helpers ===================== */
function getKOISO(p) {
  const raw =
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.time?.starting_at?.date_time ||
    null;
  if (!raw) return null;
  return raw.includes("T") ? raw : raw.replace(" ", "T");
}
function parseKOms(p) {
  const iso = getKOISO(p);
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}
function koCET(p, tz = "Europe/Belgrade") {
  const t = parseKOms(p);
  if (!t) return "";
  const d = new Date(t);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
function pct(x) {
  if (!Number.isFinite(x)) return null;
  const v = x > 1 ? x : x * 100;
  return Math.round(v * 10) / 10;
}
function whyText2lines(p) {
  // 1) Zašto — ako ima bullets (osim Forma/H2H), koristi njih, inače fallback
  const bullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const whyList = bullets.filter(
    (b) => !/^forma:|^h2h/i.test((b || "").trim())
  );
  let zasto = whyList.length
    ? `Zašto: ${whyList.join(". ").replace(/\.\s*$/, "")}.`
    : (() => {
        const mp = pct(p?.model_prob);
        const ip =
          pct(p?.implied_prob ??
            (p?.market_odds ? 100 / p.market_odds : undefined)) ?? null;
        const ev = pct(p?.ev);
        const parts = [];
        if (mp != null && ip != null) parts.push(`Model ${mp}% vs ${ip}%`);
        if (ev != null) parts.push(`EV ${ev}%`);
        const ba = Number.isFinite(p?.bookmakers_count) ? p.bookmakers_count : null;
        const bt = Number.isFinite(p?.bookmakers_count_trusted) ? p.bookmakers_count_trusted : null;
        if (ba != null) parts.push(`Bookies ${ba}${bt!=null?` (trusted ${bt})`:""}`);
        return parts.length ? `Zašto: ${parts.join(" · ")}.` : "";
      })();

  // 2) Forma — sve u JEDAN red (Forma + H2H)
  const formaLine =
    bullets.find((b) => /^forma:/i.test((b || "").trim())) || null;
  const h2hLine = bullets.find((b) => /^h2h/i.test((b || "").trim())) || null;

  let forma = "";
  if (formaLine || h2hLine) {
    const f = formaLine ? formaLine.replace(/^forma:\s*/i, "").trim() : "";
    const h = h2hLine
      ? h2hLine.replace(/^h2h\s*/i, "H2H ").replace(/^h2h \(l5\):\s*/i, "H2H (L5): ").trim()
      : "";
    forma = `Forma: ${[f, h].filter(Boolean).join("  ")}`.trim();
  }

  return [zasto, forma].filter(Boolean).join("\n");
}
function flagFromLeague(league) {
  // koristi league.flag ili league.country_code; fallback: nema zastave
  const code =
    league?.country_code ||
    league?.flag?.replace(/.*\/([A-Z]{2})\.svg$/i, "$1") ||
    null;
  if (!code) return "";
  const cc = code.toUpperCase();
  // Regional indicator letters
  const A = 0x1f1e6;
  const Z = 0x1f1ff;
  const a = cc.charCodeAt(0) - 65 + A;
  const b = cc.charCodeAt(1) - 65 + A;
  if (a < A || a > Z || b < A || b > Z) return "";
  return String.fromCodePoint(a) + String.fromCodePoint(b);
}

/* ===================== right panel: top by market ===================== */
function groupTopByMarket(items, take = 3) {
  const label = (p) => (p?.market_label || p?.market || "").toUpperCase();

  const is1X2 = (p) => /^1X2\b/.test(label(p));
  const isBTTS = (p) => /^BTTS\b(?!.*1H)/.test(label(p)); // ne BTTS 1H
  const isOU25 = (p) => /^OU\s*2\.?5\b/i.test(label(p)) || /^O[UV]\s*2\.?5\b/i.test(label(p));
  const isHTFT = (p) => /^HT[-\s]?FT\b/i.test(label(p));

  const sorted = [...items].sort(
    (a, b) =>
      (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0) ||
      (b?.ev ?? 0) - (a?.ev ?? 0)
  );

  return {
    BTTS: sorted.filter(isBTTS).slice(0, take),
    "OU 2.5": sorted.filter(isOU25).slice(0, take),
    "HT-FT": sorted.filter(isHTFT).slice(0, take),
    "1X2": sorted.filter(is1X2).slice(0, take),
  };
}

/* ===================== UI ===================== */
function Card({ p }) {
  const league = p?.league?.name || p?.league_name || "";
  const ko = koCET(p);
  const home = p?.teams?.home?.name || p?.teams?.home || p?.home || "";
  const away = p?.teams?.away?.name || p?.teams?.away || p?.away || "";
  const market = p?.market_label || p?.market || "";
  const sel = p?.selection || "";
  const price = p?.market_odds ?? p?.odds ?? p?.price;
  const conf = p?.confidence_pct ?? p?.confidence ?? 0;
  const flag = flagFromLeague(p?.league);

  return (
    <div className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
      <div className="text-xs opacity-70 mb-1">
        {flag && <span className="mr-1">{flag}</span>}
        {league} • {ko}
      </div>
      <div className="text-lg font-semibold mb-1">
        {home} vs {away}
      </div>
      <div className="text-sm mb-3">
        {market}: <b>{sel}</b> {price ? <span>({price})</span> : null}
      </div>

      <div className="text-sm opacity-90 mb-3 whitespace-pre-line">
        {whyText2lines(p)}
      </div>

      <div className="text-xs opacity-70 mb-1">Confidence</div>
      <div className="h-2 bg-neutral-800 rounded relative">
        <div
          className="h-2 rounded bg-yellow-500"
          style={{ width: `${Math.max(0, Math.min(100, conf))}%` }}
        />
        <div className="absolute -top-5 right-0 text-xs opacity-80">{Math.round(conf)}%</div>
      </div>
    </div>
  );
}

function RightPanel({ groups }) {
  const Section = ({ title, rows }) => (
    <div className="rounded-2xl p-4 shadow bg-neutral-900/60 border border-neutral-800">
      <div className="font-semibold mb-3">{title}</div>
      {!rows?.length ? (
        <div className="text-sm opacity-70">Nema dovoljno kandidata.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((p, i) => {
            const league = p?.league?.name || p?.league_name || "";
            const home = p?.teams?.home?.name || p?.teams?.home || p?.home || "";
            const away = p?.teams?.away?.name || p?.teams?.away || p?.away || "";
            const ko = koCET(p);
            const market = p?.market_label || p?.market || "";
            const sel = p?.selection || "";
            const price = p?.market_odds ?? p?.odds ?? p?.price;
            return (
              <div key={`${p?.fixture_id ?? p?.id ?? i}`} className="text-sm">
                <div className="opacity-70 text-xs mb-0.5">{league} • {ko}</div>
                <div className="font-medium">{home} vs {away}</div>
                <div className="opacity-90">{market}: <b>{sel}</b>{price ? ` (${price})` : ""}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <Section title="BTTS (3)" rows={groups["BTTS"]} />
      <Section title="OU 2.5 (3)" rows={groups["OU 2.5"]} />
      <Section title="HT-FT (3)" rows={groups["HT-FT"]} />
      <Section title="1X2 (3)" rows={groups["1X2"]} />
    </div>
  );
}

/* ===================== main ===================== */
export default function FootballBets({ limit = 50, layout = "full" }) {
  const { items, loading, error } = useLockedValueBets();
  const [tab, setTab] = useState("kick");

  // baci prošle mečeve (ostavi malo tolerancije)
  const future = useMemo(() => {
    const now = Date.now() - 60_000; // −1 min tolerancije
    return (Array.isArray(items) ? items : []).filter((p) => (parseKOms(p) ?? 0) >= now);
  }, [items]);

  const byKickoff = useMemo(() => {
    const list = [...future];
    list.sort((a, b) => (parseKOms(a) ?? 9e15) - (parseKOms(b) ?? 9e15));
    return list.slice(0, limit);
  }, [future, limit]);

  const byConfidence = useMemo(() => {
    const list = [...future];
    list.sort(
      (a, b) =>
        (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0) ||
        (b?.ev ?? 0) - (a?.ev ?? 0)
    );
    return list.slice(0, limit);
  }, [future, limit]);

  const marketGroups = useMemo(() => groupTopByMarket(future, 3), [future]);

  if (loading) return <div className="opacity-70">Učitavanje…</div>;
  if (error) return <div className="text-red-400">Greška: {String(error)}</div>;

  if (layout === "combined") {
    // u Combined: bez desnog panela, uzmi top 3 po confidence
    const top3 = byConfidence.slice(0, 3);
    return (
      <div className="grid grid-cols-1 gap-4">
        {top3.map((p, i) => (
          <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
        ))}
      </div>
    );
  }

  // FOOTBALL TAB: 2 kolone (levo kartice sa tabovima, desno 3× market liste)
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center gap-2">
          {["kick", "conf", "hist"].map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={
                "px-4 py-2 rounded-full text-sm font-semibold transition " +
                (tab === k
                  ? "bg-white text-black"
                  : "bg-[#1f2339] text-slate-300 hover:bg-[#202542]")
              }
              type="button"
            >
              {k === "kick" ? "Kick-Off" : k === "conf" ? "Confidence" : "History (14d)"}
            </button>
          ))}
        </div>

        {tab === "kick" && (
          <div className="grid md:grid-cols-2 gap-4">
            {byKickoff.map((p, i) => (
              <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
            ))}
          </div>
        )}
        {tab === "conf" && (
          <div className="grid md:grid-cols-2 gap-4">
            {byConfidence.map((p, i) => (
              <Card key={`${p?.fixture_id ?? p?.id ?? i}`} p={p} />
            ))}
          </div>
        )}
        {tab === "hist" && (
          <div className="rounded-2xl p-4 border border-neutral-800 bg-neutral-900/60 text-sm opacity-80">
            History (14d) prikaz ostaje isti — puni se iz nightly procesa.
          </div>
        )}
      </div>

      <div className="lg:col-span-1">
        <RightPanel groups={marketGroups} />
      </div>
    </div>
  );
}
