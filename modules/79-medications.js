// R3f: Medications screen (patient medication list: add, stop, mark entered in error). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (status steps, stale versions, final rows); this page only shows the buttons the role may use and the
   server's own message when it refuses. Who and when are the server's values. All text is escaped. */
const MEDH={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},draft:{},form:{medication:'',dose:'',frequency:'',start:''},formErr:''};
const MEDH_LBL={active:'active',stopped:'stopped',entered_in_error:'entered in error'};
const MEDH_PATH={stop:'stop',error:'entered-in-error'};
const MEDH_DONE={stop:'Medication stopped.',error:'Medication marked as entered in error.'};
const medhReset=()=>{MEDH.items=[];MEDH.pid=null;MEDH.msg='';MEDH.loaded=false;MEDH.err={};MEDH.draft={};MEDH.formErr=''};
function renderMedicationsNav(){
  const b=$('navMedications');if(!b)return;
  const show=srvCan('medications:read');b.style.display=show?'':'none';
  if(!show){medhReset();if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
async function medicationsLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('medications:read')||!pid){medhReset();MEDH.pid=pid||null;return renderMedications()}
  MEDH.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/medications'+(MEDH.all?'?include=all':''));
  if(!srvCan('medications:read')||!CASE||CASE.patientId!==pid)return;   // signed out or another patient opened meanwhile
  if(r.status!==200){MEDH.msg='The medications could not be loaded: '+apiMsg(r);MEDH.items=[];MEDH.loaded=true;return renderMedications()}
  MEDH.items=r.body.medications||[];MEDH.msg='';MEDH.loaded=true;renderMedications();
}
const medhKeep=()=>{[['mf_medication','medication'],['mf_dose','dose'],['mf_frequency','frequency'],['mf_start','start']].forEach(([i,k])=>{const e=$(i);if(e)MEDH.form[k]=e.value})};
function renderMedications(){
  const box=$('medicationsBox');if(!box)return;
  if(!srvCan('medications:read')){box.innerHTML='';return}
  medhKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='<div class="empty">Open a registered patient\'s case first (Patients tab). Medications belong to the patient, not to one case.</div>';return}
  const f=MEDH.form,dis=MEDH.busy?' disabled':'';
  let h=`<div class="note">Medication list of <b>${escA(caseName(CASE))}</b> (synthetic data only). A medication is never deleted: stop it, or mark it entered in error, each with a reason. Who and when are recorded by the server.${MEDH.msg?' '+escA(MEDH.msg):''}
    <label class="mu"><input type="checkbox" id="mf_all" data-act="medicationAll" data-ev="change"${MEDH.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="medicationReload">Reload</button></div>`;
  if(srvCan('medications:write'))h+=`<div class="cd"><b>Add a medication</b> <span class="mu">(your own words, as recorded; dose, frequency and start date are optional; this list records what the patient takes, it is not an order)</span>
    <div class="field-row"><input id="mf_medication" placeholder="medication, e.g. Penicillin" maxlength="200" value="${escA(f.medication)}" aria-label="Medication" style="flex:1.4">
    <input id="mf_dose" placeholder="dose as recorded (optional)" maxlength="200" value="${escA(f.dose)}" aria-label="Dose (optional)" style="flex:1">
    <input id="mf_frequency" placeholder="frequency (optional)" maxlength="200" value="${escA(f.frequency)}" aria-label="Frequency (optional)" style="flex:1">
    <input id="mf_start" type="date" value="${escA(f.start)}" aria-label="Onset date (optional)" style="flex:.6"></div>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="medicationAdd"${dis}>Add medication</button></div>${MEDH.formErr?`<div class="gen-warn">${escA(MEDH.formErr)}</div>`:''}</div>`;
  if(MEDH.loaded&&!MEDH.items.length&&!MEDH.msg)h+='<div class="empty">No medications recorded for this patient.</div>';
  MEDH.items.forEach(p=>{
    const id=escA(p.id),st=p.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(p.medication)}</b> <span class="bd" style="background:var(${gone?'--r':st==='stopped'?'--g':'--a'})">${escA(MEDH_LBL[st]||st)}</span>
      <div class="mu">Dose ${p.dose_text?escA(p.dose_text):'not recorded'} · frequency ${p.frequency_text?escA(p.frequency_text):'not recorded'} · start ${p.start_date?escA(p.start_date):'unknown'} · recorded by ${escA(p.recorded_by)} · ${escA(String(p.recorded_at||'').slice(0,16).replace('T',' '))}</div>`;
    if(st==='stopped'||gone){
      const who=gone?p.error_by:p.stopped_by,at=gone?p.error_at:p.stopped_at,why=gone?p.error_reason:p.stop_reason;
      h+=`<div class="mu">${gone?'Marked in error':'Stopped'} by ${escA(who)} · ${escA(String(at||'').slice(0,16).replace('T',' '))}: ${escA(why)}</div>`;
    }
    if(gone)h+='<div class="mu">Final: an entry made in error is never changed.</div>';
    else if(srvCan('medications:write'))h+=`<div style="margin-top:6px"><textarea id="mr_${id}" rows="2" maxlength="1000" placeholder="Reason (required, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(MEDH.draft[p.id]||'')}</textarea>
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="medicationStop" data-arg="${id}"${dis}>Stop</button> `:''}<button class="b sec sm" data-act="medicationError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change medications.</div>';
    if(MEDH.err[p.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(MEDH.err[p.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function medicationAdd(){
  const pid=CASE&&CASE.patientId;
  if(MEDH.busy||!pid||!srvCan('medications:write'))return;
  medhKeep();
  const f=MEDH.form,body={medication:f.medication.trim()};   // only these fields are ever sent
  if(f.dose.trim())body.doseText=f.dose.trim();
  if(f.frequency.trim())body.frequencyText=f.frequency.trim();
  if(f.start)body.startDate=f.start;
  const sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)body.originCaseId=sid;
  MEDH.formErr='';
  if(!body.medication){MEDH.formErr='A medication needs a medication.';return renderMedications()}
  MEDH.busy=true;renderMedications();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/medications',body);
  MEDH.busy=false;if(!srvCan('medications:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===201){MEDH.form={medication:'',dose:'',frequency:'',start:''};['mf_medication','mf_dose','mf_frequency','mf_start'].forEach(i=>{const e=$(i);if(e)e.value=''});   // clear the boxes too: renderMedications reads them back
    toast('Medication added.');await medicationsLoad();return}
  MEDH.formErr=apiMsg(r);renderMedications();
}
async function medicationStep(action,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!Object.hasOwn(MEDH_PATH,action)||MEDH.busy||!pid||!srvCan('medications:write'))return;
  const id=Number(arg),p=MEDH.items.find(x=>x.id===id);if(!p)return;
  delete MEDH.err[id];
  const ta=$('mr_'+id),reason=ta?ta.value.trim():'';
  MEDH.draft[id]=reason;
  if(!reason){MEDH.err[id]='A reason is required.';return renderMedications()}
  if(!confirm((action==='stop'?'Stop':'Mark as entered in error')+' this medication?'+(action==='error'?' This is final.':'')))return;
  MEDH.busy=true;renderMedications();
  const r=await api('POST','/api/medications/'+id+'/'+MEDH_PATH[action],{reason,rowVersion:p.row_version});   // only these two fields; who and when are the session's
  MEDH.busy=false;if(!srvCan('medications:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===200){delete MEDH.draft[id];toast(MEDH_DONE[action]);await medicationsLoad();return}
  MEDH.err[id]=apiMsg(r);
  if(r.status===409)await medicationsLoad();else renderMedications();
}
