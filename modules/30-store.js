// R0b-2: storage adapter (local demo vs server), moved unchanged from the inline script.
// It reads page state (CASES, CASE, REGISTRY, PATHWAYS) and page functions only when called; nothing here runs at load.
/* ---------- Storage adapter (B1b-1) ----------
   local  = file:// demo or signed out: everything in localStorage 'vr_traj' (unchanged).
   server = signed in: cases, title, status and narrative live on the server; 'vr_traj' is never written.
   TEMPORARY exception (decision 2026-11-22, option B): until custom sets are stored on the server, they and the import record sit in localStorage under 'vr_interim'
   (synthetic data only). Applied sets are server pins (B3b-1), values are server observations (B3b-2) and notes are server notes (B3c-2): none is kept in the browser. */
const srvMode=()=>!!Srv.user;
const Store={q:Promise.resolve(),nt:null,dirty:null,busy:{},conflict:null};
const CASE_PATIENT_CAP=50;
const blankCase=()=>{const c=newCaseObj();c.unsaved=true;return c};
function interimRead(){
  try{const d=JSON.parse(localStorage.getItem('vr_interim')||'{}');return{customs:Array.isArray(d.customs)?d.customs:null,imported:d.imported&&typeof d.imported==='object'?d.imported:{}}}
  catch(e){return{customs:null,imported:{}}}
}
function interimWrite(mark){
  const im=interimRead(),imported={...im.imported,...(mark||{})};   // older copies of notes, applied sets and values (the old 'cases' key) are dropped here
  const customs=REGISTRY.filter(s=>!s.srv&&!BUILTIN.find(b=>b.id===s.id));
  try{localStorage.setItem('vr_interim',JSON.stringify({_temporary:'custom sets and the import record; synthetic data only',customs,imported}))}catch(e){toast('Storage full')}
}
function fromRow(r,old){
  return{id:'s'+r.id,serverId:r.id,rowVersion:r.row_version,title:r.title,srvStatus:r.status,patientId:r.patient_id,patient:{},
    narrative:old?old.narrative:'',narrativeSent:old?old.narrativeSent:'',
    applied:old?old.applied:[],values:old?old.values:{},notes:old?old.notes:[],
    status:r.status==='archived'?'archived':'open',createdAt:r.created_at,updatedAt:r.updated_at}
}
function storeEnter(){   // after sign-in: server cases replace the demo cases on screen; the demo data stays in localStorage untouched
  PATHWAYS=[];const im=interimRead();REGISTRY=[...(im.customs||[])];   // the library comes from the server (libLoad); the demo built-ins are not shown while signed in
  CASES=[];CASE=blankCase();Store.dirty=null;clearTimeout(Store.nt);conflictHide();
  fillPatient();$('narrative').value='';$('narSt').textContent='';renderAll();
}
function storeLeave(){   // after sign-out or an expired session: back to the local demo cases
  PATHWAYS=DEMO_PATHWAYS;clearTimeout(Store.nt);Store.dirty=null;conflictHide();load();
  fillPatient();$('narrative').value=CASE.narrative||'';$('narSt').textContent='';renderAll();
}
function storeFlush(){return Store.q=Store.q.then(doFlush,doFlush)}
async function doFlush(){
  clearTimeout(Store.nt);Store.nt=null;
  const c=Store.dirty;Store.dirty=null;
  if(!c||!c.serverId||!srvMode())return true;
  const text=(c.narrative||'').trim();
  if(!text||text===c.narrativeSent){if(c===CASE)$('narSt').textContent='';return true}   // the server keeps entries, it cannot store an empty one
  const r=await api('POST','/api/cases/'+c.serverId+'/narrative',{body:text});
  if(r.status===201){c.narrativeSent=text;if(c===CASE)$('narSt').textContent='saved';return true}
  if(!Store.dirty)Store.dirty=c;
  if(c===CASE)$('narSt').textContent='not saved: '+apiMsg(r);
  return false;
}
async function storeLoadCases(){
  const arch=$('caseArch').checked,q=arch?'?archived=1':'',msg=$('caseMsg');
  const pr=await api('GET','/api/patients'+q);
  if(!Srv.user)return;
  if(pr.status!==200){msg.textContent=apiMsg(pr);return}
  pr.body.patients.forEach(p=>{Srv.pts[p.id]=p});
  const pts=pr.body.patients.slice(0,CASE_PATIENT_CAP);
  const res=await Promise.all(pts.map(p=>api('GET','/api/patients/'+p.id+'/cases'+q)));
  if(!Srv.user)return;
  const old=Object.fromEntries(CASES.map(c=>[c.id,c])),rows=[];let denied=0;
  res.forEach(r=>{if(r.status===200)rows.push(...r.body.cases);else denied++});
  CASES=rows.map(r=>{const o=old['s'+r.id];if(!o)return fromRow(r);Object.assign(o,fromRow(r,o));return o});
  if(CASE.serverId){const same=CASES.find(c=>c.id===CASE.id);if(same)CASE=same}
  msg.textContent=(pr.body.patients.length>pts.length?`Showing cases of the first ${CASE_PATIENT_CAP} patients; search on the Patients tab for others. `:'')+(denied?'Some patients’ cases could not be loaded.':'');
  renderCases();
}
