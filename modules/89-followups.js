// R5g: Follow-up after discharge (on the Orders tab). Plan a follow-up for a discharged admission, cancel it, mark it entered in error. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (who may record, the admission must be discharged, final rows, stale versions); this page only shows the buttons the role may use and the server's own
   message when it refuses. The instruction, the place and the planned day are typed by the clinician: nothing is suggested, booked, reminded or checked, and nothing is sent to anyone
   (this records the plan only). A follow-up is never edited or deleted: cancel it or mark it as entered in error, each with a reason. Who and when are the server's values. All text is escaped. */
const FUP={items:[],adms:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},f:{},formErr:''};
const FUP_ST={active:'active',cancelled:'cancelled',entered_in_error:'entered in error'};
const fupReset=()=>{FUP.items=[];FUP.adms=[];FUP.pid=null;FUP.msg='';FUP.loaded=false;FUP.err={};FUP.f={};FUP.formErr=''};
const fupOk=pid=>srvCan('orders:read')&&!!CASE&&CASE.patientId===pid;   // false after sign-out or when another patient was opened meanwhile
const fupT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const fupV=id=>escA(FUP.f[id]||'');
const fupAdm=id=>{const a=FUP.adms.find(x=>x.id===id);return a?a.ward_text+' (discharged '+String(a.discharged_at||'').slice(0,10)+')':'admission '+id};
function fupKeep(){const b=$('fupBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{FUP.f[e.id]=e.value})}
async function fupLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('orders:read')||!pid){fupReset();FUP.pid=pid||null;return renderFollowups()}
  FUP.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/followups'+(FUP.all?'?include=all':''));
  if(!fupOk(pid))return;
  if(r.status!==200){FUP.msg='The follow-ups could not be loaded: '+apiMsg(r);FUP.items=[];FUP.loaded=true;return renderFollowups()}
  FUP.items=r.body.followups||[];FUP.msg='';FUP.loaded=true;
  const a=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/admissions');   // the discharged admissions the form can pick from (the server still checks)
  if(!fupOk(pid))return;
  FUP.adms=a.status===200?(a.body.admissions||[]).filter(x=>x.status==='discharged'):[];
  renderFollowups();
}
function renderFollowups(){
  const box=$('fupBox');if(!box)return;
  if(!srvCan('orders:read')){fupReset();box.innerHTML='';return}
  fupKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const w=srvCan('orders:write'),dis=FUP.busy?' disabled':'';
  let h=`<h3>Follow-up after discharge</h3><div class="note">Planned follow-up for <b>${escA(caseName(CASE))}</b> (synthetic data only). The instruction, place and day are exactly what the clinician types: the page suggests, books and checks nothing, and sends nothing to anyone. A follow-up belongs to a discharged admission. It is never deleted or edited: cancel it or mark it as entered in error, with a reason. Who recorded it and when are recorded by the server.
    <label class="mu"><input type="checkbox" id="fu_all" data-act="fupAll" data-ev="change"${FUP.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="fupReload">Reload</button>${FUP.msg?' '+escA(FUP.msg):''}</div>`;
  if(w){
    h+='<div class="cd"><b>Plan follow-up</b>';
    if(!FUP.adms.length)h+='<div class="mu">This patient has no discharged admission. Discharge the admission first.</div>';
    else h+=`<div class="field-row"><select id="fu_n_adm" data-k="1" aria-label="Discharged admission" style="flex:1.4">${FUP.adms.map(a=>`<option value="${escA(a.id)}"${String(a.id)===FUP.f.fu_n_adm?' selected':''}>${escA(fupAdm(a.id))}</option>`).join('')}</select>
      <input id="fu_n_on" type="date" data-k="1" value="${fupV('fu_n_on')}" aria-label="Planned day (optional)" style="flex:1"></div>
      <div class="field-row"><input id="fu_n_instr" data-k="1" placeholder="follow-up instruction (required)" maxlength="500" value="${fupV('fu_n_instr')}" aria-label="Follow-up instruction" style="flex:1.4">
      <input id="fu_n_where" data-k="1" placeholder="place (optional)" maxlength="200" value="${fupV('fu_n_where')}" aria-label="Place (optional)" style="flex:1"></div>
      <div class="flex" style="margin-top:4px"><button class="b sm" data-act="fupAdd"${dis}>Plan follow-up</button></div>`;
    if(FUP.formErr)h+=`<div class="gen-warn">${escA(FUP.formErr)}</div>`;
    h+='</div>';
  }
  if(FUP.loaded&&!FUP.items.length&&!FUP.msg)h+='<div class="empty">No follow-ups for this patient.</div>';
  FUP.items.forEach(o=>{
    const id=escA(o.id),st=o.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(o.instruction_text)}</b> <span class="bd" style="background:var(${gone?'--r':st==='active'?'--a':'--g'})">${escA(FUP_ST[st]||st)}</span>
      <div class="mu">${o.follow_up_on?'Planned day '+escA(o.follow_up_on):'No day set'}${o.where_text?' · Place: '+escA(o.where_text):''}</div><div class="mu">After ${escA(fupAdm(o.admission_id))}</div><div class="mu">Recorded by ${escA(o.recorded_by)} · ${fupT(o.recorded_at)}</div>`;
    if(o.cancelled_by)h+=`<div class="mu">Cancelled by ${escA(o.cancelled_by)} · ${fupT(o.cancelled_at)}: ${escA(o.cancel_reason)}</div>`;
    if(gone)h+=`<div class="mu">Marked in error by ${escA(o.error_by)} · ${fupT(o.error_at)}: ${escA(o.error_reason)}</div><div class="mu">Final: an entry made in error is never changed.</div>`;
    else if(w)h+=`<div style="margin-top:6px"><textarea id="fu_r${id}" data-k="1" rows="2" maxlength="1000" placeholder="Reason (required to cancel or mark in error, up to 1000 characters)" aria-label="Reason" style="width:100%">${fupV('fu_r'+o.id)}</textarea>
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="fupCancel" data-arg="${id}"${dis}>Cancel follow-up</button> `:''}<button class="b sec sm" data-act="fupError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change follow-ups.</div>';
    if(FUP.err[o.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(FUP.err[o.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function fupAdd(){
  const pid=CASE&&CASE.patientId;
  if(FUP.busy||!pid||!srvCan('orders:write'))return;
  fupKeep();FUP.formErr='';
  const g=k=>(FUP.f['fu_n_'+k]||'').trim(),aid=g('adm'),instr=g('instr'),where=g('where'),on=g('on');
  if(!/^\d{1,9}$/.test(aid)||!instr){FUP.formErr='A follow-up needs a discharged admission and an instruction, as the clinician types it.';return renderFollowups()}
  if(on&&!/^\d{4}-\d{2}-\d{2}$/.test(on)){FUP.formErr='Enter the planned day as a date.';return renderFollowups()}
  const b={instruction:instr};if(where)b.where=where;if(on)b.followUpOn=on;   // only these fields are ever sent
  FUP.busy=true;renderFollowups();
  const r=await api('POST','/api/admissions/'+aid+'/followups',b);
  FUP.busy=false;if(!fupOk(pid))return;   // on success the DOM inputs are cleared too, because a render re-reads typed values
  if(r.status===201){['fu_n_on','fu_n_instr','fu_n_where'].forEach(k=>{delete FUP.f[k];const e=$(k);if(e)e.value=''});toast('Follow-up planned.');await fupLoad();return}
  FUP.formErr=apiMsg(r);
  if(r.status===409)await fupLoad();else renderFollowups();
}
async function fupMove(kind,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!['cancel','error'].includes(kind)||FUP.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=FUP.items.find(x=>x.id===id);if(!o)return;
  fupKeep();delete FUP.err[id];
  const reason=(FUP.f['fu_r'+id]||'').trim();
  if(!reason){FUP.err[id]='A reason is required.';return renderFollowups()}
  if(!confirm((kind==='cancel'?'Cancel':'Mark as entered in error')+' this follow-up?'+(kind==='error'?' This is final.':'')))return;
  FUP.busy=true;renderFollowups();
  const r=await api('POST','/api/followups/'+id+'/'+(kind==='cancel'?'cancel':'entered-in-error'),{reason,rowVersion:o.row_version});   // only these two fields
  FUP.busy=false;if(!fupOk(pid))return;
  if(r.status===200){delete FUP.f['fu_r'+id];toast(kind==='cancel'?'Follow-up cancelled.':'Follow-up marked as entered in error.');await fupLoad();return}
  FUP.err[id]=apiMsg(r);
  if(r.status===409)await fupLoad();else renderFollowups();
}
