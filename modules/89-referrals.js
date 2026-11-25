// R4h-2: Referrals (on the Orders tab). Refer, cancel, mark entered in error. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (who may refer, final rows, stale versions); this page only shows the buttons the role may use and the server's own message when
   it refuses. Destination and reason are typed by the clinician: nothing is suggested, matched or checked, and nothing is sent to anyone (this records the referral
   only). A referral is never edited or deleted: cancel it or mark it as entered in error, each with a reason. Who and when are the server's values. All text is escaped. */
const REF={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},f:{},formErr:''};
const REF_ST={active:'active',cancelled:'cancelled',entered_in_error:'entered in error'};
const REF_PRI=['routine','urgent'];
const refReset=()=>{REF.items=[];REF.pid=null;REF.msg='';REF.loaded=false;REF.err={};REF.f={};REF.formErr=''};
const refOk=pid=>srvCan('orders:read')&&!!CASE&&CASE.patientId===pid;   // false after sign-out or when another patient was opened meanwhile
const refT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const refV=id=>escA(REF.f[id]||'');
function refKeep(){const b=$('refBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{REF.f[e.id]=e.value})}
async function refLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('orders:read')||!pid){refReset();REF.pid=pid||null;return renderReferrals()}
  REF.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/referrals'+(REF.all?'?include=all':''));
  if(!refOk(pid))return;
  if(r.status!==200){REF.msg='The referrals could not be loaded: '+apiMsg(r);REF.items=[];REF.loaded=true;return renderReferrals()}
  REF.items=r.body.referrals||[];REF.msg='';REF.loaded=true;renderReferrals();
}
function renderReferrals(){
  const box=$('refBox');if(!box)return;
  if(!srvCan('orders:read')){refReset();box.innerHTML='';return}
  refKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const w=srvCan('orders:write'),dis=REF.busy?' disabled':'';
  let h=`<h3>Referrals</h3><div class="note">Referrals of <b>${escA(caseName(CASE))}</b> (synthetic data only). Destination and reason are exactly what the clinician types: the page suggests and checks nothing, and a referral recorded here is not sent anywhere. A referral is never deleted or edited: cancel it or mark it as entered in error, with a reason. Who and when are recorded by the server.
    <label class="mu"><input type="checkbox" id="rf_all" data-act="refAll" data-ev="change"${REF.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="refReload">Reload</button>${REF.msg?' '+escA(REF.msg):''}</div>`;
  if(w)h+=`<div class="cd"><b>New referral</b>
    <div class="field-row"><input id="rf_n_dest" data-k="1" placeholder="refer to (required), in your own words" maxlength="200" value="${refV('rf_n_dest')}" aria-label="Refer to" style="flex:1"></div>
    <div class="field-row"><input id="rf_n_why" data-k="1" placeholder="reason for referral (required)" maxlength="500" value="${refV('rf_n_why')}" aria-label="Reason for referral" style="flex:1.4">
      <select id="rf_n_pri" data-k="1" aria-label="Priority" style="flex:1"><option value="">priority (routine if left blank)</option>${REF_PRI.map(p=>`<option value="${p}"${REF.f.rf_n_pri===p?' selected':''}>${p}</option>`).join('')}</select></div>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="refAdd"${dis}>Record referral</button></div>${REF.formErr?`<div class="gen-warn">${escA(REF.formErr)}</div>`:''}</div>`;
  if(REF.loaded&&!REF.items.length&&!REF.msg)h+='<div class="empty">No referrals for this patient.</div>';
  REF.items.forEach(o=>{
    const id=escA(o.id),st=o.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(o.destination_text)}</b> <span class="bd" style="background:var(${gone?'--r':st==='active'?'--a':'--g'})">${escA(REF_ST[st]||st)}</span> <span class="mu">${escA(o.priority)}</span>
      <div class="mu">Reason: ${escA(o.reason_text)}</div><div class="mu">Referred by ${escA(o.referred_by)} · ${refT(o.referred_at)}</div>`;
    if(o.cancelled_by)h+=`<div class="mu">Cancelled by ${escA(o.cancelled_by)} · ${refT(o.cancelled_at)}: ${escA(o.cancel_reason)}</div>`;
    if(gone)h+=`<div class="mu">Marked in error by ${escA(o.error_by)} · ${refT(o.error_at)}: ${escA(o.error_reason)}</div><div class="mu">Final: an entry made in error is never changed.</div>`;
    else if(w)h+=`<div style="margin-top:6px"><textarea id="rf_r${id}" data-k="1" rows="2" maxlength="1000" placeholder="Reason (required to cancel or mark in error, up to 1000 characters)" aria-label="Reason" style="width:100%">${refV('rf_r'+o.id)}</textarea>
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="refCancel" data-arg="${id}"${dis}>Cancel referral</button> `:''}<button class="b sec sm" data-act="refError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change referrals.</div>';
    if(REF.err[o.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(REF.err[o.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function refAdd(){
  const pid=CASE&&CASE.patientId;
  if(REF.busy||!pid||!srvCan('orders:write'))return;
  refKeep();REF.formErr='';
  const g=k=>(REF.f['rf_n_'+k]||'').trim(),b={destination:g('dest'),reason:g('why')};
  if(!b.destination||!b.reason){REF.formErr='A referral needs who it is to and a reason, as the clinician types them.';return renderReferrals()}
  if(g('pri')){if(!REF_PRI.includes(g('pri'))){REF.formErr='Pick a valid priority.';return renderReferrals()}b.priority=g('pri')}
  const sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)b.originCaseId=sid;   // only these fields are ever sent
  REF.busy=true;renderReferrals();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/referrals',b);
  REF.busy=false;if(!refOk(pid))return;
  if(r.status===201){['rf_n_dest','rf_n_why','rf_n_pri'].forEach(k=>delete REF.f[k]);toast('Referral recorded.');await refLoad();return}
  REF.formErr=apiMsg(r);renderReferrals();
}
async function refMove(kind,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!['cancel','error'].includes(kind)||REF.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=REF.items.find(x=>x.id===id);if(!o)return;
  refKeep();delete REF.err[id];
  const reason=(REF.f['rf_r'+id]||'').trim();
  if(!reason){REF.err[id]='A reason is required.';return renderReferrals()}
  if(!confirm((kind==='cancel'?'Cancel':'Mark as entered in error')+' this referral?'+(kind==='error'?' This is final.':'')))return;
  REF.busy=true;renderReferrals();
  const r=await api('POST','/api/referrals/'+id+'/'+(kind==='cancel'?'cancel':'entered-in-error'),{reason,rowVersion:o.row_version});   // only these two fields
  REF.busy=false;if(!refOk(pid))return;
  if(r.status===200){delete REF.f['rf_r'+id];toast(kind==='cancel'?'Referral cancelled.':'Referral marked as entered in error.');await refLoad();return}
  REF.err[id]=apiMsg(r);
  if(r.status===409)await refLoad();else renderReferrals();
}
