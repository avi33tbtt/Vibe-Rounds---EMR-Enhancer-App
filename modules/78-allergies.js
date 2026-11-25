// R3d: Allergies screen (patient allergy list: add, resolve, mark entered in error). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (status steps, stale versions, final rows); this page only shows the buttons the role may use and the
   server's own message when it refuses. Who and when are the server's values. All text is escaped. */
const ALGY={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},draft:{},form:{substance:'',reaction:'',severity:'',onset:''},formErr:''};
const ALGY_LBL={active:'active',resolved:'resolved',entered_in_error:'entered in error'};
const ALGY_PATH={resolve:'resolve',error:'entered-in-error'};
const ALGY_DONE={resolve:'Allergy resolved.',error:'Allergy marked as entered in error.'};
const ALGY_SEV=['mild','moderate','severe'];
const algyReset=()=>{ALGY.items=[];ALGY.pid=null;ALGY.msg='';ALGY.loaded=false;ALGY.err={};ALGY.draft={};ALGY.formErr=''};
function renderAllergiesNav(){
  const b=$('navAllergies');if(!b)return;
  const show=srvCan('allergies:read');b.style.display=show?'':'none';
  if(!show){algyReset();if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
async function allergiesLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('allergies:read')||!pid){algyReset();ALGY.pid=pid||null;return renderAllergies()}
  ALGY.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/allergies'+(ALGY.all?'?include=all':''));
  if(!srvCan('allergies:read')||!CASE||CASE.patientId!==pid)return;   // signed out or another patient opened meanwhile
  if(r.status!==200){ALGY.msg='The allergies could not be loaded: '+apiMsg(r);ALGY.items=[];ALGY.loaded=true;return renderAllergies()}
  ALGY.items=r.body.allergies||[];ALGY.msg='';ALGY.loaded=true;renderAllergies();
}
const algyKeep=()=>{[['af_substance','substance'],['af_reaction','reaction'],['af_severity','severity'],['af_onset','onset']].forEach(([i,k])=>{const e=$(i);if(e)ALGY.form[k]=e.value})};
function renderAllergies(){
  const box=$('allergiesBox');if(!box)return;
  if(!srvCan('allergies:read')){box.innerHTML='';return}
  algyKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='<div class="empty">Open a registered patient\'s case first (Patients tab). Allergies belong to the patient, not to one case.</div>';return}
  const f=ALGY.form,dis=ALGY.busy?' disabled':'';
  let h=`<div class="note">Allergy list of <b>${escA(caseName(CASE))}</b> (synthetic data only). An allergy is never deleted: resolve it, or mark it entered in error, each with a reason. Who and when are recorded by the server.${ALGY.msg?' '+escA(ALGY.msg):''}
    <label class="mu"><input type="checkbox" id="af_all" data-act="allergyAll" data-ev="change"${ALGY.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="allergyReload">Reload</button></div>`;
  if(srvCan('allergies:write'))h+=`<div class="cd"><b>Add an allergy</b> <span class="mu">(your own words; reaction, severity and onset date are optional)</span>
    <div class="field-row"><input id="af_substance" placeholder="substance, e.g. Penicillin" maxlength="200" value="${escA(f.substance)}" aria-label="Substance" style="flex:1.4">
    <input id="af_reaction" placeholder="reaction (optional)" maxlength="500" value="${escA(f.reaction)}" aria-label="Reaction (optional)" style="flex:1.4">
    <select id="af_severity" aria-label="Severity (optional)" style="flex:.6"><option value="">severity: not recorded</option>${ALGY_SEV.map(s=>`<option value="${s}"${f.severity===s?' selected':''}>${s}</option>`).join('')}</select>
    <input id="af_onset" type="date" value="${escA(f.onset)}" aria-label="Onset date (optional)" style="flex:.6"></div>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="allergyAdd"${dis}>Add allergy</button></div>${ALGY.formErr?`<div class="gen-warn">${escA(ALGY.formErr)}</div>`:''}</div>`;
  if(ALGY.loaded&&!ALGY.items.length&&!ALGY.msg)h+='<div class="empty">No allergies recorded for this patient.</div>';
  ALGY.items.forEach(p=>{
    const id=escA(p.id),st=p.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(p.substance)}</b> <span class="bd" style="background:var(${gone?'--r':st==='resolved'?'--g':'--a'})">${escA(ALGY_LBL[st]||st)}</span>${p.severity?` <span class="bd">${escA(p.severity)}</span>`:''}
      <div class="mu">Reaction ${p.reaction?escA(p.reaction):'not recorded'} · onset ${p.onset_date?escA(p.onset_date):'unknown'} · recorded by ${escA(p.recorded_by)} · ${escA(String(p.recorded_at||'').slice(0,16).replace('T',' '))}</div>`;
    if(st==='resolved'||gone){
      const who=gone?p.error_by:p.resolved_by,at=gone?p.error_at:p.resolved_at,why=gone?p.error_reason:p.resolution_reason;
      h+=`<div class="mu">${gone?'Marked in error':'Resolved'} by ${escA(who)} · ${escA(String(at||'').slice(0,16).replace('T',' '))}: ${escA(why)}</div>`;
    }
    if(gone)h+='<div class="mu">Final: an entry made in error is never changed.</div>';
    else if(srvCan('allergies:write'))h+=`<div style="margin-top:6px"><textarea id="ar_${id}" rows="2" maxlength="1000" placeholder="Reason (required, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(ALGY.draft[p.id]||'')}</textarea>
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="allergyResolve" data-arg="${id}"${dis}>Resolve</button> `:''}<button class="b sec sm" data-act="allergyError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change allergies.</div>';
    if(ALGY.err[p.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(ALGY.err[p.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function allergyAdd(){
  const pid=CASE&&CASE.patientId;
  if(ALGY.busy||!pid||!srvCan('allergies:write'))return;
  algyKeep();
  const f=ALGY.form,body={substance:f.substance.trim()};   // only these five fields are ever sent
  if(f.reaction.trim())body.reaction=f.reaction.trim();
  if(ALGY_SEV.includes(f.severity))body.severity=f.severity;
  if(f.onset)body.onsetDate=f.onset;
  const sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)body.originCaseId=sid;
  ALGY.formErr='';
  if(!body.substance){ALGY.formErr='An allergy needs a substance.';return renderAllergies()}
  ALGY.busy=true;renderAllergies();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/allergies',body);
  ALGY.busy=false;if(!srvCan('allergies:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===201){ALGY.form={substance:'',reaction:'',severity:'',onset:''};['af_substance','af_reaction','af_severity','af_onset'].forEach(i=>{const e=$(i);if(e)e.value=''});   // clear the boxes too: renderAllergies reads them back
    toast('Allergy added.');await allergiesLoad();return}
  ALGY.formErr=apiMsg(r);renderAllergies();
}
async function allergyStep(action,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!Object.hasOwn(ALGY_PATH,action)||ALGY.busy||!pid||!srvCan('allergies:write'))return;
  const id=Number(arg),p=ALGY.items.find(x=>x.id===id);if(!p)return;
  delete ALGY.err[id];
  const ta=$('ar_'+id),reason=ta?ta.value.trim():'';
  ALGY.draft[id]=reason;
  if(!reason){ALGY.err[id]='A reason is required.';return renderAllergies()}
  if(!confirm((action==='resolve'?'Resolve':'Mark as entered in error')+' this allergy?'+(action==='error'?' This is final.':'')))return;
  ALGY.busy=true;renderAllergies();
  const r=await api('POST','/api/allergies/'+id+'/'+ALGY_PATH[action],{reason,rowVersion:p.row_version});   // only these two fields; who and when are the session's
  ALGY.busy=false;if(!srvCan('allergies:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===200){delete ALGY.draft[id];toast(ALGY_DONE[action]);await allergiesLoad();return}
  ALGY.err[id]=apiMsg(r);
  if(r.status===409)await allergiesLoad();else renderAllergies();
}
