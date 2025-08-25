'use client';
import React from 'react';

function colorFor(p){ const c=Number(p||0); if(c<50) return '#f59e0b'; if(c<75) return '#0ea5e9'; return '#10b981'; }
function Bar({v}){ const pct=Math.max(0,Math.min(100,Number(v||0))); return(
  <div style={{width:'100%',height:8,background:'#e5e7eb',borderRadius:6,position:'relative'}}>
    <div style={{width:`${pct}%`,height:8,background:colorFor(pct),borderRadius:6}}/>
    <div style={{position:'absolute',top:-18,right:0,fontSize:12,fontWeight:600}}>{pct}%</div>
  </div>
);}

function Row({it}){
  const ko = it?.ko_local || '—';
  const odds = Number(it?.market_odds||0);
  return (
    <div className="grid grid-cols-12 items-center gap-3 py-2 border-b border-gray-800/30">
      <div className="col-span-2 text-sm text-gray-400">{ko}</div>
      <div className="col-span-5">
        <div className="text-sm font-medium text-white">{it?.teams?.home?.name} vs {it?.teams?.away?.name}</div>
        <div className="text-xs text-gray-500">{it?.league?.name}</div>
      </div>
      <div className="col-span-3 text-sm text-gray-300">
        {it?.market} — {it?.selection} {odds?`@ ${odds.toFixed(2)}`:''}
      </div>
      <div className="col-span-2"><Bar v={it?.confidence_pct}/></div>
    </div>
  );
}

export default function FootballBets(){
  const [tab,setTab]=React.useState('kickoff'); // 'kickoff' | 'confidence'
  const [items,setItems]=React.useState([]);
  const [meta,setMeta]=React.useState({slot:null,built_at:null});

  React.useEffect(()=>{
    let on=true;
    fetch('/api/value-bets-locked',{cache:'no-store'})
      .then(r=>r.json()).then(j=>{ if(!on) return; setItems(Array.isArray(j?.items)?j.items:[]); setMeta({slot:j?.slot||null,built_at:j?.built_at||null}); })
      .catch(()=>{});
    return ()=>{on=false};
  },[]);

  const data = (items||[]).slice().sort((a,b)=>{
    if (tab==='confidence'){
      const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
      if (cb!==ca) return cb-ca;
    }
    const ta=+new Date(String(a?.datetime_local?.starting_at?.date_time || a?.ko || 0).replace(' ','T'));
    const tb=+new Date(String(b?.datetime_local?.starting_at?.date_time || b?.ko || 0).replace(' ','T'));
    return ta-tb; // kickoff
  });

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm text-gray-300">Football · slot: <b>{meta.slot||'—'}</b> {meta.built_at?`· built ${new Date(meta.built_at).toLocaleTimeString('sr-RS')}`:''}</div>
        <div className="flex gap-2">
          <button onClick={()=>setTab('kickoff')} className={`px-3 py-1 rounded-full text-sm ${tab==='kickoff'?'bg-white text-black':'bg-gray-700 text-gray-200'}`}>Kick-off</button>
          <button onClick={()=>setTab('confidence')} className={`px-3 py-1 rounded-full text-sm ${tab==='confidence'?'bg-white text-black':'bg-gray-700 text-gray-200'}`}>Confidence</button>
        </div>
      </div>
      <div className="rounded-2xl border border-gray-800/30 overflow-hidden">
        {data.length===0 ? <div className="p-4 text-sm text-gray-400">Nema stavki za trenutni slot.</div>
          : data.map((it)=> <Row key={`${it.fixture_id}|${it.market}|${it.selection}`} it={it}/>)}
      </div>
    </div>
  );
}
