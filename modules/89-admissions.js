// R5b: Admissions (on the Orders tab). Record an admission, cancel it, mark it entered in error. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (who may record, one active admission per patient, final rows, stale versions, no future times); this page only shows the buttons the role may use
   and the server's own message when it refuses. Ward (or unit), admission time and reason are typed by the clinician: nothing is suggested, matched or coded.
   An admission is never edited or deleted: cancel it or mark it as entered in error, each with a reason. Who recorded it and when are the server's values.
   R5g adds the discharge of an active admission: the time, a summary and an optional condition, exactly as typed; the server keeps it and it is final. Beds and transfers are not here.
   The time typed is the browser's local time and is sent with its offset; times are shown in UTC. All text is escaped. */
const ADM={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},f:{},formErr:''};
const ADM_ST={active:'active',discharged:'discharged',cancelled:'cancelled',entered_in_error:'entered in error'};
const admReset=()=>{ADM.items=[];ADM.pid=null;ADM.msg='';ADM.loaded=false;ADM.err={};ADM.f={};ADM.formErr=''};
const admOk=pid=>srvCan('orders:read')&&!!CASE&&CASE.patientId===pid;   // false after sign-out or when another patient was opened meanwhile
const admT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const admUtc=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,16).replace('T',' ')+' UTC'};
const admV=id=>escA(ADM.f[id]||'');
function admKeep(){const b=$('admBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{ADM.f[e.id]=e.value})}
async function admLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('orders:read')||!pid){admReset();ADM.pid=pid||null;return renderAdmissions()}
  ADM.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/admissions'+(ADM.all?'?include=all':''));
  if(!admOk(pid))return;
  if(r.status!==200){ADM.msg='The admissions could not be loaded: '+apiMsg(r);ADM.items=[];ADM.loaded=true;return renderAdmissions()}
  ADM.items=r.body.admissions||[];ADM.msg='';ADM.loaded=true;renderAdmissions();
}
function renderAdmissions(){
  const box=$('admBox');if(!box)return;
  if(!srvCan('orders:read')){admReset();box.innerHTML='';return}
  admKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const w=srvCan('orders:write'),dis=ADM.busy?' disabled':'',active=ADM.items.some(o=>o.status==='active');
  let h=`<h3>Admission</h3><div class="note">Admissions of <b>${escA(caseName(CASE))}</b> (synthetic data only). Ward, time and reason are exactly what the clinician types: the page suggests, codes and checks nothing. A patient can have only one active admission. An admission is never deleted or edited: cancel it or mark it as entered in error, with a reason. Who recorded it and when are recorded by the server. A discharge records when the patient left, a summary and, if you wish, the condition, exactly as typed; it cannot be edited afterwards. Times are shown in UTC.
    <label class="mu"><input type="checkbox" id="ad_all" data-act="admAll" data-ev="change"${ADM.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="admReload">Reload</button>${ADM.msg?' '+escA(ADM.msg):''}</div>`;
  if(w&&active)h+='<div class="mu">This patient has an active admission. Cancel it (with a reason) before recording another.</div>';
  else if(w)h+=`<div class="cd"><b>Record admission</b>
    <div class="field-row"><input id="ad_n_ward" data-k="1" placeholder="ward or unit (required), in your own words" maxlength="200" value="${admV('ad_n_ward')}" aria-label="Ward or unit" style="flex:1.4">
      <input id="ad_n_when" type="datetime-local" data-k="1" value="${admV('ad_n_when')}" aria-label="Admitted at (your local time, not in the future)" style="flex:1"></div>
    <div class="field-row"><input id="ad_n_reason" data-k="1" placeholder="reason for admission (required)" maxlength="500" value="${admV('ad_n_reason')}" aria-label="Reason for admission" style="flex:1"></div>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="admAdd"${dis}>Record admission</button></div>${ADM.formErr?`<div class="gen-warn">${escA(ADM.formErr)}</div>`:''}</div>`;
  if(ADM.loaded&&!ADM.items.length&&!ADM.msg)h+='<div class="empty">No admissions for this patient.</div>';
  ADM.items.forEach(o=>{
    const id=escA(o.id),st=o.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(o.ward_text)}</b> <span class="bd" style="background:var(${gone?'--r':st==='active'?'--a':'--g'})">${escA(ADM_ST[st]||st)}</span>
      <div class="mu">Admitted ${escA(admUtc(o.admitted_at))}</div><div class="mu">Reason: ${escA(o.reason_text)}</div><div class="mu">Recorded by ${escA(o.recorded_by)} · ${admT(o.recorded_at)}</div>`;
    if(o.discharged_at)h+=`<div class="mu">Discharged ${escA(admUtc(o.discharged_at))} · recorded by ${escA(o.discharged_by)} · ${admT(o.discharge_recorded_at)}</div><div class="mu">Summary: ${escA(o.discharge_summary)}</div>${o.discharge_condition?`<div class="mu">Condition: ${escA(o.discharge_condition)}</div>`:''}`;
    if(st==='active'&&w)h+=`<div style="margin-top:6px"><b>Discharge</b><div class="field-row"><input id="ad_d_when${id}" type="datetime-local" data-k="1" value="${admV('ad_d_when'+o.id)}" aria-label="Discharged at (your local time, not in the future)" style="flex:1">
      <input id="ad_d_cond${id}" data-k="1" placeholder="condition at discharge (optional)" maxlength="500" value="${admV('ad_d_cond'+o.id)}" aria-label="Condition at discharge" style="flex:1.4"></div>
      <textarea id="ad_d_sum${id}" data-k="1" rows="3" maxlength="2000" placeholder="Discharge summary (required, up to 2000 characters), in your own words" aria-label="Discharge summary" style="width:100%">${admV('ad_d_sum'+o.id)}</textarea>
      <div class="flex" style="margin-top:4px"><button class="b sm" data-act="admDischarge" data-arg="${id}"${dis}>Discharge patient</button></div></div>`;
    if(o.cancelled_by)h+=`<div class="mu">Cancelled by ${escA(o.cancelled_by)} · ${admT(o.cancelled_at)}: ${escA(o.cancel_reason)}</div>`;
    if(gone)h+=`<div class="mu">Marked in error by ${escA(o.error_by)} · ${admT(o.error_at)}: ${escA(o.error_reason)}</div><div class="mu">Final: an entry made in error is never changed.</div>`;
    else if(w)h+=`<div style="margin-top:6px"><textarea id="ad_r${id}" data-k="1" rows="2" maxlength="1000" placeholder="Reason (required to cancel or mark in error, up to 1000 characters)" aria-label="Reason" style="width:100%">${admV('ad_r'+o.id)}</textarea>
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="admCancel" data-arg="${id}"${dis}>Cancel admission</button> `:''}<button class="b sec sm" data-act="admError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change admissions.</div>';
    if(ADM.err[o.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(ADM.err[o.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function admAdd(){
  const pid=CASE&&CASE.patientId;
  if(ADM.busy||!pid||!srvCan('orders:write'))return;
  admKeep();ADM.formErr='';
  const g=k=>(ADM.f['ad_n_'+k]||'').trim(),ward=g('ward'),when=g('when'),reason=g('reason');
  if(!ward||!when||!reason){ADM.formErr='An admission needs the ward or unit, the time and the reason, as the clinician types them.';return renderAdmissions()}
  const t=new Date(when);   // a datetime-local value is local time; it is sent as an exact moment with its offset
  if(Number.isNaN(t.getTime())){ADM.formErr='Enter a valid date and time.';return renderAdmissions()}
  if(t.getTime()>Date.now()){ADM.formErr='An admission cannot be recorded as happening in the future.';return renderAdmissions()}
  const b={ward,admittedAt:t.toISOString(),reason};
  const sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)b.originCaseId=sid;   // only these fields are ever sent
  ADM.busy=true;renderAdmissions();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/admissions',b);
  ADM.busy=false;if(!admOk(pid))return;   // on success the DOM inputs are cleared too, because a render re-reads typed values
  if(r.status===201){['ad_n_ward','ad_n_when','ad_n_reason'].forEach(k=>{delete ADM.f[k];const e=$(k);if(e)e.value=''});toast('Admission recorded.');await admLoad();return}
  ADM.formErr=apiMsg(r);
  if(r.status===409)await admLoad();else renderAdmissions();
}
async function admMove(kind,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!['cancel','error'].includes(kind)||ADM.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=ADM.items.find(x=>x.id===id);if(!o)return;
  admKeep();delete ADM.err[id];
  const reason=(ADM.f['ad_r'+id]||'').trim();
  if(!reason){ADM.err[id]='A reason is required.';return renderAdmissions()}
  if(!confirm((kind==='cancel'?'Cancel':'Mark as entered in error')+' this admission?'+(kind==='error'?' This is final.':'')))return;
  ADM.busy=true;renderAdmissions();
  const r=await api('POST','/api/admissions/'+id+'/'+(kind==='cancel'?'cancel':'entered-in-error'),{reason,rowVersion:o.row_version});   // only these two fields
  ADM.busy=false;if(!admOk(pid))return;
  if(r.status===200){delete ADM.f['ad_r'+id];toast(kind==='cancel'?'Admission cancelled.':'Admission marked as entered in error.');await admLoad();return}
  ADM.err[id]=apiMsg(r);
  if(r.status===409)await admLoad();else renderAdmissions();
}
async function admDischarge(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||ADM.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=ADM.items.find(x=>x.id===id&&x.status==='active');if(!o)return;
  admKeep();delete ADM.err[id];
  const g=k=>(ADM.f['ad_d_'+k+id]||'').trim(),when=g('when'),sum=g('sum'),cond=g('cond');
  const bad=m=>{ADM.err[id]=m;renderAdmissions()};
  if(!when||!sum)return bad('A discharge needs the time and a summary, as the clinician types them.');
  const t=new Date(when);   // a datetime-local value is local time; it is sent as an exact moment with its offset
  if(Number.isNaN(t.getTime()))return bad('Enter a valid date and time.');
  if(t.getTime()>Date.now())return bad('A discharge cannot be recorded as happening in the future.');
  if(t.getTime()<new Date(o.admitted_at).getTime())return bad('A discharge cannot be before the admission.');
  if(!confirm('Discharge this patient? A discharge cannot be edited afterwards.'))return;
  const b={dischargedAt:t.toISOString(),summary:sum,rowVersion:o.row_version};if(cond)b.condition=cond;   // only these fields
  ADM.busy=true;renderAdmissions();
  const r=await api('POST','/api/admissions/'+id+'/discharge',b);
  ADM.busy=false;if(!admOk(pid))return;
  if(r.status===200){['when','sum','cond'].forEach(k=>delete ADM.f['ad_d_'+k+id]);toast('Patient discharged.');await admLoad();if(typeof fupLoad==='function')fupLoad();return}
  ADM.err[id]=apiMsg(r);
  if(r.status===409)await admLoad();else renderAdmissions();
}
