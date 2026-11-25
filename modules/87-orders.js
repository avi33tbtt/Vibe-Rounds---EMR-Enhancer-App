// R4c: Orders screen (medication orders: order, change with reason, stop, mark entered in error). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (who may order, status steps, stale versions, final rows, which terms are usable); this page only shows the buttons the
   role may use and the server's own message when it refuses. Dose, route and frequency are typed by the clinician: nothing is suggested or checked.
   The orderer and the times are the server's values. A drug term is a name only (no dose or safety content). All text is escaped. */
const ORD={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},draft:{},terms:[],chg:null,form:{name:'',term:'',dose:'',route:'',freq:'',ind:''},cform:{name:'',term:'',dose:'',route:'',freq:'',ind:''},formErr:''};
const ORD_LBL={active:'active',stopped:'stopped',changed:'changed',entered_in_error:'entered in error'};
const ORD_PATH={stop:'stop',error:'entered-in-error'};
const ORD_DONE={stop:'Order stopped.',error:'Order marked as entered in error.'};
const ordReset=()=>{ORD.items=[];ORD.pid=null;ORD.msg='';ORD.loaded=false;ORD.err={};ORD.draft={};ORD.terms=[];ORD.chg=null;ORD.formErr=''};
const ordTime=v=>escA(String(v||'').slice(0,16).replace('T',' '));
function renderOrdersNav(){
  const b=$('navOrders');if(!b)return;
  const show=srvCan('orders:read');b.style.display=show?'':'none';
  if(!show){ordReset();if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
async function ordersLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('orders:read')||!pid){ordReset();ORD.pid=pid||null;return renderOrders()}
  ORD.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/medication-orders'+(ORD.all?'?include=all':''));
  if(!srvCan('orders:read')||!CASE||CASE.patientId!==pid)return;   // signed out or another patient opened meanwhile
  if(r.status!==200){ORD.msg='The orders could not be loaded: '+apiMsg(r);ORD.items=[];ORD.loaded=true;return renderOrders()}
  ORD.items=r.body.orders||[];ORD.msg='';ORD.loaded=true;
  if(srvCan('orders:write')&&srvCan('terms:read')){   // published local drug terms (names only), for the optional picker; failure just leaves free text
    const t=await api('GET','/api/local-terms?status=published');
    if(!srvCan('orders:read')||!CASE||CASE.patientId!==pid)return;
    ORD.terms=t.status===200?(t.body.terms||[]).filter(x=>x.status==='published'&&x.category==='drug'):[];
  }else ORD.terms=[];
  renderOrders();
}
const ORD_IDS={of:['name','term','dose','route','freq','ind'],oc:['name','term','dose','route','freq','ind']};
function ordKeep(){
  [['of','form'],['oc','cform']].forEach(([p,k])=>ORD_IDS[p].forEach(f=>{const e=$(p+'_'+f);if(e)ORD[k][f]=e.value}));
}
// The name/dose/route/frequency/indication boxes of the add form (p='of') or the change form (p='oc').
function ordFields(p,f){
  const opts=ORD.terms.map(t=>`<option value="${escA(t.id)}"${String(t.id)===String(f.term)?' selected':''}>${escA(t.display)} (${escA(t.code)})</option>`).join('');
  return `<div class="field-row"><input id="${p}_name" placeholder="medication, in your own words" maxlength="200" value="${escA(f.name)}" aria-label="Medication (free text)" style="flex:1.4">
    ${ORD.terms.length?`<select id="${p}_term" aria-label="Or a local drug term" style="flex:1"><option value="">or pick a local drug term</option>${opts}</select>`:''}</div>
    <div class="field-row"><input id="${p}_dose" placeholder="dose (required, as you type it)" maxlength="200" value="${escA(f.dose)}" aria-label="Dose" style="flex:1">
    <input id="${p}_route" placeholder="route (required)" maxlength="200" value="${escA(f.route)}" aria-label="Route" style="flex:1">
    <input id="${p}_freq" placeholder="frequency (required)" maxlength="200" value="${escA(f.freq)}" aria-label="Frequency" style="flex:1"></div>
    <div class="field-row"><input id="${p}_ind" placeholder="indication (optional)" maxlength="500" value="${escA(f.ind)}" aria-label="Indication (optional)" style="flex:1"></div>`;
}
// Build the request fields from a form, or return an error text. A picked term replaces the typed name (the server copies the term's name).
function ordBody(f){
  const b={},name=f.name.trim(),dose=f.dose.trim(),route=f.route.trim(),freq=f.freq.trim(),ind=f.ind.trim();
  if(f.term){const n=Number(f.term);if(!Number.isInteger(n)||n<1)return{error:'Pick a valid term.'};b.termId=n}
  else if(name)b.medication=name;
  else return{error:'An order needs a medication: type it or pick a local drug term.'};
  if(!dose||!route||!freq)return{error:'An order needs a dose, a route and a frequency, as the clinician types them.'};
  b.doseText=dose;b.routeText=route;b.frequencyText=freq;if(ind)b.indicationText=ind;
  return{body:b};
}
function renderOrders(){
  const box=$('ordersBox');if(!box)return;
  if(!srvCan('orders:read')){box.innerHTML='';return}
  ordKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='<div class="empty">Open a registered patient\'s case first (Patients tab). Orders belong to the patient, not to one case.</div>';return}
  const dis=ORD.busy?' disabled':'',w=srvCan('orders:write');
  let h=`<div class="note">Medication orders of <b>${escA(caseName(CASE))}</b> (synthetic data only). Dose, route and frequency are exactly what the clinician types: the page suggests and checks nothing. An order is never deleted or edited: stop it, change it (a new order replaces it) or mark it entered in error, each with a reason. Who and when are recorded by the server.${ORD.msg?' '+escA(ORD.msg):''}
    <label class="mu"><input type="checkbox" id="of_all" data-act="orderAll" data-ev="change"${ORD.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="orderReload">Reload</button></div>`;
  if(w)h+=`<div class="cd"><b>New medication order</b> <span class="mu">(free text is never treated as verified; a local drug term is a name only)</span>${ordFields('of',ORD.form)}
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="orderAdd"${dis}>Place order</button></div>${ORD.formErr?`<div class="gen-warn">${escA(ORD.formErr)}</div>`:''}</div>`;
  if(ORD.loaded&&!ORD.items.length&&!ORD.msg)h+='<div class="empty">No medication orders for this patient.</div>';
  ORD.items.forEach(o=>{
    const id=escA(o.id),st=o.status,gone=st==='entered_in_error';
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(o.medication)}</b> <span class="bd" style="background:var(${gone?'--r':st==='active'?'--a':'--g'})">${escA(ORD_LBL[st]||st)}</span>
      <span class="mu">${o.term_id?'local drug term':'free text, not verified'}</span>
      <div class="mu">Dose ${escA(o.dose_text)} · route ${escA(o.route_text)} · frequency ${escA(o.frequency_text)}${o.indication_text?' · for '+escA(o.indication_text):''}</div>
      <div class="mu">Ordered by ${escA(o.ordered_by)} · ${ordTime(o.ordered_at)}${o.replaces_order_id?' · replaces order #'+escA(o.replaces_order_id):''}</div>`;
    if(o.ended_by)h+=`<div class="mu">${st==='changed'?'Changed (a new order replaces it)':'Stopped'} by ${escA(o.ended_by)} · ${ordTime(o.ended_at)}: ${escA(o.end_reason)}</div>`;
    if(gone)h+=`<div class="mu">Marked in error by ${escA(o.error_by)} · ${ordTime(o.error_at)}: ${escA(o.error_reason)}</div><div class="mu">Final: an entry made in error is never changed.</div>`;
    else if(w){
      h+=`<div style="margin-top:6px"><textarea id="or_${id}" rows="2" maxlength="1000" placeholder="Reason (required, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(ORD.draft[o.id]||'')}</textarea>
        <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="orderStop" data-arg="${id}"${dis}>Stop</button> <button class="b sec sm" data-act="orderChangeOpen" data-arg="${id}"${dis}>Change</button> `:''}<button class="b sec sm" data-act="orderError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
      if(ORD.chg===o.id&&st==='active')h+=`<div class="cd" style="margin-top:6px"><b>Change this order</b> <span class="mu">(the old order is kept as changed; the reason above is recorded; nothing is carried over unless you type it)</span>${ordFields('oc',ORD.cform)}
        <div class="flex" style="margin-top:4px"><button class="b sm" data-act="orderChangeSave" data-arg="${id}"${dis}>Save change</button> <button class="b sec sm" data-act="orderChangeCancel">Cancel</button></div></div>`;
    }else h+='<div class="mu">Your role cannot change orders.</div>';
    if(ORD.err[o.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(ORD.err[o.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function orderAdd(){
  const pid=CASE&&CASE.patientId;
  if(ORD.busy||!pid||!srvCan('orders:write'))return;
  ordKeep();
  const r0=ordBody(ORD.form);ORD.formErr='';
  if(r0.error){ORD.formErr=r0.error;return renderOrders()}
  const body=r0.body,sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)body.originCaseId=sid;   // only these fields are ever sent
  ORD.busy=true;renderOrders();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/medication-orders',body);
  ORD.busy=false;if(!srvCan('orders:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===201){ORD.form={name:'',term:'',dose:'',route:'',freq:'',ind:''};ORD_IDS.of.forEach(f=>{const e=$('of_'+f);if(e)e.value=''});   // clear the boxes too: renderOrders reads them back
    toast('Order placed.');await ordersLoad();return}
  ORD.formErr=apiMsg(r);renderOrders();
}
function orderChangeOpen(arg){
  if(!/^\d{1,9}$/.test(arg||'')||!srvCan('orders:write'))return;
  const o=ORD.items.find(x=>x.id===Number(arg));if(!o||o.status!=='active')return;
  ORD.chg=o.id;ORD.cform={name:'',term:'',dose:'',route:'',freq:'',ind:''};renderOrders();   // blank on purpose: the clinician types the new order
}
const orderChangeCancel=()=>{ORD.chg=null;renderOrders()};
async function orderChangeSave(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||ORD.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=ORD.items.find(x=>x.id===id);if(!o||ORD.chg!==id)return;
  ordKeep();delete ORD.err[id];
  const ta=$('or_'+id),reason=ta?ta.value.trim():'';ORD.draft[id]=reason;
  if(!reason){ORD.err[id]='A reason is required.';return renderOrders()}
  const r0=ordBody(ORD.cform);
  if(r0.error){ORD.err[id]=r0.error;return renderOrders()}
  if(!confirm('Change this order? The old order is kept as changed and a new order replaces it.'))return;
  const body=r0.body;body.reason=reason;body.rowVersion=o.row_version;   // who and when are the session's
  ORD.busy=true;renderOrders();
  const r=await api('POST','/api/medication-orders/'+id+'/change',body);
  ORD.busy=false;if(!srvCan('orders:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===200){delete ORD.draft[id];ORD.chg=null;toast('Order changed.');await ordersLoad();return}
  ORD.err[id]=apiMsg(r);
  if(r.status===409)await ordersLoad();else renderOrders();
}
async function orderStep(action,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!Object.hasOwn(ORD_PATH,action)||ORD.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=ORD.items.find(x=>x.id===id);if(!o)return;
  ordKeep();delete ORD.err[id];
  const ta=$('or_'+id),reason=ta?ta.value.trim():'';ORD.draft[id]=reason;
  if(!reason){ORD.err[id]='A reason is required.';return renderOrders()}
  if(!confirm((action==='stop'?'Stop':'Mark as entered in error')+' this order?'+(action==='error'?' This is final.':'')))return;
  ORD.busy=true;renderOrders();
  const r=await api('POST','/api/medication-orders/'+id+'/'+ORD_PATH[action],{reason,rowVersion:o.row_version});   // only these two fields
  ORD.busy=false;if(!srvCan('orders:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===200){delete ORD.draft[id];toast(ORD_DONE[action]);await ordersLoad();return}
  ORD.err[id]=apiMsg(r);
  if(r.status===409)await ordersLoad();else renderOrders();
}
