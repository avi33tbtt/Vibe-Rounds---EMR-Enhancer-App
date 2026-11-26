// R5e: Medication administration record (MAR) on the Orders tab. Record a dose given, held or refused; mark an entry as entered in error. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (who may record, final rows, stale versions, no future times, no dose before the order, no dose after it ended); this page only shows the buttons the
   role may use and the server's own message when it refuses. The dose actually given, the reason (required when held or refused) and the note are typed by the person: nothing is
   suggested, copied from the order, scheduled or checked, and there is no due list or alert. An entry is never edited or deleted: a wrong one is marked entered in error, with a
   reason (final). Who recorded it and when are the server's values. The time typed is the browser's local time and is sent with its offset; times are shown in UTC. All text is escaped. */
const MAR={items:[],orders:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},f:{},formErr:''};
const MAR_OUT={given:'given',held:'held',refused:'refused'};
const marReset=()=>{MAR.items=[];MAR.orders=[];MAR.pid=null;MAR.msg='';MAR.loaded=false;MAR.err={};MAR.f={};MAR.formErr=''};
const marOk=pid=>srvCan('mar:read')&&!!CASE&&CASE.patientId===pid;   // false after sign-out or when another patient was opened meanwhile
const marT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const marUtc=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,16).replace('T',' ')+' UTC'};
const marV=id=>escA(MAR.f[id]||'');
function marKeep(){const b=$('marBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{MAR.f[e.id]=e.value})}
async function marLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('mar:read')||!pid){marReset();MAR.pid=pid||null;return renderMar()}
  MAR.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/administrations'+(MAR.all?'?include=all':''));
  if(!marOk(pid))return;
  if(r.status!==200){MAR.msg='The administration record could not be loaded: '+apiMsg(r);MAR.items=[];MAR.loaded=true;return renderMar()}
  MAR.items=r.body.administrations||[];MAR.msg='';MAR.loaded=true;
  if(srvCan('mar:write')&&srvCan('orders:read')){   // the orders the form can pick from (the server still checks each one)
    const o=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/medication-orders');
    if(!marOk(pid))return;
    MAR.orders=o.status===200?(o.body.orders||[]).filter(x=>x.status==='active'):[];
  }else MAR.orders=[];
  renderMar();
}
function renderMar(){
  const box=$('marBox');if(!box)return;
  if(!srvCan('mar:read')){marReset();box.innerHTML='';return}
  marKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const w=srvCan('mar:write'),dis=MAR.busy?' disabled':'',oc=MAR.f.mr_n_out||'given';
  let h=`<h3>Medication administration record</h3><div class="note">Doses given, held or refused for <b>${escA(caseName(CASE))}</b> (synthetic data only). The dose, reason and note are exactly what the person types: the page suggests, schedules and checks nothing, and there is no due list or alert. An entry is never deleted or edited: a wrong one is marked as entered in error, with a reason, and that is final. Who recorded it and when are recorded by the server. Times are shown in UTC.
    <label class="mu"><input type="checkbox" id="mr_all" data-act="marAll" data-ev="change"${MAR.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="marReload">Reload</button>${MAR.msg?' '+escA(MAR.msg):''}</div>`;
  if(w){
    const opts=MAR.orders.map(o=>`<option value="${escA(o.id)}"${String(o.id)===MAR.f.mr_n_order?' selected':''}>${escA(o.medication)}</option>`).join('');
    h+=`<div class="cd"><b>Record administration</b>`;
    if(!srvCan('orders:read'))h+='<div class="mu">Your role cannot see the medication orders, so it cannot pick one here.</div>';
    else if(!MAR.orders.length)h+='<div class="mu">There is no active medication order to record against.</div>';
    else h+=`<div class="field-row"><select id="mr_n_order" data-k="1" aria-label="Medication order" style="flex:1.4"><option value="">choose the active order (required)</option>${opts}</select>
      <select id="mr_n_out" data-k="1" data-act="marOut" data-ev="change" aria-label="Outcome" style="flex:1">${Object.keys(MAR_OUT).map(k=>`<option value="${k}"${k===oc?' selected':''}>${MAR_OUT[k]}</option>`).join('')}</select>
      <input id="mr_n_when" type="datetime-local" data-k="1" value="${marV('mr_n_when')}" aria-label="When it happened (your local time, not in the future)" style="flex:1"></div>
      ${oc==='given'?`<div class="field-row"><input id="mr_n_dose" data-k="1" placeholder="dose actually given (optional, as typed)" maxlength="200" value="${marV('mr_n_dose')}" aria-label="Dose given" style="flex:1"></div>`
        :`<div class="field-row"><input id="mr_n_reason" data-k="1" placeholder="reason (required when held or refused)" maxlength="500" value="${marV('mr_n_reason')}" aria-label="Reason" style="flex:1"></div>`}
      <div class="field-row"><input id="mr_n_note" data-k="1" placeholder="note (optional)" maxlength="500" value="${marV('mr_n_note')}" aria-label="Note" style="flex:1"></div>
      <div class="flex" style="margin-top:4px"><button class="b sm" data-act="marAdd"${dis}>Record administration</button></div>`;
    if(MAR.formErr)h+=`<div class="gen-warn">${escA(MAR.formErr)}</div>`;
    h+='</div>';
  }
  if(MAR.loaded&&!MAR.items.length&&!MAR.msg)h+='<div class="empty">No administrations recorded for this patient.</div>';
  MAR.items.forEach(a=>{
    const id=escA(a.id),gone=a.status==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(a.medication)}</b> <span class="bd" style="background:var(${gone?'--r':a.outcome==='given'?'--g':'--a'})">${escA(gone?'entered in error':MAR_OUT[a.outcome]||a.outcome)}</span>
      <div class="mu">${escA(MAR_OUT[a.outcome]||a.outcome)} at ${escA(marUtc(a.administered_at))}</div>${a.dose_text?`<div class="mu">Dose given: ${escA(a.dose_text)}</div>`:''}${a.reason_text?`<div class="mu">Reason: ${escA(a.reason_text)}</div>`:''}${a.note_text?`<div class="mu">Note: ${escA(a.note_text)}</div>`:''}<div class="mu">Recorded by ${escA(a.recorded_by)} · ${marT(a.recorded_at)}</div>`;
    if(gone)h+=`<div class="mu">Marked in error by ${escA(a.error_by)} · ${marT(a.error_at)}: ${escA(a.error_reason)}</div><div class="mu">Final: an entry made in error is never changed.</div>`;
    else if(w)h+=`<div style="margin-top:6px"><textarea id="mr_r${id}" data-k="1" rows="2" maxlength="1000" placeholder="Reason (required to mark in error, up to 1000 characters)" aria-label="Reason" style="width:100%">${marV('mr_r'+a.id)}</textarea>
      <div class="flex" style="margin-top:4px"><button class="b sec sm" data-act="marError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change the administration record.</div>';
    if(MAR.err[a.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(MAR.err[a.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function marAdd(){
  const pid=CASE&&CASE.patientId;
  if(MAR.busy||!pid||!srvCan('mar:write'))return;
  marKeep();MAR.formErr='';
  const g=k=>(MAR.f['mr_n_'+k]||'').trim(),order=g('order'),out=g('out')||'given',when=g('when'),dose=g('dose'),reason=g('reason'),note=g('note');
  if(!/^\d{1,9}$/.test(order)||!MAR_OUT[out]||!when){MAR.formErr='An administration needs the medication order, the outcome and when it happened.';return renderMar()}
  if(out!=='given'&&!reason){MAR.formErr='A reason is required when a dose is held or refused.';return renderMar()}
  const t=new Date(when);   // a datetime-local value is local time; it is sent as an exact moment with its offset
  if(Number.isNaN(t.getTime())){MAR.formErr='Enter a valid date and time.';return renderMar()}
  if(t.getTime()>Date.now()){MAR.formErr='An administration cannot be recorded in the future.';return renderMar()}
  const b={orderId:Number(order),outcome:out,administeredAt:t.toISOString()};   // only these fields are ever sent
  if(out==='given'){if(dose)b.dose=dose}else b.reason=reason;
  if(note)b.note=note;
  MAR.busy=true;renderMar();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/administrations',b);
  MAR.busy=false;if(!marOk(pid))return;
  if(r.status===201){['mr_n_order','mr_n_out','mr_n_when','mr_n_dose','mr_n_reason','mr_n_note'].forEach(k=>{delete MAR.f[k];const e=$(k);if(e)e.value=''});   // clear the inputs too, or the next render would keep their old text
  toast('Administration recorded.');await marLoad();return}
  MAR.formErr=apiMsg(r);renderMar();
}
async function marError(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||MAR.busy||!pid||!srvCan('mar:write'))return;
  const id=Number(arg),a=MAR.items.find(x=>x.id===id);if(!a)return;
  marKeep();delete MAR.err[id];
  const reason=(MAR.f['mr_r'+id]||'').trim();
  if(!reason){MAR.err[id]='A reason is required.';return renderMar()}
  if(!confirm('Mark this administration as entered in error? This is final.'))return;
  MAR.busy=true;renderMar();
  const r=await api('POST','/api/administrations/'+id+'/entered-in-error',{reason,rowVersion:a.row_version});   // only these two fields
  MAR.busy=false;if(!marOk(pid))return;
  if(r.status===200){delete MAR.f['mr_r'+id];toast('Administration marked as entered in error.');await marLoad();return}
  MAR.err[id]=apiMsg(r);
  if(r.status===409)await marLoad();else renderMar();
}
