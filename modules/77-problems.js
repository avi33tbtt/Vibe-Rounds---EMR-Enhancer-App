// R3b: Problems screen (patient problem list: add, resolve, mark entered in error). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (status steps, stale versions, final rows); this page only shows the buttons the role may use and the
   server's own message when it refuses. Who and when are the server's values. All text is escaped. */
const PROB={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},draft:{},form:{label:'',onset:''},formErr:''};
const PROB_LBL={active:'active',resolved:'resolved',entered_in_error:'entered in error'};
const PROB_PATH={resolve:'resolve',error:'entered-in-error'};
const PROB_DONE={resolve:'Problem resolved.',error:'Problem marked as entered in error.'};
const probReset=()=>{PROB.items=[];PROB.pid=null;PROB.msg='';PROB.loaded=false;PROB.err={};PROB.draft={};PROB.formErr=''};
function renderProblemsNav(){
  const b=$('navProblems');if(!b)return;
  const show=srvCan('problems:read');b.style.display=show?'':'none';
  if(!show){probReset();if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
async function problemsLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('problems:read')||!pid){probReset();PROB.pid=pid||null;return renderProblems()}
  PROB.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/problems'+(PROB.all?'?include=all':''));
  if(!srvCan('problems:read')||!CASE||CASE.patientId!==pid)return;   // signed out or another patient opened meanwhile
  if(r.status!==200){PROB.msg='The problems could not be loaded: '+apiMsg(r);PROB.items=[];PROB.loaded=true;return renderProblems()}
  PROB.items=r.body.problems||[];PROB.msg='';PROB.loaded=true;renderProblems();
}
const probKeep=()=>{const l=$('pf_label'),o=$('pf_onset');if(l)PROB.form.label=l.value;if(o)PROB.form.onset=o.value};
function renderProblems(){
  const box=$('problemsBox');if(!box)return;
  if(!srvCan('problems:read')){box.innerHTML='';return}
  probKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='<div class="empty">Open a registered patient\'s case first (Patients tab). Problems belong to the patient, not to one case.</div>';return}
  const f=PROB.form,dis=PROB.busy?' disabled':'';
  let h=`<div class="note">Problem list of <b>${escA(caseName(CASE))}</b> (synthetic data only). A problem is never deleted: resolve it, or mark it entered in error, each with a reason. Who and when are recorded by the server.${PROB.msg?' '+escA(PROB.msg):''}
    <label class="mu"><input type="checkbox" id="pf_all" data-act="problemAll" data-ev="change"${PROB.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="problemReload">Reload</button></div>`;
  if(srvCan('problems:write'))h+=`<div class="cd"><b>Add a problem</b> <span class="mu">(your own words; onset date is optional)</span>
    <div class="field-row"><input id="pf_label" placeholder="problem, e.g. Type 2 diabetes" maxlength="200" value="${escA(f.label)}" aria-label="Problem" style="flex:1.6">
    <input id="pf_onset" type="date" value="${escA(f.onset)}" aria-label="Onset date (optional)" style="flex:.6"></div>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="problemAdd"${dis}>Add problem</button></div>${PROB.formErr?`<div class="gen-warn">${escA(PROB.formErr)}</div>`:''}</div>`;
  if(PROB.loaded&&!PROB.items.length&&!PROB.msg)h+='<div class="empty">No problems recorded for this patient.</div>';
  PROB.items.forEach(p=>{
    const id=escA(p.id),st=p.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(p.label)}</b> <span class="bd" style="background:var(${gone?'--r':st==='resolved'?'--g':'--a'})">${escA(PROB_LBL[st]||st)}</span>
      <div class="mu">Onset ${p.onset_date?escA(p.onset_date):'unknown'} · recorded by ${escA(p.recorded_by)} · ${escA(String(p.recorded_at||'').slice(0,16).replace('T',' '))}</div>`;
    if(st==='resolved'||gone){
      const who=gone?p.error_by:p.resolved_by,at=gone?p.error_at:p.resolved_at,why=gone?p.error_reason:p.resolution_reason;
      h+=`<div class="mu">${gone?'Marked in error':'Resolved'} by ${escA(who)} · ${escA(String(at||'').slice(0,16).replace('T',' '))}: ${escA(why)}</div>`;
    }
    if(gone)h+='<div class="mu">Final: an entry made in error is never changed.</div>';
    else if(srvCan('problems:write'))h+=`<div style="margin-top:6px"><textarea id="pr_${id}" rows="2" maxlength="1000" placeholder="Reason (required, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(PROB.draft[p.id]||'')}</textarea>
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="problemResolve" data-arg="${id}"${dis}>Resolve</button> `:''}<button class="b sec sm" data-act="problemError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change problems.</div>';
    if(PROB.err[p.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(PROB.err[p.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function problemAdd(){
  const pid=CASE&&CASE.patientId;
  if(PROB.busy||!pid||!srvCan('problems:write'))return;
  probKeep();
  const f=PROB.form,body={label:f.label.trim()};   // only these three fields are ever sent
  if(f.onset)body.onsetDate=f.onset;
  const sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)body.originCaseId=sid;
  PROB.formErr='';
  if(!body.label){PROB.formErr='A problem needs a label.';return renderProblems()}
  PROB.busy=true;renderProblems();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/problems',body);
  PROB.busy=false;if(!srvCan('problems:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===201){PROB.form={label:'',onset:''};['pf_label','pf_onset'].forEach(i=>{const e=$(i);if(e)e.value=''});   // clear the boxes too: renderProblems reads them back
    toast('Problem added.');await problemsLoad();return}
  PROB.formErr=apiMsg(r);renderProblems();
}
async function problemStep(action,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!Object.hasOwn(PROB_PATH,action)||PROB.busy||!pid||!srvCan('problems:write'))return;
  const id=Number(arg),p=PROB.items.find(x=>x.id===id);if(!p)return;
  delete PROB.err[id];
  const ta=$('pr_'+id),reason=ta?ta.value.trim():'';
  PROB.draft[id]=reason;
  if(!reason){PROB.err[id]='A reason is required.';return renderProblems()}
  if(!confirm((action==='resolve'?'Resolve':'Mark as entered in error')+' this problem?'+(action==='error'?' This is final.':'')))return;
  PROB.busy=true;renderProblems();
  const r=await api('POST','/api/problems/'+id+'/'+PROB_PATH[action],{reason,rowVersion:p.row_version});   // only these two fields; who and when are the session's
  PROB.busy=false;if(!srvCan('problems:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===200){delete PROB.draft[id];toast(PROB_DONE[action]);await problemsLoad();return}
  PROB.err[id]=apiMsg(r);
  if(r.status===409)await problemsLoad();else renderProblems();
}
