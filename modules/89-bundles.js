// R6f-3: Import tab: choose a FHIR Bundle file, see the proposals the server staged, accept or reject each one. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (which proposals can be accepted, the value and record rules, stale versions, final rows); this page only shows the buttons the role may use and the
   server's own message when it refuses. The chart is the chart that is OPEN (Case tab): nothing is matched from the file, and every accept button and confirm box names that chart.
   Imported values are drafts: an observation starts preliminary with source imported, a problem or allergy starts active. A medication request or a proposal with blockers has no accept
   button. Only the fields the routes take are ever sent (no user, time or status). All text is escaped. */
const BND={list:[],open:null,bundle:null,msg:'',info:'',loaded:false,busy:false,err:{},f:{}};
const BND_PERM={Observation:'cases:write',Condition:'problems:write',AllergyIntolerance:'allergies:write'};
const BND_ST={staged:'to review',accepted:'accepted',rejected:'rejected'};
const BND_KEY=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const bndReset=()=>{BND.list=[];BND.open=null;BND.bundle=null;BND.msg='';BND.info='';BND.loaded=false;BND.err={};BND.f={}};
const bndT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const bndV=id=>escA(BND.f[id]||'');
const bndChart=()=>CASE&&CASE.patientId?CASE:null;   // read again at every draw, so a different open chart or a sign-out never leaves a stale button
function renderBundlesNav(){
  const b=$('navBundles');if(!b)return;
  const show=srvCan('import:write');b.style.display=show?'':'none';
  if(!show){bndReset();const bx=$('bundleBox');if(bx)bx.innerHTML='';if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
function bndKeep(){const b=$('bundleBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{BND.f[e.id]=e.value})}
async function bundlesLoad(){
  if(!srvCan('import:write')){bndReset();return renderBundles()}
  const r=await api('GET','/api/import/bundles');
  if(!srvCan('import:write'))return;
  if(r.status!==200){BND.msg='The staged bundles could not be loaded: '+apiMsg(r);BND.list=[];BND.loaded=true;return renderBundles()}
  BND.list=r.body.bundles||[];BND.msg='';BND.loaded=true;
  if(BND.open!==null)return bndFetch(BND.open);
  renderBundles();
}
async function bndFetch(id){
  const r=await api('GET','/api/import/bundles/'+id);
  if(!srvCan('import:write'))return;
  if(r.status!==200){BND.open=null;BND.bundle=null;BND.msg='The bundle could not be loaded: '+apiMsg(r);return renderBundles()}
  BND.bundle=r.body.bundle;BND.open=id;renderBundles();
}
async function bndOpen(arg){
  if(!/^\d{1,9}$/.test(arg||'')||!srvCan('import:write'))return;
  bndKeep();BND.f={};BND.err={};BND.msg='';BND.info='';await bndFetch(Number(arg));
}
function bndClose(){BND.open=null;BND.bundle=null;BND.f={};BND.err={};renderBundles()}
function bndPick(el){
  const f=el.files&&el.files[0];if(!f||!srvCan('import:write'))return;
  if(f.size>2*1024*1024){BND.info='That file is too large (2 MB at most).';el.value='';return renderBundles()}
  const rd=new FileReader();
  rd.onload=()=>{el.value='';bndSend(String(rd.result))};
  rd.onerror=()=>{el.value='';BND.info='That file could not be read.';renderBundles()};
  rd.readAsText(f);
}
async function bndSend(text){
  if(BND.busy||!srvCan('import:write'))return;
  let j;try{j=JSON.parse(text)}catch(e){BND.info='That file is not valid JSON.';return renderBundles()}
  if(!j||typeof j!=='object'||Array.isArray(j)){BND.info='A FHIR Bundle is a JSON object.';return renderBundles()}
  BND.busy=true;BND.info='Staging…';renderBundles();
  const r=await api('POST','/api/import/bundles',j);   // the parsed file and nothing else
  BND.busy=false;if(!srvCan('import:write'))return;
  if(r.status===201){BND.info='';toast('Bundle staged for review.');BND.f={};BND.err={};BND.open=null;await bundlesLoad();if(r.body.bundle&&r.body.bundle.id)await bndOpen(String(r.body.bundle.id));return}
  if(r.status===409&&r.body.bundleId){BND.info='This bundle was staged before; showing the first copy.';await bundlesLoad();await bndOpen(String(r.body.bundleId));BND.info='This bundle was staged before; showing the first copy.';return renderBundles()}
  BND.info=apiMsg(r);renderBundles();
}
// Why a proposal cannot be accepted here ('' means the accept control is offered). The server checks all of it again.
function bndWhy(p,ch){
  if(p.kind==='MedicationRequest')return'An imported bundle never creates a medication order; a clinician must enter the order.';
  if(!p.ready)return'This proposal has blockers and cannot be accepted.';
  if(!BND_PERM[p.kind])return'This kind of proposal cannot be accepted.';
  if(!srvCan(BND_PERM[p.kind]))return'Your role cannot add this kind of record.';
  if(!ch)return'Open the registered patient\u2019s chart in the Case tab first: the chart is chosen by a person, never matched from the file.';
  if(p.kind==='Observation'){
    if(!ch.serverId||ch.pinsOk!==true)return'The open case is not fully loaded. Open it again.';
    if(!bndTargets(ch).length)return'The open case has no applied set with a field that takes a value.';
  }
  return'';
}
function bndTargets(ch){   // [applied set id, field id, label] for the open case: only fields that take a value (derived fields never do)
  const out=[];
  (ch.applied||[]).filter(a=>a.srvAs).forEach(a=>{const s=resolve(a)||{};(s.fields||[]).forEach(f=>{if(f&&f.id&&!f.derived&&BND_KEY.test(String(f.id)))out.push([Number(a.srvAs),String(f.id),(s.title||a.title||a.setId)+' \u00b7 '+(f.label||f.id)])})});
  return out;
}
function bndFields(p){
  const f=p.fields||{},row=(k,v)=>v===null||v===undefined||v===''?'':`<div class="mu">${escA(k)}: ${escA(v)}</div>`;
  if(p.kind==='Observation')return`<b>${escA(f.label)}</b>`+row('Value',f.valueType==='unknown'?'unknown':(f.value===null||f.value===undefined?'':String(f.value)+(f.unit?' '+f.unit:'')))+row('Effective',String(f.effectiveAt||'').replace('T',' '));
  if(p.kind==='Condition')return`<b>${escA(f.label)}</b>`+row('Onset',f.onsetDate);
  if(p.kind==='AllergyIntolerance')return`<b>${escA(f.substance)}</b>`+row('Reaction',f.reaction)+row('Severity',f.severity)+row('Onset',f.onsetDate);
  return`<b>${escA(f.medication)}</b>`+row('Dosage text (as written, never split)',f.dosageText);
}
function bndSummary(s){
  const o=s&&typeof s==='object'?s:{},parts=[];
  Object.keys(o).forEach(k=>{const v=o[k];
    if(typeof v==='number'||typeof v==='string')parts.push(escA(k)+': '+escA(v));
    else if(v&&typeof v==='object'&&!Array.isArray(v))parts.push(escA(k)+': '+Object.keys(v).map(x=>escA(x)+' '+escA(v[x])).join(', '))});
  return parts.length?`<div class="mu">${parts.join(' \u00b7 ')}</div>`:'';
}
function renderBundles(){
  const box=$('bundleBox');if(!box)return;
  if(!srvCan('import:write')){bndReset();box.innerHTML='';return}
  bndKeep();
  const dis=BND.busy?' disabled':'',ch=bndChart();
  let h=`<div class="note">Choose a FHIR Bundle file (JSON, 2 MB at most). It is only staged as <b>proposals</b> for you to look at: nothing enters a chart until you accept one. The chart is the chart that is <b>open</b> in the Case tab; nothing is matched from the file, and no code from the file is kept. Accepted observations start as preliminary with source imported; a problem or allergy starts as active. A medication request can never be accepted. Synthetic data only.
    <div class="flex" style="margin-top:6px"><button class="b sm" data-act="bndChoose"${dis}>Choose a file</button> <button class="b sec sm" data-act="bndReload">Reload</button></div>
    <div class="mu">${ch?'Open chart: <b>'+escA(caseName(ch))+'</b> (MRN '+escA(caseMrn(ch))+')':'No registered patient\u2019s chart is open.'}</div>${BND.info?`<div class="gen-warn">${escA(BND.info)}</div>`:''}${BND.msg?`<div class="gen-warn">${escA(BND.msg)}</div>`:''}</div>`;
  if(BND.open!==null&&BND.bundle)h+=bndOne(BND.bundle,ch);
  else{
    h+='<h3>Staged bundles</h3>';
    if(BND.loaded&&!BND.list.length&&!BND.msg)h+='<div class="empty">No bundle has been staged yet.</div>';
    BND.list.forEach(b=>{h+=`<div class="cd"><b>Bundle #${escA(b.id)}</b> <span class="mu">${escA(b.bundle_type||'')} · staged by ${escA(b.staged_by)} · ${bndT(b.staged_at)}</span>
      <div class="mu">${escA(b.staged_count)} to review · ${escA(b.accepted_count)} accepted · ${escA(b.rejected_count)} rejected</div>
      <div class="flex" style="margin-top:4px"><button class="b sec sm" data-act="bndOpen" data-arg="${Number(b.id)}">Open</button></div></div>`});
  }
  box.innerHTML=h;
}
function bndOne(b,ch){
  let h=`<div class="flex"><button class="b sec sm" data-act="bndClose">&larr; All bundles</button></div><h3>Bundle #${escA(b.id)}</h3><div class="mu">${escA(b.bundle_type||'')} · staged by ${escA(b.staged_by)} · ${bndT(b.staged_at)}</div>${bndSummary(b.summary)}`;
  (Array.isArray(b.warnings)?b.warnings:[]).forEach(w=>{h+=`<div class="gen-warn">${escA(typeof w==='string'?w:JSON.stringify(w))}</div>`});
  const rj=Array.isArray(b.rejected)?b.rejected.length:0;if(rj)h+=`<div class="mu">${rj} entr${rj===1?'y was':'ies were'} not readable and ${rj===1?'was':'were'} left out.</div>`;
  if(!(b.proposals||[]).length)h+='<div class="empty">This bundle has no proposals.</div>';
  (b.proposals||[]).forEach(p=>{
    const id=Number(p.id),st=p.status,why=st==='staged'?bndWhy(p,ch):'',dis=BND.busy?' disabled':'';
    h+=`<div class="cd"><span class="kind">${escA(p.kind)}</span> <span class="bd" style="background:var(${st==='accepted'?'--g':st==='rejected'?'--r':'--a'})">${escA(BND_ST[st]||st)}</span>
      <div>${bndFields(p)}</div>`;
    (p.blockers||[]).forEach(x=>{h+=`<div class="gen-warn">Blocker: ${escA(x)}</div>`});
    (p.warnings||[]).forEach(x=>{h+=`<div class="mu">Note: ${escA(x)}</div>`});
    if(st==='accepted')h+='<div class="mu">Accepted into a chart. Final.</div>';
    else if(st==='rejected')h+=`<div class="mu">Rejected by ${escA(p.rejected_by)} · ${bndT(p.rejected_at)}: ${escA(p.reject_reason)}. Final.</div>`;
    else{
      if(why)h+=`<div class="mu">${escA(why)}</div>`;
      else{
        if(p.kind==='Observation')h+=`<select id="bnd_t_${id}" data-k="1" aria-label="Set and field of the open case" style="width:100%">${bndTargets(ch).map(t=>`<option value="${t[0]}|${escA(t[1])}"${BND.f['bnd_t_'+id]===t[0]+'|'+t[1]?' selected':''}>${escA(t[2])}</option>`).join('')}</select>`;
        h+=`<div class="flex" style="margin-top:4px"><button class="b sm" data-act="bndAccept" data-arg="${id}"${dis}>Accept into ${escA(caseName(ch))}</button></div>`;
      }
      h+=`<div style="margin-top:6px"><textarea id="bnd_r_${id}" data-k="1" rows="2" maxlength="1000" placeholder="Reason (required to reject, up to 1000 characters)" aria-label="Reason" style="width:100%">${bndV('bnd_r_'+id)}</textarea>
        <div class="flex" style="margin-top:4px"><button class="b sec sm" data-act="bndReject" data-arg="${id}"${dis}>Reject</button></div></div>`;
    }
    if(BND.err[id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(BND.err[id])}</div>`;
    h+='</div>';
  });
  return h;
}
async function bndAccept(arg){
  if(!/^\d{1,9}$/.test(arg||'')||BND.busy||!BND.bundle||!srvCan('import:write'))return;
  const id=Number(arg),p=BND.bundle.proposals.find(x=>x.id===id),ch=bndChart();
  if(!p||p.status!=='staged'||bndWhy(p,ch))return;
  bndKeep();delete BND.err[id];
  let url,body;
  if(p.kind==='Observation'){
    const v=String(BND.f['bnd_t_'+id]||''),i=v.indexOf('|'),asid=v.slice(0,i),key=v.slice(i+1);
    if(i<1||!/^\d{1,9}$/.test(asid)||!BND_KEY.test(key)){BND.err[id]='Pick the set and field of the open case.';return renderBundles()}
    body={rowVersion:p.row_version,caseId:ch.serverId,appliedSetId:Number(asid),fieldKey:key};url='/api/import/proposals/'+id+'/accept';
  }else{
    body={rowVersion:p.row_version,patientId:ch.patientId};if(ch.serverId)body.originCaseId=ch.serverId;url='/api/import/proposals/'+id+'/accept-to-patient';   // only these fields
  }
  if(!confirm('Accept this '+p.kind+' into the chart of '+caseName(ch)+' (MRN '+caseMrn(ch)+')? It is recorded as '+(p.kind==='Observation'?'preliminary, source imported':'active')+' and cannot be undone here.'))return;
  BND.busy=true;renderBundles();
  const r=await api('POST',url,body);
  BND.busy=false;if(!srvCan('import:write'))return;
  if(r.status===200){delete BND.f['bnd_r_'+id];delete BND.f['bnd_t_'+id];toast('Proposal accepted.');await bundlesLoad();return}
  BND.err[id]=apiMsg(r);
  if(r.status===409)await bundlesLoad();else renderBundles();
}
async function bndReject(arg){
  if(!/^\d{1,9}$/.test(arg||'')||BND.busy||!BND.bundle||!srvCan('import:write'))return;
  const id=Number(arg),p=BND.bundle.proposals.find(x=>x.id===id);
  if(!p||p.status!=='staged')return;
  bndKeep();delete BND.err[id];
  const reason=(BND.f['bnd_r_'+id]||'').trim();
  if(!reason){BND.err[id]='A reason is required.';return renderBundles()}
  if(!confirm('Reject this '+p.kind+' proposal? This is final.'))return;
  BND.busy=true;renderBundles();
  const r=await api('POST','/api/import/proposals/'+id+'/reject',{reason,rowVersion:p.row_version});   // only these two fields
  BND.busy=false;if(!srvCan('import:write'))return;
  if(r.status===200){delete BND.f['bnd_r_'+id];toast('Proposal rejected.');await bundlesLoad();return}
  BND.err[id]=apiMsg(r);
  if(r.status===409)await bundlesLoad();else renderBundles();
}
