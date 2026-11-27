// R0c-1: sign-in display, patients tab and encounters (case screen), moved unchanged from the inline script.
// Only function declarations: nothing runs at load. They call page functions (renderAll, toast, ptOpenCaseSrv...) when used.
function renderWho(){
  if(!Srv.user)Object.assign(AI,{on:false,configured:false,canUse:false,admin:null,left:null});
  $('who').innerHTML=Srv.user?`${escA(Srv.user.username)} (${escA(Srv.user.role)}) <a href="#" data-act="srvLogout">Sign out</a>`:'Not signed in';
  renderBanner();renderEncounter();renderCases();renderSrvCase();applyAiState();renderAiPanel();renderNotes();renderReviewNav();renderTermsNav();renderProblemsNav();renderAllergiesNav();renderMedicationsNav();renderOrdersNav();renderReconcile();renderInvest();renderAbnormal();renderReferrals();renderProcedures();renderAdmissions();renderMar();renderTimelineNav();renderLongitudinalNav();renderBundlesNav();renderVers();
}
async function srvInit(){
  const r=await api('GET','/api/me');
  if(r.status===200){Srv.user=r.body.user;storeEnter();await libLoad();await loadLinkedAll();await aiRefresh()}
  renderWho();
}
async function loadLinkedAll(){
  const ids=[...new Set(CASES.map(c=>c.patientId).filter(Boolean))];
  await Promise.all(ids.map(id=>refreshPatient(id,true)));
}
async function refreshPatient(id,quiet){
  if(!Srv.user)return;
  const r=await api('GET','/api/patients/'+id);
  if(r.status===200)Srv.pts[id]=r.body.patient;
  if(!quiet){renderBanner();renderEncounter();renderCases()}
}
async function srvLogin(){
  $('lg_err').textContent='';
  const r=await api('POST','/api/login',{username:$('lg_u').value.trim(),password:$('lg_p').value});
  $('lg_p').value='';
  if(r.status!==200){$('lg_err').textContent=r.status===401?'Wrong username or password.':apiMsg(r);return}
  Srv.user=r.body.user;storeEnter();await libLoad();await loadLinkedAll();await aiRefresh();renderWho();ptShow();document.querySelector('[data-t=patients]').click();
}
async function srvLogout(){await storeFlush();await api('POST','/api/logout');Srv.user=null;Srv.pts={};storeLeave();renderWho();ptShow()}

/* Patients tab */
function ptShow(){
  const off=location.protocol==='file:';
  $('ptNote').style.display=off?'block':'none';
  $('ptNote').textContent=off?'This page was opened as a file. Start the server (npm start) and open it from http://localhost to use patient registration. The Case tab still works with demo fields.':'';
  $('ptLogin').style.display=!off&&!Srv.user?'block':'none';
  $('ptMain').style.display=Srv.user?'block':'none';
  if(!Srv.user)return;
  $('ptRegBtn').style.display=srvCan('patients:register')?'':'none';
  ptLoad();
}
function ptDebounce(){clearTimeout(Srv.t);Srv.t=setTimeout(ptLoad,250)}
async function ptLoad(){
  const r=await api('GET','/api/patients?q='+encodeURIComponent($('ptQ').value.trim())+($('ptArch').checked?'&archived=1':''));
  if(r.status!==200){$('ptList').innerHTML=`<div class="gen-err">${escA(apiMsg(r))}</div>`;return}
  const rows=r.body.patients;rows.forEach(p=>{Srv.pts[p.id]=p});
  $('ptList').innerHTML=rows.map(p=>`<div class="item" data-act="ptOpenCase" data-arg="${Number(p.id)}"><div><b>${escA(p.name)}</b> <span class="mu">MRN ${escA(p.mrn)}</span>
      <div class="meta">${escA(p.age)} · ${escA(SEXL[p.sex]||p.sex)} · DOB ${escA(p.dob)}${p.open_bed?' · bed '+escA(p.open_bed):' · no open encounter'}${p.archived?' · archived':''}</div></div>
      <div>${srvCan('patients:archive')?`<button class="b sec sm" data-act="ptArchive" data-arg="${Number(p.id)}" data-arg2="${!p.archived}">${p.archived?'Restore':'Archive'}</button>`:''}
      <button class="b sm" data-act="ptOpenCase" data-arg="${Number(p.id)}">Open case</button></div></div>`).join('')||'<div class="empty">No patients found.</div>';
}
function ptToggleForm(show){
  const f=$('ptForm');show=show===undefined?f.style.display!=='block':show;f.style.display=show?'block':'none';
  $('ptDup').innerHTML='';$('pt_err').textContent='';if(show)$('r_name').focus();
}
async function ptRegister(confirmDuplicate){
  $('pt_err').textContent='';
  const body={name:$('r_name').value,mrn:$('r_mrn').value,dob:$('r_dob').value,sex:$('r_sex').value,confirmDuplicate:confirmDuplicate===true};
  const r=await api('POST','/api/patients',body);
  if(r.status===201){$('ptDup').innerHTML='';['r_name','r_mrn','r_dob','r_sex'].forEach(i=>$(i).value='');ptToggleForm(false);toast('Registered '+r.body.patient.name);ptLoad();return}
  if(r.body.error==='possible_duplicate'){
    $('ptDup').innerHTML=`<div class="dupbox"><b>Possible duplicate.</b> ${escA(r.body.message)}<ul style="margin:6px 0">`+r.body.duplicates.map(d=>
      `<li>${escA(d.name)} · MRN ${escA(d.mrn)} · DOB ${escA(d.dob)}${d.archived?' · archived':''} <a href="#" data-act="ptOpenCaseLink" data-arg="${Number(d.id)}">open</a></li>`).join('')+
      `</ul>If this is a different person, register anyway. <button class="b sm" data-act="ptRegisterAnyway">Register anyway</button></div>`;return}
  $('ptDup').innerHTML='';$('pt_err').textContent=apiMsg(r);
}
async function ptArchive(id,archived){
  if(archived&&!confirm('Archive this patient? Nothing is deleted; they stay under “show archived”.'))return;
  const r=await api('PATCH','/api/patients/'+id+'/archive',{archived});
  if(r.status!==200)return toast(apiMsg(r));
  Srv.pts[id]=r.body.patient;toast(archived?'Archived':'Restored');ptLoad();
}
function ptOpenCase(id){return srvMode()?ptOpenCaseSrv(id):ptOpenCaseLocal(id)}
function ptOpenCaseLocal(id){
  let c=CASES.find(x=>x.patientId===id&&x.status!=='archived');
  if(!c){c=newCaseObj();c.patientId=id;CASES.push(c)}
  openCase(c.id);
}

/* Encounters (case screen) */
function renderEncounter(){
  const box=$('encPanel'),legacy=$('legacyPt');if(!box)return;
  legacy.style.display=CASE.patientId?'none':'';$('enc_err').textContent='';
  if(srvMode()&&!CASE.serverId){box.innerHTML='<span class="mu">No case is open. Cases belong to registered patients: open one from <a href="#" data-act="goPatients">Patients</a> or the <b>Cases</b> tab. Nothing entered here is stored.</span>';legacy.style.display='none';return}
  if(!CASE.patientId){box.innerHTML='<span class="mu">Demo patient fields (not linked to a registered patient). To get a real banner and encounters, open a case from <a href="#" data-act="goPatients">Patients</a>.</span>';return}
  const lp=Srv.pts[CASE.patientId];
  if(!lp){box.innerHTML='<span class="mu">Sign in on the <a href="#" data-act="goPatients">Patients</a> tab to load this patient and manage encounters.</span>';return}
  const w=srvCan('encounters:write');
  if(lp.open_encounter_id)box.innerHTML=`<b>Encounter open</b> · bed ${escA(lp.open_bed)} · since ${escA(String(lp.open_since).slice(0,16).replace('T',' '))}`+(w?` <button class="b sec sm" data-act="encClose" data-arg="${Number(lp.open_encounter_id)}">Close encounter</button>`:'');
  else if(lp.archived)box.innerHTML='<b>No open encounter.</b> <span class="mu">Patient is archived; restore on the Patients tab to open one.</span>';
  else box.innerHTML='<b>No open encounter</b>'+(w?` <input id="enc_bed" placeholder="Bed (e.g. ICU-1)" aria-label="Bed" style="width:150px" data-act="encOpen" data-ev="enter"> <button class="b sm" data-act="encOpen">Open encounter</button>`:' <span class="mu">(your role cannot open encounters)</span>');
}
async function encOpen(){
  const r=await api('POST','/api/patients/'+CASE.patientId+'/encounters',{bed:$('enc_bed').value});
  if(r.status!==201){$('enc_err').textContent=apiMsg(r);return}
  await refreshPatient(CASE.patientId);toast('Encounter opened');
}
async function encClose(id){
  if(!confirm('Close this encounter?'))return;
  const r=await api('POST','/api/encounters/'+id+'/close');
  if(r.status!==200){$('enc_err').textContent=apiMsg(r);return}
  await refreshPatient(CASE.patientId);toast('Encounter closed');
}
