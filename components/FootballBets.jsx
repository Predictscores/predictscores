// components/FootballBets.js  (samo deo "Why" je drugačiji; ostalo ostaje isto)
import React, { useEffect, useMemo, useState } from "react";
import Tabs from "./Tabs";

/* ================= helpers ================= */
function safeJson(url) {
  return fetch(url, { cache: "no-store" }).then((r) => r.json());
}
function koISO(p) { /* ... (tvoj postojeći kod) ... */ }
function koDate(p) { const s = koISO(p); return s ? new Date(s) : null; }
function conf(p) { const x = Number(p?.confidence_pct || 0); return Number.isFinite(x) ? x : 0; }
function ev(p) { const x = Number(p?.ev || 0); return Number.isFinite(x) ? x : -999; }
function oddsOf(p) { const x = Number(p?.market_odds || p?.odds || 0); return Number.isFinite(x) ? x : null; }
function marketOf(p) { return String(p?.market_label || p?.market || "").toUpperCase(); }
function isBTTS1H(p) { return /BTTS\s*1H/i.test(String(p?.market_label || p?.market || "")); }
function isBTTS(p) { return /BTTS/i.test(String(p?.market_label || p?.market || "")); }
function isOU(p) { return /^OU$|OVER\/UNDER|OVER\s*2\.?5/i.test(String(p?.market_label || p?.market || "")); }

// ... sve tvoje postojeće pomoćne funkcije, Ticket blok, Card, History, itd. ...

/* ================= “Zašto” (tačno 2 reda) ================= */
function Why({ p }) {
  const rawBullets = Array.isArray(p?.explain?.bullets) ? p.explain.bullets : [];
  const summary = p?.explain?.summary || "";
  // Prikaži najviše 2 linije, bez tačkica — "Zašto:" i "Forma/H2H"
  const bullets = rawBullets.slice(0, 2);
  if (bullets.length) {
    return (
      <div className="mt-1 text-slate-300 space-y-0.5">
        {bullets.map((b, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: b }} />
        ))}
      </div>
    );
  }
  return summary ? <div className="mt-1 text-slate-300">Zašto: {summary}</div> : null;
}

/* ================= singl kartica ================= */
// ... (ostatak tvog postojećeg fajla bez izmena) ...
