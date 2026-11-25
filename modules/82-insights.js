// R0e-2: the CCIS insights panel (DM2b), moved unchanged from the inline script.
// Top-level constants are plain values or arrows (nothing here runs at load); page state (CASE, Srv, Store) stays in the page and is used only when a function runs.
/* DM2b: CCIS insights. Run records imported for the open case, shown exactly as stored. Nothing is kept in the browser and no result is edited here.
   Every piece of text, including warnings and limitations written by another program, goes through escA. */
const CCIS={caseId:null,ok:false,runs:[],open:null};
async function ccisLoad(c,openId){
  CCIS.caseId=c.serverId||null;CCIS.runs=[];CCIS.ok=false;CCIS.open=openId||null;
  if(!c.serverId||!srvCan('ccis:read'))return;
  const r=await api('GET','/api/cases/'+c.serverId+'/ccis-runs');
  if(CCIS.caseId!==c.serverId)return;   // another case was opened meanwhile
  if(r.status===200){CCIS.runs=r.body.runs;CCIS.ok=true}else toast(apiMsg(r));
}
const ccisTime=t=>String(t||'').slice(0,16).replace('T',' ');
function ccisValue(r){
  if(r.state!==undefined)return r.state==='parameter-not-enabled'?'Not enabled'+(r.dependsOnParameters?' (needs parameter: '+r.dependsOnParameters.join(', ')+')':''):String(r.state).replace(/-/g,' ');
  const v=r.value||{};
  if(r.kind==='classification')return String(v.label);
  if(v.time)return String(v.time.value||v.time.state||'')+(v.time.zone?' (zone: '+v.time.zone+')':'');
  return v.amount+' '+v.unit;
}
const ccisList=(t,a)=>a&&a.length?`<div class="mu">${escA(t)}: ${a.map(escA).join('; ')}</div>`:'';
function ccisResult(r){
  const tbl=r.kind==='table'&&r.value&&r.state===undefined
    ?`<div style="overflow-x:auto"><table style="font-size:12px;border-collapse:collapse"><tr>${r.value.columns.map(x=>`<th style="text-align:left;padding:2px 8px">${escA(x)}</th>`).join('')}</tr>${r.value.rows.map(row=>`<tr>${row.map(x=>`<td style="padding:2px 8px">${escA(x)}</td>`).join('')}</tr>`).join('')}</table></div>`:'';
  return`<div style="margin:4px 0"><b>${escA(r.outputId)}</b>: ${tbl||escA(ccisValue(r))}${ccisList('Warnings',r.warnings).replace('class="mu"','class="gen-warn"')}${ccisList('Limitations',r.limitations)}${ccisList('Missing data',r.missingDataNotes)}</div>`;
}
function ccisDetail(run){
  const rec=run.run_record,params=rec.parameters||[],anyOn=params.some(p=>p.enabled);
  const byKind=['value','classification','table'].map(k=>{
    const rs=(rec.results||[]).filter(r=>r.kind===k);
    return rs.length?`<div style="margin-top:6px"><span class="mu">${escA(k)} outputs</span>${rs.map(ccisResult).join('')}</div>`:'';
  }).join('');
  const failure=rec.failure?`<div class="gen-warn">This run failed (${escA(rec.failure.rule)}): ${escA(rec.failure.message)}. No result was produced.</div>`:'';
  const ps=params.map(p=>`<div class="mu">${escA(p.id)}: ${p.enabled?'enabled, value '+escA(Array.isArray(p.value)?p.value.join(', '):p.value)+(p.units?' '+escA(p.units):'')+', supplied by '+escA(p.suppliedBy):'disabled'}</div>`).join('');
  return(anyOn?'<div class="gen-warn"><b>Demo parameters are test-only placeholders, not clinical values.</b></div>':'')+failure+byKind
    +`<div style="margin-top:6px"><span class="mu">Parameters</span>${ps||'<div class="mu">none</div>'}</div>`
    +ccisList('Run warnings',rec.warnings)+ccisList('Run limitations',rec.limitations);
}
function ccisAckPart(run,arch){
  const mine=Srv.user&&run.acks.some(a=>a.acknowledged_by===Srv.user.username);
  const list=run.acks.map(a=>`<div class="mu">Acknowledged by ${escA(a.acknowledged_by)} at ${escA(ccisTime(a.acknowledged_at))}${a.note?': '+escA(a.note):''}</div>`).join('')||'<div class="mu">Not acknowledged yet. An acknowledgement says you have seen this run; it is not an approval of the result.</div>';
  const form=srvCan('ccis:ack')&&!arch&&!mine?`<div class="flex" style="margin-top:4px"><input id="ccis_note_${Number(run.id)}" maxlength="500" placeholder="Optional note" aria-label="Acknowledgement note" style="flex:1"><button class="b sm" data-act="ccisAck" data-arg="${Number(run.id)}">Acknowledge</button></div>`:'';
  return list+form;
}
function renderCcis(){
  const box=$('ccisBox');if(!box)return;
  const on=srvMode()&&!!CASE.serverId&&srvCan('ccis:read');box.style.display=on?'':'none';
  if(!on)return;
  if(CCIS.caseId!==CASE.serverId){ccisLoad(CASE).then(renderCcis);return}   // loaded once per opened case
  const arch=CASE.status==='archived';
  $('ccis_imp').style.display=srvCan('ccis:import')&&!arch?'':'none';
  $('ccisList').innerHTML=CCIS.runs.map(run=>{
    const rec=run.run_record,open=CCIS.open===run.id;
    return`<div class="cd"><div class="gen-warn">Synthetic data, prototype</div>
      <div><b>${escA(rec.package.id)}</b> v${escA(rec.package.version)} · engine ${escA(rec.engine.version)} · ${escA(rec.status)} · imported ${escA(ccisTime(run.imported_at))} by ${escA(run.imported_by)} · ${run.acks.length?'acknowledged by '+run.acks.length:'not acknowledged'}
      <button class="b sm sec" data-act="ccisToggle" data-arg="${Number(run.id)}">${open?'Close':'Open'}</button></div>
      ${open?ccisDetail(run)+ccisAckPart(run,arch):''}</div>`;
  }).join('')||`<div class="mu" style="margin-top:6px">${CCIS.ok?'No CCIS run has been imported for this case.':'The runs of this case could not be loaded.'}</div>`;
}
async function ccisImportText(text){
  const info=$('ccis_info');info.textContent='';
  const c=CASE;if(!c.serverId||!srvCan('ccis:import'))return;
  let rec;try{rec=JSON.parse(text)}catch(e){info.textContent='That file is not JSON.';return}
  if(!rec||typeof rec!=='object'||Array.isArray(rec)){info.textContent='That file is not a CCIS run record (a JSON object is expected).';return}
  const r=await api('POST','/api/cases/'+c.serverId+'/ccis-runs',rec);   // sent exactly as read: the page never edits a result
  if(r.status!==201&&r.status!==200){info.textContent=apiMsg(r)+(r.body.errors?' '+r.body.errors.slice(0,3).map(e=>e.path+' '+e.message).join('; '):'');return}
  await ccisLoad(c,r.body.run.id);renderCcis();
  info.textContent=r.body.alreadyImported?'This run record was already imported.':'Imported.';
}
function ccisPick(el){
  const f=el.files&&el.files[0];if(!f)return;
  if(f.size>2*1024*1024){$('ccis_info').textContent='That file is too large (2 MB at most).';el.value='';return}
  const rd=new FileReader();rd.onload=()=>{el.value='';ccisImportText(String(rd.result))};rd.readAsText(f);
}
async function ccisAck(id){
  const n=$('ccis_note_'+id),note=n?n.value.trim():'';
  const r=await api('POST','/api/ccis-runs/'+id+'/ack',note?{note}:{});
  if(r.status!==201){toast(apiMsg(r));return}
  await ccisLoad(CASE,id);renderCcis();toast('Acknowledged');
}
