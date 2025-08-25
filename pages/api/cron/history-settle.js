// FILE: pages/api/cron/history-settle.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
async function kvSET(key, value){
  return fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  }).then(r=>r.ok);
}
function parseArr(raw){
  try{
    let v = raw;
    if (typeof v==="string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v==="object"){
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v){
        const inner=v.value;
        if (typeof inner==="string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}
function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(d);
}

export default async function handler(req, res){
  try{
    // zadnjih 14 dana iz indexa (ako ga nema, generiši)
    let days = parseArr(await kvGET(`hist:index`));
    if (!days.length){
      const tmp=[];
      for (let i=0;i<14;i++){
        const d=new Date(); d.setDate(d.getDate()-i);
        tmp.push( ymdInTZ(d, TZ) );
      }
      days = tmp;
    }

    const settled = [];
    for (const ymd of days){
      const am   = parseArr(await kvGET(`hist:${ymd}:am`));
      const pm   = parseArr(await kvGET(`hist:${ymd}:pm`));
      const late = parseArr(await kvGET(`hist:${ymd}:late`));

      for (const it of [...am, ...pm, ...late]){
        // očekujemo da negde drugi proces upisuje rezultat (won/final_score);
        // ovde samo skupljamo završene
        const finished = it?.status === "finished" || !!it?.score?.ft || !!it?.final_score;
        if (finished){
          settled.push(it);
        }
      }
    }

    await kvSET(`vb:history:settled`, settled);

    return res.status(200).json({ ok:true, settled_count: settled.length });
  } catch (e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
