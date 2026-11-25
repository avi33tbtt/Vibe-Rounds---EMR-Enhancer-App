// R4g-2: Investigations (on the Orders tab). Investigation orders, specimens and results. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (who may order or record, final rows, stale versions, which terms are usable). The page only shows the buttons the role may use and
   the server's own message when it refuses. Values, units and reference text are shown exactly as typed: nothing is computed, compared or interpreted, and the
   flag is only what the person who recorded the result chose. A mistake is corrected by a new result with a reason; the old one stays, shown as replaced.
   Who and when are the server's values. All text is escaped. */
const INV={items:[],pid:null,all:false,msg:'',loaded:false,busy:false,err:{},f:{},terms:[],open:{},data:{},cor:null,formErr:''};
const INV_ST={active:'active',cancelled:'cancelled',entered_in_error:'entered in error'};
const INV_FLAG={not_stated:'flag not stated',normal:'flagged normal by the recorder',abnormal:'flagged abnormal by the recorder'};
const INV_PRI=['routine','urgent'];
const invReset=()=>{INV.items=[];INV.pid=null;INV.msg='';INV.loaded=false;INV.err={};INV.f={};INV.terms=[];INV.open={};INV.data={};INV.cor=null;INV.formErr=''};
const invOk=pid=>srvCan('orders:read')&&!!CASE&&CASE.patientId===pid;   // false after sign-out or when another patient was opened meanwhile
const invT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const invV=id=>escA(INV.f[id]||'');
const invIn=(id,ph,max)=>`<input id="${id}" data-k="1" placeholder="${escA(ph)}" maxlength="${max}" value="${invV(id)}" aria-label="${escA(ph)}" style="flex:1">`;
const invTa=(id,ph)=>`<textarea id="${id}" data-k="1" rows="2" maxlength="1000" placeholder="${escA(ph)}" aria-label="${escA(ph)}" style="width:100%">${invV(id)}</textarea>`;
const invSel=(id,ph,opts)=>`<select id="${id}" data-k="1" aria-label="${escA(ph)}" style="flex:1"><option value="">${escA(ph)}</option>${opts.map(([v,l])=>`<option value="${escA(v)}"${String(v)===String(INV.f[id]||'')?' selected':''}>${escA(l)}</option>`).join('')}</select>`;
const invClear=pre=>Object.keys(INV.f).forEach(k=>{if(k.startsWith(pre))delete INV.f[k]});
function invKeep(){const b=$('invBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{INV.f[e.id]=e.value})}
async function invLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('orders:read')||!pid){invReset();INV.pid=pid||null;return renderInvest()}
  INV.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/investigation-orders'+(INV.all?'?include=all':''));
  if(!invOk(pid))return;
  if(r.status!==200){INV.msg='The investigations could not be loaded: '+apiMsg(r);INV.items=[];INV.loaded=true;return renderInvest()}
  INV.items=r.body.orders||[];INV.msg='';INV.loaded=true;
  if(srvCan('orders:write')&&srvCan('terms:read')){   // published local test terms (names only), for the optional picker; failure just leaves free text
    const t=await api('GET','/api/local-terms?status=published');
    if(!invOk(pid))return;
    INV.terms=t.status===200?(t.body.terms||[]).filter(x=>x.status==='published'&&x.category==='test'):[];
  }else INV.terms=[];
  if(srvCan('results:read'))await Promise.all(Object.keys(INV.open).filter(k=>INV.items.some(o=>String(o.id)===k)).map(k=>invFetch(Number(k),pid)));
  if(invOk(pid))renderInvest();
}
async function invFetch(id,pid){
  const r=await api('GET','/api/investigation-orders/'+id+'/results');
  if(!invOk(pid))return;
  INV.data[id]=r.status===200?{specimens:r.body.specimens||[],results:r.body.results||[]}:{error:'The results could not be loaded: '+apiMsg(r)};
}
function invFlds(p,reasonKey){   // result boxes: value, unit, reference text, flag (and the reason box when correcting)
  const sp=reasonKey?'':(INV.data[p.id]||{specimens:[]}).specimens.map(s=>[s.id,'#'+s.id+' '+s.specimen_type]);
  const k=(reasonKey?'iv_c':'iv_a')+p.id+'_';
  return `<div class="field-row">${invIn(k+'v','value, as reported (required)',500)}${invIn(k+'u','unit (optional)',100)}${invIn(k+'r','reference text (optional)',200)}</div>
    <div class="field-row">${invSel(k+'f','flag (optional; chosen by you)',[['normal','normal'],['abnormal','abnormal'],['not_stated','not stated']])}${sp&&sp.length?invSel(k+'s','specimen (optional)',sp):''}</div>${reasonKey?invTa(k+'x','Reason for the correction (required, up to 1000 characters)'):''}`;
}
function invDetail(o){
  if(!srvCan('results:read'))return'<div class="mu">Your role cannot see results.</div>';
  const d=INV.data[o.id];
  if(!d)return'<div class="mu">Loading…</div>';
  if(d.error)return`<div class="gen-warn">${escA(d.error)}</div>`;
  const wr=srvCan('results:write')&&o.status==='active',dis=INV.busy?' disabled':'',id=escA(o.id);
  let h='<div style="margin-top:6px"><b>Specimens</b>'+(d.specimens.length?d.specimens.map(s=>`<div class="mu">#${escA(s.id)} ${escA(s.specimen_type)} · collected ${invT(s.collected_at)} · recorded by ${escA(s.recorded_by)} · ${invT(s.recorded_at)}</div>`).join(''):'<div class="mu">No specimen recorded.</div>');
  h+='<div style="margin-top:6px"><b>Results</b>'+(d.results.length?'':'<div class="mu">No result recorded.</div>');
  d.results.forEach(x=>{
    const rid=escA(x.id);
    h+=`<div class="mu"${x.replaced?' style="text-decoration:line-through"':''}>#${rid} ${escA(x.value_text)}${x.unit_text?' '+escA(x.unit_text):''}${x.reference_text?' · reference '+escA(x.reference_text):''} · ${escA(INV_FLAG[x.flag]||x.flag)} · recorded by ${escA(x.recorded_by)} · ${invT(x.recorded_at)}${x.specimen_id?' · specimen #'+escA(x.specimen_id):''}${x.replaces_result_id?' · replaces result #'+escA(x.replaces_result_id)+': '+escA(x.correction_reason):''}</div>`;
    if(x.replaced)h+='<div class="mu">Replaced by a later result (kept, never deleted).</div>';
    else if(wr&&INV.cor!==x.id)h+=`<div class="flex"><button class="b sec sm" data-act="invCorOpen" data-arg="${rid}"${dis}>Correct</button></div>`;
    if(wr&&INV.cor===x.id&&!x.replaced)h+=`<div class="cd" style="margin-top:4px"><b>Correct result #${rid}</b> <span class="mu">(a new result replaces it; the old one is kept)</span>${invFlds({id:x.id},true)}
      <div class="flex" style="margin-top:4px"><button class="b sm" data-act="invCorSave" data-arg="${rid}"${dis}>Save correction</button> <button class="b sec sm" data-act="invCorCancel">Cancel</button></div>${INV.err['c'+x.id]?`<div class="gen-warn">${escA(INV.err['c'+x.id])}</div>`:''}</div>`;
  });
  h+='</div>';
  if(wr)h+=`<div class="cd" style="margin-top:6px"><b>Record a specimen</b> <span class="mu">(collection time is the time you record it)</span><div class="field-row">${invIn('iv_s'+o.id,'specimen type (required)',200)}</div>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="invSpec" data-arg="${id}"${dis}>Record specimen</button></div></div>
    <div class="cd" style="margin-top:6px"><b>Record a result</b> <span class="mu">(typed as reported; the page never compares or interprets it)</span>${invFlds({id:o.id},false)}
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="invResult" data-arg="${id}"${dis}>Record result</button></div></div>`;
  return h+'</div>';
}
function renderInvest(){
  const box=$('invBox');if(!box)return;
  if(!srvCan('orders:read')){invReset();box.innerHTML='';return}
  invKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const w=srvCan('orders:write'),dis=INV.busy?' disabled':'';
  let h=`<h3>Investigations</h3><div class="note">Investigation orders and results of <b>${escA(caseName(CASE))}</b> (synthetic data only). Results are shown exactly as typed; the page computes and interprets nothing, and a flag is only what the person recording it chose. An order is never deleted: cancel it or mark it as entered in error. A result is never edited: a correction is a new result with a reason. Who and when are recorded by the server.
    <label class="mu"><input type="checkbox" id="iv_all" data-act="invAll" data-ev="change"${INV.all?' checked':''}> Show entered in error</label> <button class="b sec sm" data-act="invReload">Reload</button>${INV.msg?' '+escA(INV.msg):''}</div>`;
  if(w){
    const opts=INV.terms.map(t=>[t.id,t.display+' ('+t.code+')']);
    h+=`<div class="cd"><b>New investigation order</b> <span class="mu">(free text is never treated as verified; a local test term is a name only)</span>
      <div class="field-row">${invIn('iv_n_name','test, in your own words',200)}${INV.terms.length?invSel('iv_n_term','or pick a local test term',opts):''}</div>
      <div class="field-row">${invSel('iv_n_pri','priority (routine if left blank)',INV_PRI.map(p=>[p,p]))}${invIn('iv_n_info','clinical information (optional)',500)}</div>
      <div class="flex" style="margin-top:4px"><button class="b sm" data-act="invAdd"${dis}>Place order</button></div>${INV.formErr?`<div class="gen-warn">${escA(INV.formErr)}</div>`:''}</div>`;
  }
  if(INV.loaded&&!INV.items.length&&!INV.msg)h+='<div class="empty">No investigation orders for this patient.</div>';
  INV.items.forEach(o=>{
    const id=escA(o.id),st=o.status,gone=st==='entered_in_error',isOpen=!!INV.open[o.id];
    h+=`<div class="cd"><b${gone?' style="text-decoration:line-through"':''}>${escA(o.test_name)}</b> <span class="bd" style="background:var(${gone?'--r':st==='active'?'--a':'--g'})">${escA(INV_ST[st]||st)}</span> <span class="mu">${escA(o.priority)} · ${o.term_id?'local test term':'free text, not verified'}</span>
      ${o.clinical_info?`<div class="mu">Clinical information: ${escA(o.clinical_info)}</div>`:''}<div class="mu">Ordered by ${escA(o.ordered_by)} · ${invT(o.ordered_at)}</div>`;
    if(o.cancelled_by)h+=`<div class="mu">Cancelled by ${escA(o.cancelled_by)} · ${invT(o.cancelled_at)}: ${escA(o.cancel_reason)}</div>`;
    if(gone)h+=`<div class="mu">Marked in error by ${escA(o.error_by)} · ${invT(o.error_at)}: ${escA(o.error_reason)}</div><div class="mu">Final: an entry made in error is never changed.</div>`;
    else if(w)h+=`<div style="margin-top:6px">${invTa('iv_r'+o.id,'Reason (required to cancel or mark in error, up to 1000 characters)')}
      <div class="flex" style="margin-top:4px">${st==='active'?`<button class="b sm" data-act="invCancel" data-arg="${id}"${dis}>Cancel order</button> `:''}<button class="b sec sm" data-act="invError" data-arg="${id}"${dis}>Entered in error</button></div></div>`;
    else h+='<div class="mu">Your role cannot change orders.</div>';
    if(INV.err[o.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(INV.err[o.id])}</div>`;
    if(srvCan('results:read'))h+=`<div class="flex" style="margin-top:6px"><button class="b sec sm" data-act="invOpen" data-arg="${id}">${isOpen?'Hide':'Show'} specimens and results</button></div>${isOpen?invDetail(o):''}`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function invOpen(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!pid||!srvCan('results:read'))return;
  const id=Number(arg);
  if(INV.open[id]){delete INV.open[id];INV.cor=null;return renderInvest()}
  INV.open[id]=true;renderInvest();await invFetch(id,pid);if(invOk(pid))renderInvest();
}
// One POST. On success the drafts named in `clear` are dropped and everything is reloaded; on failure the server's message is shown at `key`.
async function invSend(path,body,key,msg,clear,oid){
  const pid=CASE&&CASE.patientId;
  INV.busy=true;renderInvest();
  const r=await api('POST',path,body);
  INV.busy=false;if(!invOk(pid))return;
  if(r.status===200||r.status===201){clear.forEach(invClear);INV.cor=null;if(oid)INV.open[oid]=true;toast(msg);await invLoad();abnLoad();return}
  INV.err[key]=apiMsg(r);
  if(r.status===409)await invLoad();else renderInvest();
}
async function invAdd(){
  const pid=CASE&&CASE.patientId;
  if(INV.busy||!pid||!srvCan('orders:write'))return;
  invKeep();INV.formErr='';
  const g=k=>(INV.f['iv_n_'+k]||'').trim(),b={};
  if(g('term')){const n=Number(g('term'));if(!Number.isInteger(n)||n<1){INV.formErr='Pick a valid term.';return renderInvest()}b.termId=n}   // a picked term replaces the typed name
  else if(g('name'))b.testName=g('name');
  else{INV.formErr='An order needs a test: type it or pick a local test term.';return renderInvest()}
  if(g('pri')){if(!INV_PRI.includes(g('pri'))){INV.formErr='Pick a valid priority.';return renderInvest()}b.priority=g('pri')}
  if(g('info'))b.clinicalInfo=g('info');
  const sid=Number(CASE.serverId);if(Number.isInteger(sid)&&sid>=1)b.originCaseId=sid;   // only these fields are ever sent
  INV.busy=true;renderInvest();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/investigation-orders',b);
  INV.busy=false;if(!invOk(pid))return;
  if(r.status===201){invClear('iv_n_');toast('Investigation ordered.');await invLoad();return}
  INV.formErr=apiMsg(r);renderInvest();
}
async function invMove(kind,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||INV.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),o=INV.items.find(x=>x.id===id);if(!o)return;
  invKeep();delete INV.err[id];
  const reason=(INV.f['iv_r'+id]||'').trim();
  if(!reason){INV.err[id]='A reason is required.';return renderInvest()}
  if(!confirm((kind==='cancel'?'Cancel':'Mark as entered in error')+' this order?'+(kind==='error'?' This is final.':'')))return;
  await invSend('/api/investigation-orders/'+id+'/'+(kind==='cancel'?'cancel':'entered-in-error'),{reason,rowVersion:o.row_version},id,kind==='cancel'?'Order cancelled.':'Order marked as entered in error.',['iv_r'+id],0);   // only these two fields
}
async function invSpec(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||INV.busy||!pid||!srvCan('results:write'))return;
  const id=Number(arg);invKeep();delete INV.err[id];
  const t=(INV.f['iv_s'+id]||'').trim();
  if(!t){INV.err[id]='A specimen type is required.';return renderInvest()}
  await invSend('/api/investigation-orders/'+id+'/specimens',{specimenType:t},id,'Specimen recorded.',['iv_s'+id],id);
}
function invBody(p){   // request fields from the result boxes with prefix p, or an error text
  const g=k=>(INV.f[p+k]||'').trim(),b={valueText:g('v')};
  if(!b.valueText)return{error:'A value is required, typed as reported.'};
  if(g('u'))b.unitText=g('u');
  if(g('r'))b.referenceText=g('r');
  if(g('f')){if(!Object.hasOwn(INV_FLAG,g('f')))return{error:'Pick a valid flag.'};b.flag=g('f')}
  return{body:b};
}
async function invResult(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||INV.busy||!pid||!srvCan('results:write'))return;
  const id=Number(arg);invKeep();delete INV.err[id];
  const r0=invBody('iv_a'+id+'_');
  if(r0.error){INV.err[id]=r0.error;return renderInvest()}
  const s=Number(INV.f['iv_a'+id+'_s']);if(Number.isInteger(s)&&s>=1)r0.body.specimenId=s;
  await invSend('/api/investigation-orders/'+id+'/results',r0.body,id,'Result recorded.',['iv_a'+id+'_'],id);
}
function invCorOpen(arg){
  if(!/^\d{1,9}$/.test(arg||'')||!srvCan('results:write'))return;
  INV.cor=Number(arg);delete INV.err['c'+arg];invClear('iv_c'+arg+'_');renderInvest();   // blank on purpose: the person types the corrected result
}
const invCorCancel=()=>{INV.cor=null;renderInvest()};
async function invCorSave(arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||INV.busy||!pid||!srvCan('results:write'))return;
  const rid=Number(arg);if(INV.cor!==rid)return;
  invKeep();const key='c'+rid;delete INV.err[key];
  const oid=Object.keys(INV.data).find(k=>INV.data[k].results&&INV.data[k].results.some(x=>x.id===rid));if(!oid)return;
  const p='iv_c'+rid+'_',reason=(INV.f[p+'x']||'').trim(),r0=invBody(p);
  if(r0.error){INV.err[key]=r0.error;return renderInvest()}
  if(!reason){INV.err[key]='A reason is required.';return renderInvest()}
  if(!confirm('Correct this result? A new result replaces it; the old one is kept.'))return;
  r0.body.reason=reason;   // who and when are the session's
  await invSend('/api/investigation-results/'+rid+'/correct',r0.body,key,'Result corrected.',[p],Number(oid));
}
