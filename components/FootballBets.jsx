// components/FootballBets.jsx
"use client";

import { useEffect, useMemo, useState } from "react";

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
function currentSlot(tz = TZ){
  const h = Number(new Intl.DateTimeFormat("en-GB",{hour:"2-digit",hour12:false,timeZone:tz}).format(new Date()));
  return h < 12 ? "am" : h < 20 ? "pm" : "late";
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
      const r = await fetch(`/api/value-bets-locked?slot=${slot}`, { cache: "no-store" });
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

      if (!arr.length){
        const r2 = await fetch(`/api/football?slot=${slot}&norebuild=1`, { cache: "no-store" });
        const ct2 = r2.headers.get("content-type") || "";
        const j2 = ct2.includes("application/json") ? await r2.json() : {};
        const fb = Array.isArray(j2?.football) ? j2.football : Array.isArray(j2) ? j2 : [];
        setItems(fb);
      } else {
        setItems(arr);
      }
    } catch (e) {
      setError(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { items, loading, error, reload: load };
}

/* ===================== present ===================== */
function keyOf(p, i) {
  const fid = p?.fixture_id ?? p?.id ?? i;
  const sel = p?.selection ?? "";
  const iso = String(
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.kickoff ||
    ""
  ).replace(" ", "T");
  return `${fid}-${sel}-${iso}`;
}
function getKOISO(p) {
  const raw =
    p?.datetime_local?.starting_at?.date_time ||
    p?.datetime_local?.date_time ||
    p?.kickoff ||
    "";
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
  const zasto = whyList.slice(0, 2).join(" · ");

  // 2) Forma/H2H — spajaj u jednu liniju
  const formaLine = bullets.find((b) => /^forma:/i.test((b || "").trim())) || null;
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
  // koristi league.flag ili league.country_code; fallback: nema zastavice
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

/* ===================== UI ===================== */
function Row({ p }) {
  const league = p?.league?.name || p?.league_name || "";
  const flag = flagFromLeague(p?.league);
  const home = p?.teams?.home?.name || p?.teams?.home || p?.home || "";
  const away = p?.teams?.away?.name || p?.teams?.away || p?.away || "";
  const ko = koCET(p);
  const market = p?.market_label || p?.market || "";
  const sel = p?.selection || "";
  const price = p?.market_odds ?? p?.odds ?? p?.price;
  const conf = pct(p?.confidence_pct || p?.model_prob);

  return (
    <div className="p-3 rounded-xl bg-[#1f2339]">
      <div className="text-xs text-slate-400 mb-0.5">
        {league} {flag ? `• ${flag}` : ""} • {ko}
      </div>
      <div className="font-medium">{home} vs {away}</div>
      <div className="text-sm opacity-90">
        {market}: <b>{sel}</b>{price ? ` (${Number(price).toFixed(2)})` : ""}
        {Number.isFinite(conf) ? ` • Conf ${conf}%` : ""}
      </div>
      <div className="text-xs text-slate-400 whitespace-pre-line mt-1">
        {whyText2lines(p)}
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
          {rows.map((p, i) => <Row key={keyOf(p, i)} p={p} />)}
        </div>
      )}
    </div>
  );
}

function RightPanel({ groups }) {
  return (
    <div className="rounded-2xl bg-[#15182a] p-4">
      <div className="text-base font-semibold text-white mb-3">Top lige</div>
      {["BTTS","OU 2.5","HT-FT","1X2"].map((cat) => {
        const list = groups[cat] || [];
        return (
          <div key={cat} className="mb-4">
            <div className="text-sm font-semibold text-white mb-2">{cat} (3)</div>
            {!list.length ? (
              <div className="text-slate-400 text-sm">Nema kandidata.</div>
            ) : (
              <div className="space-y-2">
                {list.map((p, i) => {
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
      })}
    </div>
  );
}

export default function FootballBets() {
  const { items, loading, error, reload } = useLockedValueBets();

  const marketGroups = useMemo(() => {
    const res = { "BTTS": [], "OU 2.5": [], "HT-FT": [], "1X2": [] };
    for (const it of items) {
      const m = String(it?.market_label || it?.market || "").toUpperCase();
      if (m.includes("BTTS")) res["BTTS"].push(it);
      else if (m.includes("OVER") || m.includes("UNDER") || m.includes("OU 2.5")) res["OU 2.5"].push(it);
      else if (m.includes("HT-FT") || m.includes("HT/FT")) res["HT-FT"].push(it);
      else if (m.includes("1X2") || m === "1X2" || m.includes("MATCH WINNER")) res["1X2"].push(it);
    }
    for (const k of Object.keys(res)) res[k] = res[k].slice(0, 9); // do 9 kartica po marketu
    return res;
  }, [items]);

  const [tab, setTab] = useState("ko"); // ko | conf | hist

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        {tab === "ko" && (
          <Section title="Kick-Off" rows={items} />
        )}
        {tab === "conf" && (
          <Section title="Confidence" rows={items} />
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
