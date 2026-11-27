// R0c-2: the cases list (new, open, archive, restore, list) and the server case helpers, moved unchanged from the inline script.
// The two constants (caseTitleNow, EDITABLE_STATUS) are only read when a function runs. Nothing else runs at load.
function newCase(){if(srvMode())return newCaseSrv();const c=newCaseObj();CASES.push(c);openCase(c.id)}
function openCase(id){return srvMode()?openCaseSrv(id):openCaseLocal(id)}
function openCaseLocal(id){
  const c=CASES.find(x=>x.id===id);if(!c)return;CASE=c;save(false);
  fillPatient();$('narrative').value=CASE.narrative||'';$('bj').textContent='';$('bchk').textContent='';
  renderAll();document.querySelector('[data-t=case]').click();
  if(CASE.patientId)refreshPatient(CASE.patientId);
}
function archiveCase(){
  if(srvMode())return archiveCaseSrv();
  if(!confirm('Archive this case? Nothing is deleted; it stays under “show archived”.'))return;
  CASE.status='archived';save();const o=CASES.find(c=>c.status!=='archived');if(o)openCase(o.id);else newCase();
}
function restoreCase(id){if(srvMode())return restoreCaseSrv(id);const c=CASES.find(x=>x.id===id);if(c){c.status='open';save(false);renderCases();renderBanner()}}
function renderCases(){
  const ib=$('impBtn');if(ib){const on=srvMode()&&srvCan('cases:write');ib.style.display=on?'':'none';if(!on)$('importBox').style.display='none'}
  const q=($('caseQ').value||'').toLowerCase(),showA=$('caseArch').checked;
  const rows=CASES.filter(c=>showA||c.status!=='archived').filter(c=>{
    const hay=[caseName(c),caseMrn(c),c.title||'',...c.applied.map(a=>getSet(a.setId)?.title)].join(' ').toLowerCase();return!q||hay.includes(q)})
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  $('caseList').innerHTML=rows.map(c=>{
    const dx=c.applied.map(a=>resolve(a)).filter(s=>s&&s.kind==='disease').map(s=>`<span class="kind disease">${escA(s.title)}</span>`).join(' ');
    const dr=c.notes.filter(n=>n.status==='draft').length;
    return`<div class="item" data-act="openCase" data-arg="${escA(c.id)}"><div><b>${escA(caseName(c))}</b> <span class="mu">MRN ${escA(caseMrn(c))}</span>${c.title?` · ${escA(c.title)}`:''}${c.srvStatus&&c.srvStatus!=='active'?` <span class="kind">${escA(c.srvStatus)}</span>`:''} ${dx}
      <div class="meta">${c.serverId&&c.pinsOk!==true?'':c.applied.length+' sets · '}${c.serverId&&c.notesOk!==true?'':c.notes.length+' notes'+(dr?` (${dr} draft)`:'')+' · '}updated ${c.updatedAt.slice(0,16).replace('T',' ')}${c.id===CASE.id?' · open':''}</div></div>
      ${c.status==='archived'&&(!srvMode()||srvCan('cases:write'))?`<button class="b sec sm" data-act="restoreCase" data-arg="${escA(c.id)}">Restore</button>`:''}</div>`;
  }).join('')||'<div class="empty">No cases.</div>';
}

function casesShow(){renderCases();if(srvMode())return storeLoadCases()}
const caseTitleNow=()=>'Case opened '+nowISO().slice(0,16).replace('T',' ');
async function openCaseSrv(id){
  await storeFlush();
  const c=CASES.find(x=>x.id===id);if(!c)return;
  const r=await api('GET','/api/cases/'+c.serverId);
  if(r.status!==200){toast(apiMsg(r));return}
  Object.assign(c,fromRow(r.body.case,c));
  c.narrative=r.body.narrative?r.body.narrative.body:'';c.narrativeSent=c.narrative.trim();
  [c.pinsOk,c.notesOk]=await Promise.all([pinsLoad(c),notesLoad(c)]);
  CASE=c;conflictHide();
  fillPatient();$('narrative').value=c.narrative;$('narSt').textContent='';$('bj').textContent='';$('bchk').textContent='';
  renderAll();chartLand();
  if(c.patientId)refreshPatient(c.patientId);
}
async function ptOpenCaseSrv(pid){
  if(Store.busy[pid])return;Store.busy[pid]=1;
  try{
    await storeFlush();
    const l=await api('GET','/api/patients/'+pid+'/cases');
    if(l.status!==200)return toast(apiMsg(l));
    let row=l.body.cases[0];   // newest first, archived excluded
    if(!row){
      if(!srvCan('cases:write'))return toast('This patient has no case yet, and your role cannot create one.');
      const c=await api('POST','/api/patients/'+pid+'/cases',{title:caseTitleNow()});
      if(c.status!==201)return toast(apiMsg(c));
      row=c.body.case;
    }
    let ex=CASES.find(x=>x.serverId===row.id);
    if(!ex){ex=fromRow(row);CASES.push(ex)}
    await openCaseSrv(ex.id);
  }finally{Store.busy[pid]=0}
}
async function newCaseSrv(){
  const pid=CASE&&CASE.patientId;
  if(!pid)return toast('Open a patient on the Patients tab first: every case belongs to a registered patient.');
  if(!srvCan('cases:write'))return toast('Your role cannot create cases.');
  await storeFlush();
  const r=await api('POST','/api/patients/'+pid+'/cases',{title:caseTitleNow()});
  if(r.status!==201)return toast(apiMsg(r));
  const c=fromRow(r.body.case);CASES.push(c);await openCaseSrv(c.id);
}
/* Title, status, archive and restore carry the row version that was loaded. A 409 shows the conflict screen; nothing is overwritten silently. */
function opSend(c,op){
  return op.op==='meta'?api('PATCH','/api/cases/'+c.serverId,{rowVersion:c.rowVersion,title:op.title,status:op.status})
    :api('PATCH','/api/cases/'+c.serverId+'/archive',{rowVersion:c.rowVersion,archived:op.archived});
}
async function opRun(c,op){
  const r=await opSend(c,op);
  if(r.status===409&&r.body.error==='version_conflict'){conflictShow(c,op);return false}
  if(r.status!==200){toast(apiMsg(r));if(c===CASE)$('sc_info').textContent=apiMsg(r);return false}
  Object.assign(c,fromRow(r.body.case,c));return true;
}
async function caseSaveMeta(){
  const c=CASE;if(!c.serverId)return;
  if(await opRun(c,{op:'meta',title:$('sc_title').value,status:$('sc_status').value})){renderSrvCase();renderBanner();renderCases();toast('Saved')}
}
async function archiveCaseSrv(){
  const c=CASE;if(!c.serverId)return toast('No case is open.');
  if(!confirm('Archive this case? Nothing is deleted; it stays under “show archived”.'))return;
  await storeFlush();
  if(!await opRun(c,{op:'archive',archived:true}))return;
  const o=CASES.find(x=>x.status!=='archived'&&x.id!==c.id);
  if(o)await openCaseSrv(o.id);else{CASE=blankCase();fillPatient();$('narrative').value='';renderAll()}
}
async function restoreCaseSrv(id){
  const c=CASES.find(x=>x.id===id);if(!c)return;
  if(await opRun(c,{op:'archive',archived:false})){renderCases();renderSrvCase();renderBanner();toast('Restored')}
}
function renderSrvCase(){
  const box=$('srvCaseBox');if(!box)return;
  const on=srvMode()&&!!CASE.serverId;box.style.display=on?'':'none';if(!on)return;
  const arch=CASE.status==='archived',w=srvCan('cases:write')&&!arch;
  if(document.activeElement!==$('sc_title'))$('sc_title').value=CASE.title||'';
  $('sc_status').value=EDITABLE_STATUS.includes(CASE.srvStatus)?CASE.srvStatus:'active';
  [$('sc_title'),$('sc_status'),$('sc_save')].forEach(e=>{e.disabled=!w});
  $('ctxBox').style.display=srvCan('context:read')?'':'none';
  renderCcis();
  $('sc_info').textContent=arch?'Archived. Restore it from the Cases tab (show archived) to change it.':!srvCan('cases:write')?'Your role can read this case but not change it.':'';
}
const EDITABLE_STATUS=['active','resolved','closed'];
