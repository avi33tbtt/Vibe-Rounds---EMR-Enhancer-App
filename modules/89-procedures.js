// R4i-2: Procedures (on the Orders tab). Record, cancel, mark entered in error. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (who may record, final rows, stale versions, no future times); this page only shows the buttons the role may use and the server's own
   message when it refuses. The procedure name, the time it was done and the optional outcome are typed by the clinician: nothing is suggested, matched or coded.
   A procedure is never edited or deleted: cancel it or mark it as entered in error, each with a reason. Who recorded it and when are the server's values.
   The time typed is the browser's local time and is sent with its offset; times are shown in UTC. All text is escaped. */
const PRC={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},f:{},formErr:''};
const PRC_ST={active:'active',cancelled:'cancelled',entered_in_error:'entered in error'};
const prcReset=()=>{PRC.items=[];PRC.pid=null;PRC.msg='';PRC.loaded=false;PRC.err={};PRC.f={};PRC.formErr=''};
const prcOk=pid=>srvCan('orders:read')&&!!CASE&&CASE.patientId===pid;   // false after sign-out or when another patient was opened meanwhile
const prcT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const prcUtc=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,16).replace('T',' ')+' UTC'};
const prcV=id=>escA(PRC.f[id]||'');
function prcKeep(){const b=$('prcBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{PRC.f[e.id]=e.value})}
async function prcLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('orders:read')||!pid){prcReset();PRC.pid=pid||null;return renderProcedures()}
  PRC.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/procedures'+(PRC.all?'?include=all':''));
  if(!prcOk(pid))return;
  if(r.status!==200){PRC.msg='The procedures could not be loaded: '+apiMsg(r);PRC.items=[];PRC.loaded=true;return renderProcedures()}
  PRC.items=r.body.procedures||[];PRC.msg='';PRC.loaded=true;renderProcedures();
}
function renderProcedures(){
  const box=$('prcBox');if(!box)return;
  if(!srvCan('orders:read')){prcReset();box.innerHTML='';return}
  prcKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const w=srvCan('orders:write'),dis=PRC.busy?' disabled':'';
  let h=`<h3>Procedures</h3><div class="note">Procedures of <b>${escA(caseName(CASE))}</b> (synthetic data only). The name, time and outcome are exactly what the clinician types: the page suggests, codes and checks nothing. A procedure is never deleted or edited: cancel it or mark it as entered in error, with a reason. Who recorded it and when are recorded by the server. Times are shown in UTC.
    <label class="mu"><input type="checkbox" id="pc_all" data-act="prcAll" data-ev="change"${PRC.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="prcReload">Reload</button>${PRC.msg?' '+escA(PRC.msg):''}</div>`;
  if(w)h+=`<div class="cd"><b>Record procedure</b>
    <div class="field-row"><input id="pc_n_name" data-k="1" placeholder="procedure done (required), in your own words" maxlength="200" value="${prcV('pc_n_name')}" aria-label="Procedure done" style="flex:1.4">
      <input id="pc_n_when" type="datetime-local" data-k="1" value="${prcV('pc_n_when')}" aria-label="When it was done (your local time, not in the future)" style="flex:1"></div>
    <div class="field-row"><input id="pc_n_out" data-k="1" placeholder="outcome (optional)" maxlength="500" value="${prcV('pc_n_out')}" aria-label="Outcome" style="flex:1"></div>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="prcAdd"${dis}>Record procedure</button></div>${PRC.formErr?`<div class="gen-warn">${escA(PRC.formErr)}</div>`:''}</div>`;
  if(PRC.loaded&&!PRC.items.length&&!PRC.msg)h+='<div class="empty">No procedures for this patient.</div>';
  PRC.items.forEach(o=>{
    const id=escA(o.id),st=o.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(o.procedure_text)}</b> <span class="bd" style="background:var(${gone?'--r':st==='active'?'--a':'--g'})">${escA(PRC_ST[st]||st)}</span>
      <div class="mu">Performed ${escA(prcUtc(o.performed_at))}</div>${o.outcome_text?`<div class="mu">Outcome: ${escA(o.outcome_text)}</div>`:''}<div class="mu">Recorded by ${escA(o.recorded_by)} · ${prcT(o.recorded_at)}</div>`;
    if(o.cancelled_by)h+=`<div class="mu">Cancelled by ${escA(o.cancelled_by)} · ${prcT(o.cancelled_at)}: ${escA(o.cancel_reason)}</div>`;
    if(gone)h+=`<div class="mu">Marked in error by ${escA(o.error_by)} · ${prcT(o.error_at)}: ${escA(o.error_reason)}</div><div class="mu">Final: an entry made in error is never changed.</div>`;
    else if(w)h+=`<div style="margin-top:6px"><textarea id="pc_r${id}" data-k="1" rows="2" maxlength="1000" placeholder="Reason (required to cancel or mark in error, up to 1000 characters)" aria-label="Reason" style="width:100%">${prcV('pc_r'+o.id)}</textarea>
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="prcCancel" data-arg="${id}"${dis}>Cancel procedure</button> `:''}<button class="b sec sm" data-act="prcError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change procedures.</div>';
    if(PRC.err[o.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(PRC.err[o.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function prcAdd(){
  const pid=CASE&&CASE.patientId;
  if(PRC.busy||!pid||!srvCan('orders:write'))return;
  prcKeep();PRC.formErr='';
  const g=k=>(PRC.f['pc_n_'+k]||'').trim(),name=g('name'),when=g('when'),out=g('out');
  if(!name||!when){PRC.formErr='A procedure needs what was done and when, as the clinician types them.';return renderProcedures()}
  const t=new Date(when);   // a datetime-local value is local time; it is sent as an exact moment with its offset
  if(Number.isNaN(t.getTime())){PRC.formErr='Enter a valid date and time.';return renderProcedures()}
  if(t.getTime()>Date.now()){PRC.formErr='A procedure cannot be recorded as done in the future.';return renderProcedures()}
  const b={procedure:name,performedAt:t.toISOString()};if(out)b.outcome=out;
  const sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)b.originCaseId=sid;   // only these fields are ever sent
  PRC.busy=true;renderProcedures();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/procedures',b);
  PRC.busy=false;if(!prcOk(pid))return;
  if(r.status===201){['pc_n_name','pc_n_when','pc_n_out'].forEach(k=>delete PRC.f[k]);toast('Procedure recorded.');await prcLoad();return}
  PRC.formErr=apiMsg(r);renderProcedures();
}
async function prcMove(kind,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!['cancel','error'].includes(kind)||PRC.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=PRC.items.find(x=>x.id===id);if(!o)return;
  prcKeep();delete PRC.err[id];
  const reason=(PRC.f['pc_r'+id]||'').trim();
  if(!reason){PRC.err[id]='A reason is required.';return renderProcedures()}
  if(!confirm((kind==='cancel'?'Cancel':'Mark as entered in error')+' this procedure?'+(kind==='error'?' This is final.':'')))return;
  PRC.busy=true;renderProcedures();
  const r=await api('POST','/api/procedures/'+id+'/'+(kind==='cancel'?'cancel':'entered-in-error'),{reason,rowVersion:o.row_version});   // only these two fields
  PRC.busy=false;if(!prcOk(pid))return;
  if(r.status===200){delete PRC.f['pc_r'+id];toast(kind==='cancel'?'Procedure cancelled.':'Procedure marked as entered in error.');await prcLoad();return}
  PRC.err[id]=apiMsg(r);
  if(r.status===409)await prcLoad();else renderProcedures();
}
