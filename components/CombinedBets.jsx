'use client';
import React from 'react';

function colorFor(p){ const c=Number(p||0); if(c<50) return '#f59e0b'; if(c<75) return '#0ea5e9'; return '#10b981'; }
function Bar({v}){ const pct=Math.max(0,Math.min(100,Number(v||0))); return(
  <div style={{width:'100%',height:8,background:'#e5e7eb',borderRadius:6,position:'relative'}}>
    <div style={{width:`${pct}%`,height:8,background:colorFor(pct),borderRadius:6}}/>
    <div style={{position:'absolute',top:-18,right:0,fontSize:12,fontWeight:600}}>{pct}%</div>
  </div>
);}

function Card({it}){
  const ko = it?.ko_local || '—';
  const odds = Number(it?.market_odds||0);
  return (
    <div className="rounded-2xl shadow p-4 border border-gray-800/30 bg-[#0f172a] flex flex-col gap-2">
      <div className="text-sm text-gray-400">{ko} • {it?.league?.name||''}</div>
      <div className="text-base font-semibold text-white">{it?.teams?.home?.name} vs {it?.teams?.away?.name}</div>
      <div className="text-sm text-gray-300">{it?.market} — {it?.selection} {odds? <span className="text-gray-200">@ {odds.toFixed(2)}</span>:null}</div>
      <Bar v={it?.confidence_pct}/>
    </div>
  );
}

export default function CombinedBets(){
  const [football,setFootball]=React.useState([]);
  const [crypto,setCrypto]=React.useState([]);
  const [meta,setMeta]=React.useState({slot:null,built_at:null,nextKO:'—'});

  React.useEffect(()=>{
    let on=true;
    fetch('/api/value-bets-locked',{cache:'no-store'})
      .then(r=>r.json()).then(j=>{
        if(!on) return;
        const items=Array.isArray(j?.items)?j.items:[];
        setFootball(items);
        const times = items
          .map(it=> new Date(String(it?.datetime_local?.starting_at?.date_time || it?.ko || '').replace(' ','T')))
          .filter(t=>!isNaN(+t))
          .sort((a,b)=>a-b);
        const nextKO = times[0] ? new Intl.DateTimeFormat('sr-RS',{timeZone:'Europe/Belgrade',hour:'2-digit',minute:'2-digit'}).format(times[0]) : '—';
        setMeta({slot:j?.slot||null,built_at:j?.built_at||null,nextKO});
      }).catch(()=>{});
    fetch('/api/crypto-bets-locked',{cache:'no-store'})
      .then(r=>r.ok?r.json():Promise.resolve({items:[]})).then(j=>{ if(!on) return; setCrypto(Array.isArray(j?.items)?j.items:[]); })
      .catch(()=>setCrypto([]));
    return ()=>{on=false};
  },[]);

  const left = football.slice(0,3);
  const right = crypto.slice(0,3);

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="flex flex-col gap-3">
        <div className="text-sm text-gray-300">
          Football — slot: <b>{meta.slot||'—'}</b> {meta.built_at?`· built ${new Date(meta.built_at).toLocaleTimeString('sr-RS')}`:''} · Next kickoff: <b>{meta.nextKO}</b>
        </div>
        {left.length===0 ? <div className="text-sm text-gray-400">Nema stavki za ovaj slot.</div> : left.map((it)=> <Card key={`${it.fixture_id}|${it.market}|${it.selection}`} it={it}/>)}
      </div>
      <div className="flex flex-col gap-3">
        <div className="text-sm text-gray-300">Crypto</div>
        {right.length===0 ? <div className="text-sm text-gray-500">—</div> :
          right.map((it,idx)=>(
            <div key={idx} className="rounded-2xl shadow p-4 border border-gray-800/30 bg-[#0f172a]">
              <div className="text-base font-semibold text-white">{it?.symbol||it?.name}</div>
              <div className="text-sm text-gray-300">{it?.reason||''}</div>
            </div>
          ))}
      </div>
      <div className="col-span-2 text-xs text-gray-400 mt-2">
        Confidence legend: <span style={{color:'#10b981'}}>High (≥75%)</span> · <span style={{color:'#0ea5e9'}}>Moderate (50–75%)</span> · <span style={{color:'#f59e0b'}}>Low (&lt;50%)</span>
      </div>
    </div>
  );
}
