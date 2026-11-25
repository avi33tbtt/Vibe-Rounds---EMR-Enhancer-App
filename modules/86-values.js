// R0e-4: values (server observations as a view; B3b-2 and B3b-3), moved unchanged from the inline script.
// Top-level constants are plain values or arrows (nothing here runs at load); page state (CASE, Srv) stays in the page and is used only when a function runs.
/* ---------- Values (B3b-2) ----------
   Signed in, a value is a server observation: every entry is a new row typed against the PINNED set version, with the time it was true (effective, set to now here)
   and the time it was recorded (set by the server). Nothing is overwritten. CASE.values is only a VIEW built from the server rows (valuesRebuild), never saved
   in the browser. Keys are per set ('<set id>:<field id>'), so two sets that share a field id keep separate values. A scalar shows its latest value by effective time;
   a repeating field lists every row, newest first. Derived fields (balance) are computed here and never sent. Signed out, the old local keys (field id) apply.
   Rows are never removed (chunk 8f): a wrong row is marked entered_in_error and stays; allRows = everything stored, getRows = rows still in use. */
const vkey=(a,fid)=>a&&a.srvAs?a.srvSet+':'+fid:fid;
const pad2=n=>String(n).padStart(2,'0');
const localDT=iso=>{const d=new Date(iso);return isNaN(d)?'':`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`};
const fmtT=t=>{const x=String(t||'');return /(Z|[+-]\d\d:\d\d)$/.test(x)?localDT(x).replace('T',' '):x};
const srvCase=()=>srvMode()&&!!CASE.serverId;
const dispVal=(f,v)=>f.type==='boolean'?(v===true?'Yes':'No'):f.type==='datetime'?localDT(v):String(v);
function valuesRebuild(c){
  const vals={},meta={},unk={},badv={},sets=new Map();
  (c.applied||[]).forEach(a=>{if(a.srvAs&&!sets.has(a.srvSet))sets.set(a.srvSet,{a,s:resolve(a)})});
  (c.obs||[]).filter(o=>o.corrected_by_id==null).sort((x,y)=>Date.parse(x.effective_at)-Date.parse(y.effective_at)||x.id-y.id).forEach(o=>{
    const e=sets.get(String(o.element_set_id)),f=e&&e.s&&(e.s.fields||[]).find(x=>x.id===o.field_key);if(!f)return;
    const k=vkey(e.a,f.id),bad=o.status==='entered_in_error';
    if(f.repeat){   // an explicitly unknown row has no value to list
      if(o.value_type==='unknown')return;
      (vals[k]=vals[k]||[]).unshift({id:o.id,ts:o.effective_at,value:dispVal(f,o.value),rec:o.recorded_at,by:o.recorded_by,...(bad?{status:'entered_in_error',errorBy:o.error_by,errorAt:o.error_at,errorReason:o.error_reason}:{})});
      return;
    }
    if(bad){(badv[k]=badv[k]||[]).unshift({id:o.id,ts:o.effective_at,value:o.value_type==='unknown'?'':dispVal(f,o.value),unknown:o.value_type==='unknown',rec:o.recorded_at,by:o.recorded_by,errorBy:o.error_by,errorAt:o.error_at,errorReason:o.error_reason});return}
    unk[k]=o.value_type==='unknown';vals[k]=unk[k]?'':dispVal(f,o.value);meta[k]={id:o.id,eff:o.effective_at,rec:o.recorded_at,by:o.recorded_by};
  });
  sets.forEach(({a,s})=>{const ids=(s.fields||[]).map(f=>f.id);
    if((s.fields||[]).some(f=>f.id==='balance'&&f.derived)&&ids.includes('intake')&&ids.includes('output'))
      vals[vkey(a,'balance')]=String((parseFloat(vals[vkey(a,'intake')])||0)-(parseFloat(vals[vkey(a,'output')])||0))});
  c.values=vals;c.vmeta=meta;c.vunk=unk;c.vbad=badv;
}
function toTyped(f,raw){   // the page checks the type first; the server checks it again against the pinned version
  const x=String(raw==null?'':raw),t=f.type;
  if(!x.trim())return{err:'Enter a value, or choose Unknown. A blank is not stored.'};
  if(t==='number'||t==='integer'){
    if(!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(x.trim()))return{err:'Enter a number.'};
    const n=Number(x);if(!Number.isFinite(n)||(t==='integer'&&!Number.isSafeInteger(n)))return{err:t==='integer'?'Enter a whole number.':'Enter a number.'};
    return{v:n};
  }
  if(t==='boolean')return x==='Yes'?{v:true}:x==='No'?{v:false}:{err:'Choose Yes or No.'};
  if(t==='select')return(f.options||[]).includes(x)?{v:x}:{err:'Choose one of the listed options.'};
  if(t==='datetime'){const d=new Date(x);return isNaN(d)?{err:'Enter a valid date and time.'}:{v:d.toISOString()}}
  if(t==='text')return{v:x.trim()};
  return{err:`Fields of type ${t} cannot hold a value here.`};
}
const OBS_BUSY=new Set();
async function obsSave(fid,raw,asetId,unknown){
  const c=CASE,a=(c.applied||[]).find(x=>x.setId===asetId&&x.srvAs),f=a&&((resolve(a)||{}).fields||[]).find(x=>x.id===fid);
  if(!f){toast('That field is not in an applied set of this case. Open the case again.');return renderForms()}
  if(f.derived)return;
  if(!srvCan('cases:write')){toast('Your role cannot record values.');return renderForms()}
  if(c.pinsOk!==true){toast('The case is not fully loaded. Open it again.');return renderForms()}
  const it={appliedSetId:Number(a.srvAs),fieldKey:fid,effectiveAt:nowISO(),sourceType:'clinician'};
  if(unknown)it.unknown=true;else{const t=toTyped(f,raw);if(t.err){toast(t.err);return renderForms()}it.value=t.v}
  const key=vkey(a,fid);if(OBS_BUSY.has(key))return;OBS_BUSY.add(key);
  try{
    const r=await api('POST','/api/cases/'+c.serverId+'/observations',{observations:[it]});
    if(r.status===201){c.obs=(c.obs||[]).concat(r.body.observations);valuesRebuild(c);toast(unknown?'Recorded as unknown':'Recorded')}
    else toast(apiMsg(r));
  }finally{OBS_BUSY.delete(key)}
  if(c===CASE)renderForms();
}
let SHOW_ERR=false;
const rowBad=r=>!!r&&r.status==='entered_in_error';
function allRows(fid,a){
  const v=CASE.values[vkey(a,fid)];
  return Array.isArray(v)?v:[];
}
const getRows=(fid,a)=>allRows(fid,a).filter(r=>!rowBad(r));
function setRows(fid,rows){CASE.values[fid]=rows;save()}
function addRow(fid,val,asetId){
  if(srvCase())return obsSave(fid,val,asetId);
  const rows=allRows(fid);
  rows.unshift({ts:new Date().toISOString().slice(0,16),value:val});
  setRows(fid,rows);renderForms();
}
const OBS_ERR=new Set();
async function obsError(id){   // B3b-3: the row stays on the server (struck through here); who and when come from the session, the reason is required
  const c=CASE;if(!id)return;
  if(!srvCan('cases:write'))return toast('Your role cannot change cases.');
  if(OBS_ERR.has(id))return;
  const reason=String(prompt('Why was this entry made in error? The reason is required and is kept with the row.')||'').trim();
  if(!reason)return toast('No reason given: nothing was changed.');
  OBS_ERR.add(id);
  try{
    const r=await api('POST','/api/observations/'+id+'/entered-in-error',{reason});
    if(r.status===200){c.obs=(c.obs||[]).map(o=>o.id===r.body.observation.id?r.body.observation:o);valuesRebuild(c);toast('Marked as entered in error')}
    else{toast(apiMsg(r));await pinsLoad(c)}
  }finally{OBS_ERR.delete(id)}
  if(c===CASE)renderForms();
}
function markRowError(fid,idx,asetId){
  if(srvCase()){const a=(CASE.applied||[]).find(x=>x.setId===asetId&&x.srvAs),r=allRows(fid,a)[idx];return r&&!rowBad(r)?obsError(r.id):undefined}
  if(!user())return toast('Sign in to mark an entry as an error');
  const r=allRows(fid)[idx];if(!r||rowBad(r))return;
  if(!confirm('Mark this entry as entered in error? It is kept, shown struck through, and exported as entered-in-error.'))return;
  r.status='entered_in_error';r.errorBy=user();r.errorAt=nowISO();save();renderForms();toast('Marked as entered in error');
}
function markValError(fid,asetId){const a=(CASE.applied||[]).find(x=>x.setId===asetId&&x.srvAs),m=a&&(CASE.vmeta||{})[vkey(a,fid)];if(m)return obsError(m.id)}
function setVal(id,val,asetId){
  if(srvCase())return obsSave(id,val,asetId);
  CASE.values[id]=val;
  if(id==='intake'||id==='output'){
    const inn=parseFloat(CASE.values.intake)||0,out=parseFloat(CASE.values.output)||0;
    CASE.values.balance=String(inn-out);
    const el=$('f_balance');if(el)el.value=CASE.values.balance;
  }
  save();
}
