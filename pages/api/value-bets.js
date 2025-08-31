// pages/api/value-bets.js
// KV-only mirror (ako negde front i dalje pogađa /api/value-bets). Bez bilo kakvih spoljnih poziva.

export const config = { runtime: "nodejs" };

const TZ="Europe/Belgrade";
const KV_URL=process.env.KV_REST_API_URL;
const KV_RO=process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_RW=process.env.KV_REST_API_TOKEN||KV_RO;

async function kvGet(k){
  if(!KV_URL||(!KV_RW&&!KV_RO))return null;
  const t=KV_RO||KV_RW;
  try{
    const r=await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${t}`},cache:"no-store"});
    if(!r.ok)return null;const j=await r.json().catch(()=>null);if(!j||typeof j.result==="undefined")return null;
    try{return JSON.parse(j.result);}catch{return j.result;}
  }catch{return null;}
}
function ymdInTZ(d=new Date(),tz=TZ){const f=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"});return f.format(d);}
function hourInTZ(d=new Date(),tz=TZ){const f=new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour:"2-digit",hour12:false});return Number(f.formatToParts(d).find(p=>p.type==="hour").value);}
function autoSlot(tz=TZ){const h=hourInTZ(new Date(),tz);if(h<10)return"late";if(h<15)return"am";return"pm";}
function labelFor(k){return k==="1"?"Home":k==="2"?"Away":k==="X"?"Draw":String(k||"");}
function normalize(it){
  const raw=it?.pick;let code=it?.pick_code;let s="";
  if(typeof raw==="string"){s=["1","X","2"].includes(raw)?labelFor(raw):raw;}
  else if(raw&&typeof raw==="object"){code=code||raw.code;s=raw.label||it?.selection_label||labelFor(code);}
  else{s=it?.selection_label||labelFor(code);}
  const home=it.home||it?.teams?.home||"";const away=it.away||it?.teams?.away||"";
  return {...it,pick:s,selection:s,home,away};
}
export default async function handler(req,res){
  const qslot=String(req.query.slot||"").toLowerCase();
  const slot=["am","pm","late"].includes(qslot)?qslot:autoSlot();
  const ymd=ymdInTZ();
  const full=await kvGet(`vbl_full:${ymd}:${slot}`); const slim=await kvGet(`vbl:${ymd}:${slot}`);
  const base=Array.isArray(slim)?slim:(Array.isArray(full)?full:[]);
  const items=(base||[]).map(normalize);
  return res.status(200).json({ ok:true, slot, value_bets:items, source:`kv:${items.length?"hit":"miss"}` });
}
