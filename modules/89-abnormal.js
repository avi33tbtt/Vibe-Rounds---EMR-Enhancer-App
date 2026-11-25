// R4g-3: Abnormal results waiting for acknowledgement (on the Orders tab). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* "Abnormal" is only the flag the person who recorded the result chose: the page computes and decides nothing. The server lists the newest results flagged abnormal
   (waiting and acknowledged), decides who may acknowledge (results:ack) and keeps every acknowledgement (one per result). The acknowledger and the time are the
   server's values; the optional note is the only thing sent. All text is escaped. */
const ABN={pending:[],done:[],pid:null,msg:'',loaded:false,busy:false,err:{},note:{}};
const abnReset=()=>{ABN.pending=[];ABN.done=[];ABN.pid=null;ABN.msg='';ABN.loaded=false;ABN.err={};ABN.note={}};
const abnOk=pid=>srvCan('results:read')&&!!CASE&&CASE.patientId===pid;   // false after sign-out or when another patient was opened meanwhile
const abnT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
async function abnLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('results:read')||!pid){abnReset();ABN.pid=pid||null;return renderAbnormal()}
  ABN.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/abnormal-results');
  if(!abnOk(pid))return;
  if(r.status!==200){ABN.msg='The abnormal results could not be loaded: '+apiMsg(r);ABN.pending=[];ABN.done=[];ABN.loaded=true;return renderAbnormal()}
  ABN.pending=r.body.pending||[];ABN.done=r.body.acknowledged||[];ABN.msg='';ABN.loaded=true;renderAbnormal();
}
function abnKeep(){ABN.pending.forEach(x=>{const e=$('ab_n_'+x.id);if(e)ABN.note[x.id]=e.value})}
function abnLine(x){
  return `<b>${escA(x.test_name)}</b> <span class="mu">result #${escA(x.id)} (order #${escA(x.order_id)}): ${escA(x.value_text)}${x.unit_text?' '+escA(x.unit_text):''}${x.reference_text?' · reference '+escA(x.reference_text):''} · flagged abnormal by ${escA(x.recorded_by)} · ${abnT(x.recorded_at)}</span>`;
}
function renderAbnormal(){
  const box=$('abnBox');if(!box)return;
  if(!srvCan('results:read')){abnReset();box.innerHTML='';return}
  abnKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const can=srvCan('results:ack'),dis=ABN.busy?' disabled':'';
  let h=`<h3>Abnormal results</h3><div class="note">Results of <b>${escA(caseName(CASE))}</b> (synthetic data only) that the person recording them flagged abnormal. The page decides nothing: a result without that flag is not listed here. Only the newest result of a corrected one is listed. Each acknowledgement is kept with who and when, as recorded by the server. <button class="b sec sm" data-act="abnReload">Reload</button>${ABN.msg?' '+escA(ABN.msg):''}</div>`;
  h+=`<div class="cd"><b>Waiting for acknowledgement (${ABN.pending.length})</b>`;
  if(ABN.loaded&&!ABN.pending.length&&!ABN.msg)h+='<div class="mu">None waiting.</div>';
  ABN.pending.forEach(x=>{
    const id=escA(x.id);
    h+=`<div class="cd">${abnLine(x)}`;
    if(can)h+=`<div style="margin-top:6px"><textarea id="ab_n_${id}" rows="2" maxlength="1000" placeholder="Note (optional, up to 1000 characters)" aria-label="Note" style="width:100%">${escA(ABN.note[x.id]||'')}</textarea>
      <div class="flex" style="margin-top:4px"><button class="b sm" data-act="abnAck" data-arg="${id}"${dis}>Acknowledge</button></div></div>`;
    if(ABN.err[x.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(ABN.err[x.id])}</div>`;
    h+='</div>';
  });
  if(!can&&ABN.pending.length)h+='<div class="mu">Your role cannot acknowledge results.</div>';
  h+='</div>';
  h+=`<div class="cd"><b>Acknowledged (${ABN.done.length})</b>`;
  if(ABN.loaded&&!ABN.done.length&&!ABN.msg)h+='<div class="mu">None acknowledged yet.</div>';
  ABN.done.forEach(x=>{h+=`<div class="cd">${abnLine(x)}<div class="mu">Acknowledged by ${escA(x.acknowledged_by)} · ${abnT(x.acknowledged_at)}${x.ack_note?': '+escA(x.ack_note):''}</div></div>`});
  box.innerHTML=h+'</div>';
}
async function abnAck(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||ABN.busy||!pid||!srvCan('results:ack'))return;
  const id=Number(arg);if(!ABN.pending.some(x=>x.id===id))return;
  abnKeep();delete ABN.err[id];
  const note=(ABN.note[id]||'').trim(),body={};if(note)body.note=note;   // only the note is sent; who and when are the session's
  if(!confirm('Acknowledge this abnormal result?'))return;
  ABN.busy=true;renderAbnormal();
  const r=await api('POST','/api/investigation-results/'+id+'/acknowledge',body);
  ABN.busy=false;if(!abnOk(pid))return;
  if(r.status===201){delete ABN.note[id];toast('Result acknowledged.');await abnLoad();return}
  ABN.err[id]=apiMsg(r);
  if(r.status===409)await abnLoad();else renderAbnormal();
}
