// FILE: components/FootballBets.jsx
import React, { useContext, useMemo, useState } from "react";
import { DataContext } from "../contexts/DataContext";

// ---------- helpers ----------
function ccToFlag(cc){ const code=String(cc||"").toUpperCase(); if(!/^[A-Z]{2}$/.test(code)) return ""; return String.fromCodePoint(...[...code].map(c=>0x1f1e6+(c.charCodeAt(0)-65))); }
const NAME_TO_CC={ usa:"US","united states":"US",america:"US", iceland:"IS",japan:"JP",germany:"DE",england:"GB",scotland:"GB",wales:"GB","faroe-islands":"FO",denmark:"DK",sweden:"SE",norway:"NO",finland:"FI",portugal:"PT",spain:"ES",italy:"IT",france:"FR",netherlands:"NL",belgium:"BE",austria:"AT",switzerland:"CH",turkey:"TR",greece:"GR",serbia:"RS",croatia:"HR",slovenia:"SI",bosnia:"BA",montenegro:"ME","north macedonia":"MK",albania:"AL",mexico:"MX",nicaragua:"NI", bund:"DE",laliga:"ES",seriea:"IT",ligue:"FR",eredivisie:"NL",primeira:"PT",j1:"JP",urvalsdeild:"IS",meistaradeildin:"FO",usl:"US",mls:"US","mls next pro":"US",championship:"GB" };
function guessFlag(league={}){ const c=String(league.country||"").toLowerCase(); const n=String(league.name||"").toLowerCase(); for(const k of Object.keys(NAME_TO_CC)) if(c.includes(k)) return ccToFlag(NAME_TO_CC[k]); for(const k of Object.keys(NAME_TO_CC)) if(n.includes(k)) return ccToFlag(NAME_TO_CC[k]); return ""; }
function sanitizeIso(s){ if(!s||typeof s!=="string") return null; let iso=s.trim().replace(" ","T"); iso=iso.replace("+00:00Z","Z").replace("Z+00:00","Z"); return iso; }
function extractKickoffISO(v){ const dt=v?.datetime_local?.starting_at?.date_time||v?.datetime_local?.date_time||v?.time?.starting_at?.date_time||v?.kickoff||null; return sanitizeIso(dt); }
function toBelgradeHM(iso){ try{ const d=new Date(iso); if(isNaN(d)) return "—"; return d.toLocaleString("sr-RS",{timeZone:"Europe/Belgrade",hour12:false,hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});}catch{return "—";} }
function fmtOdds(x){ return typeof x==="number"&&isFinite(x)?x.toFixed(2):"—"; }
function bucket(conf){ const c=typeof conf==="number"?conf:0; if(c>=90) return {text:"Top Pick",cls:"text-orange-400"}; if(c>=75) return {text:"High",cls:"text-emerald-400"}; if(c>=50) return {text:"Moderate",cls:"text-sky-400"}; return {text:"Low",cls:"text-amber-400"}; }
function Badge({children,className=""}){ return <span className={`px-2 py-1 rounded-full border border-white/10 text-xs text-slate-300 ${className}`}>{children}</span>; }

function InfoDot({ text }) {
  if (!text) return null;
  return (
    <div className="relative group inline-flex items-center">
      <span className="ml-2 w-4 h-4 rounded-full bg-white/10 text-xs leading-4 text-slate-200 inline-flex items-center justify-center select-none">i</span>
      <div className="absolute z-10 hidden group-hover:block top-5 right-0 w-64 bg-[#1f2339] text-slate-200 text-xs p-3 rounded-xl border border-white/10 shadow">
        {text}
      </div>
    </div>
  );
}

function MarketAndSelection({ v, home, away }){
  const label = v?.market_label || v?.market || "—";
  const sel = String(v?.selection || "—");
  // Prijateljski prikaz za 1X2
  if ((v?.market||"").toUpperCase() === "1X2") {
    let pick = sel;
    if (sel === "1") pick = `${home} (1)`;
    else if (sel === "2") pick = `${away} (2)`;
    else if (sel.toUpperCase() === "X") pick = "Draw (X)";
    return (<><span className="text-white font-bold">{pick}</span> <span className="text-slate-400">[{label}]</span></>);
  }
  // ostala tržišta (BTTS, OU)
  return (<><span className="text-white font-bold">{label}: {sel}</span></>);
}

// ---------- Card ----------
function FootballCard({ v, layout="full" }){
  const league=v?.league||{};
  const home=v?.teams?.home?.name||"Home";
  const away=v?.teams?.away?.name||"Away";
  const iso=extractKickoffISO(v);
  const when=iso?toBelgradeHM(iso):"—";
  const flag=guessFlag(league);

  const confPct=Math.max(0,Math.min(100,v?.confidence_pct??0));
  const b=bucket(confPct);
  const odds=Number.isFinite(v?.market_odds)?v.market_odds:null;

  const minH = layout==="combined" ? "min-h-[220px] md:min-h-[240px]" : "min-h-[180px]";
  const [open,setOpen]=useState(false);
  const summary=v?.explain?.summary||"";
  const bullets=Array.isArray(v?.explain?.bullets)?v.explain.bullets:[];

  const formText = (v?.form_text && v.form_text.trim() && v.form_text.trim() !== "vs") ? v.form_text : "";

  return (
    <div className={`w-full bg-[#1f2339] p-5 rounded-2xl shadow flex flex-col ${minH}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">{flag}</span>
          <div className="text-sm text-slate-300">
            <div className="font-semibold text-white">{league?.name||"League"}</div>
            <div className="text-slate-400">{when} (Beograd)</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {v?.lineups_status==="confirmed" && <Badge className="text-emerald-300">Lineups: Confirmed</Badge>}
          {v?.lineups_status==="expected" && <Badge>Lineups: Expected</Badge>}
          {Number.isFinite(v?.injuries_count)&&v.injuries_count>0 && <Badge>INJ: {v.injuries_count}</Badge>}
        </div>
      </div>

      {/* Timovi */}
      <div className="mt-3 text-lg font-semibold">
        {home} <span className="text-slate-400">vs</span> {away}
      </div>

      {/* Predlog / kvota / edge / move */}
      <div className="mt-2 text-sm flex flex-wrap items-center gap-3">
        <div>Pick: <MarketAndSelection v={v} home={home} away={away} /></div>
        <div className="text-slate-300">Odds: <span className="font-semibold">{fmtOdds(odds)}</span></div>
        {Number.isFinite(v?.edge_pp) && <div className="text-slate-300">Edge: <span className={v.edge_pp>=0?"text-emerald-300":"text-rose-300"}>{v.edge_pp.toFixed(1)}pp</span></div>}
        {Number.isFinite(v?.movement_pct)&&v.movement_pct!==0 && <div className="text-slate-300">Move: <span className={v.movement_pct>=0?"text-emerald-300":"text-rose-300"}>{v.movement_pct>0?"↑":"↓"} {Math.abs(v.movement_pct).toFixed(2)}pp</span></div>}
        {layout==="combined" && summary && <InfoDot text={summary} />}
      </div>

      {/* Confidence */}
      <div className="mt-3">
        <div className="text-xs text-gray-400 mb-1">Confidence</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
            <div className="h-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400" style={{width:`${confPct}%`}} />
          </div>
          <span className="text-xs text-gray-300">{confPct}%</span>
        </div>
        <div className="mt-1 text-[12px] text-slate-300 flex items-center gap-2">
          <span className={b.cls}>●</span>
          <span className="text-slate-200">{b.text}</span>
          {formText ? <span className="text-slate-400">· {formText}</span> : null}
        </div>
      </div>

      {/* H2H */}
      {v?.h2h_summary && v.h2h_summary.trim() && (
        <div className="mt-2 text-[11px] text-slate-400">H2H: {v.h2h_summary}</div>
      )}

      {/* Why this pick (samo u Football tabu) */}
      {layout==="full" && (summary || bullets.length>0) && (
        <div className="mt-3">
          <button onClick={()=>setOpen(x=>!x)} className="text-xs text-slate-300 underline underline-offset-2" type="button">
            {open ? "Hide details" : "Why this pick"}
          </button>
          {open && (
            <div className="mt-2 text-sm text-slate-300">
              {summary && <div className="mb-1">{summary}</div>}
              {bullets.length>0 && <ul className="list-disc pl-5 space-y-1">{bullets.map((b,i)=><li key={i}>{b}</li>)}</ul>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function sortValueBets(bets=[]){
  return bets.slice().sort((a,b)=>{
    if(a.type!==b.type) return a.type==="MODEL+ODDS"?-1:1;
    if((b._score??0)!==(a._score??0)) return (b._score??0)-(a._score??0);
    const eA = Number.isFinite(a.edge_pp) ? a.edge_pp : -999;
    const eB = Number.isFinite(b.edge_pp) ? b.edge_pp : -999;
    return eB - eA;
  });
}

export default function FootballBets({ limit=10, layout="full" }){
  const { football=[], loadingFootball } = useContext(DataContext) || {};
  const list = useMemo(()=>{
    const base=Array.isArray(football)?football:[];
    const sorted=sortValueBets(base);
    return typeof limit==="number"?sorted.slice(0,limit):sorted;
  },[football,limit]);

  if(loadingFootball) return <div className="text-slate-400 text-sm">Loading football picks…</div>;
  if(!list.length) return <div className="text-slate-400 text-sm">No football suggestions at the moment.</div>;

  if(layout==="combined"){
    return (
      <div className="grid grid-cols-1 gap-4 items-stretch">
        {list.map(v=>(
          <FootballCard key={v?.fixture_id || `${v?.league?.id}-${v?.teams?.home?.name}-${v?.teams?.away?.name}`} v={v} layout="combined" />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {list.map(v=>(
        <FootballCard key={v?.fixture_id || `${v?.league?.id}-${v?.teams?.home?.name}-${v?.teams?.away?.name}`} v={v} layout="full" />
      ))}
    </div>
  );
}
