// R0e-3: notes (draft, sign, amend; B3c-2), moved unchanged from the inline script.
// Top-level constants are plain values or arrows (nothing here runs at load); page state (CASE, Srv) stays in the page and is used only when a function runs.
/* Notes: draft → sign → amend-with-reason (never deleted) */
const AMEND={};
const noteCurrent=n=>n.amendments.length?n.amendments[n.amendments.length-1].body:n.body;
function snapshotText(){
  return CASE.applied.map(a=>{const s=resolve(a);if(!s||!s.fields)return'';
    const l=s.fields.map(f=>{const v=f.repeat?getRows(f.id,a).slice(0,3).map(r=>`${r.value} @ ${fmtT(r.ts)}`).join(', '):CASE.values[vkey(a,f.id)];
      return v!==''&&v!=null?`- ${f.label}: ${v}${f.unit&&!f.repeat?' '+f.unit:''}`:''}).filter(Boolean);
    return l.length?s.title+'\n'+l.join('\n'):''}).filter(Boolean).join('\n\n');
}
/* Notes on the server (B3c-2). Signed in, a note lives on the server (case_notes): nothing about it is kept in the browser.
   Edit, sign, discard and amend go through one queue, so a sign right after an edit uses the version the edit returned. A refused save (someone else
   saved first) reloads the notes and keeps the text you typed on screen, marked as not saved. Author, signer and amender are the session, set by the server. */
const NQ={p:Promise.resolve()};
const noteQ=fn=>{const r=NQ.p.then(fn);NQ.p=r.catch(()=>{});return r};
function noteFromRow(r,lost){return{id:'s'+r.id,srvId:r.id,kind:'note',title:'Note',body:r.body,status:r.status,createdAt:r.created_at,rowVersion:r.row_version,author:r.author,
  signedBy:r.signed_by,signedAt:r.signed_at,discardedBy:r.discarded_by,lost:lost||'',amendments:(r.amendments||[]).map(m=>({at:m.amended_at,by:m.amended_by,reason:m.reason,body:m.body}))}}
async function notesLoad(c,lost){   // lost: {server note id: the text that was refused}
  const r=await api('GET','/api/cases/'+c.serverId+'/notes');
  if(r.status!==200){c.notes=[];toast('Notes could not be loaded: '+apiMsg(r));return false}
  c.notes=r.body.notes.slice().reverse().map(x=>noteFromRow(x,lost&&lost[x.id]));return true;
}
const noteMine=n=>!!n.srvId&&n.author===user();
async function noteCall(n,method,path,bodyFn,ok,quiet){   // runs inside the queue; the body is built when it runs, so it carries the newest version
  const c=CASE,body=bodyFn(),r=await api(method,path,body);
  if(r.status===200||r.status===201){Object.assign(n,noteFromRow(r.body.note));if(ok)toast(ok)}
  else{toast(apiMsg(r));await notesLoad(c,r.status===409&&body&&typeof body.body==='string'?{[n.srvId]:body.body}:null)}
  if(c===CASE&&(!quiet||r.status>=300))renderNotes();
}
async function srvNoteAdd(kind){
  const c=CASE;if(!c.serverId)return toast('Open a patient on the Patients tab first: notes belong to a saved case.');
  if(c.notesOk!==true)return toast('The notes of this case are not loaded. Open the case again.');
  if(!srvCan('cases:write'))return toast('Your role cannot add notes.');
  const body=kind==='structured'?(snapshotText()||'(no values entered)'):$('n_body').value.trim();
  if(!body)return toast('Write something first');
  const r=await noteQ(()=>api('POST','/api/cases/'+c.serverId+'/notes',{body}));
  if(r.status!==201)return toast(apiMsg(r));
  c.notes.unshift(noteFromRow(r.body.note));$('n_body').value='';if(c===CASE)renderNotes();
}
function srvNoteEdit(id,v){const n=nid(id);if(!n||!n.srvId||n.status!=='draft'||v===n.body)return;
  return noteQ(()=>n.status==='draft'?noteCall(n,'PATCH','/api/notes/'+n.srvId,()=>({body:v,rowVersion:n.rowVersion}),'',true):0)}
function srvNoteSign(id){const n=nid(id);if(n&&n.srvId)return noteQ(()=>n.status==='draft'?noteCall(n,'POST','/api/notes/'+n.srvId+'/sign',()=>({rowVersion:n.rowVersion}),'Signed'):0)}
function srvNoteDiscard(id){const n=nid(id);if(n&&n.srvId)return noteQ(()=>n.status==='draft'?noteCall(n,'POST','/api/notes/'+n.srvId+'/discard',()=>({rowVersion:n.rowVersion}),'Discarded'):0)}
function srvNoteAmend(id,r,b){const n=nid(id);if(n&&n.srvId)return noteQ(async()=>{await noteCall(n,'POST','/api/notes/'+n.srvId+'/amend',()=>({body:b,reason:r,amendmentCount:n.amendments.length}),'Amended');AMEND[id]=false;renderNotes()})}
const lostBox=n=>n.lost?`<div class="note">Not saved (someone else saved first). Your text was:<pre class="body">${escA(n.lost)}</pre></div>`:'';
function addNote(kind){
  if(srvMode())return srvNoteAdd(kind);
  const body=kind==='structured'?(snapshotText()||'(no values entered)'):$('n_body').value.trim();
  if(!body)return toast('Write something first');
  CASE.notes.unshift({id:'n_'+Date.now().toString(36),kind,title:$('n_title').value.trim()||(kind==='structured'?'Structured snapshot':'Note'),body,status:'draft',createdAt:nowISO(),amendments:[]});
  $('n_body').value='';$('n_title').value='';save();renderNotes();
}
const nid=id=>CASE.notes.find(n=>n.id===id);
function editNote(id,v){if(srvMode())return srvNoteEdit(id,v);const n=nid(id);if(n&&n.status==='draft'){n.body=v;save()}}
function signNote(id){const n=nid(id);if(!n||n.status!=='draft')return;if(!user())return toast('Sign in to sign notes');if(!n.srvId)return toast('Only a note saved on the server can be signed. Open a patient case first.');return srvNoteSign(id)}   // signing exists only on the server: there is no browser-only signature
function discardNote(id){const n=nid(id);if(n&&n.status==='draft'&&confirm('Discard this draft? It is kept, marked discarded.')){if(n.srvId)return srvNoteDiscard(id);n.status='discarded';n.discardedAt=nowISO();save();renderNotes()}}
function toggleAmend(id){AMEND[id]=!AMEND[id];renderNotes()}
function submitAmend(id){const n=nid(id),r=$('am_r_'+id).value.trim(),b=$('am_b_'+id).value.trim();
  if(!user())return toast('Sign in to amend notes');if(!r)return toast('A reason is required');if(!b||b===noteCurrent(n))return toast('Change the text');
  if(!n.srvId)return toast('Only a note saved on the server can be amended.');return srvNoteAmend(id,r,b)}
function renderNotes(){
  $('n_who').textContent=user()?`${Srv.user.username} (${Srv.user.role}), from your sign-in`:'Not signed in: you can write drafts, but signing and amending are disabled. Sign in on the Patients tab.';
  $('n_titleRow').style.display=srvMode()?'none':'';
  const srvM=srvMode(),canW=!srvM||srvCan('cases:write');
  $('noteList').innerHTML=CASE.notes.map(n=>{
    const head=`<b>${escA(n.title)}</b> <span class="kind">${escA(n.kind)}</span> <span class="mu">${escA(n.status)}${n.srvId?' · '+escA(n.author):''} · ${escA(n.createdAt.slice(0,16).replace('T',' '))}</span>`;
    if(n.status==='draft'&&n.srvId&&(!noteMine(n)||!canW))return`<div class="cd nt draft">${head}<pre class="body">${escA(n.body)}</pre><div class="mu">Draft by ${escA(n.author)}: only the author can edit, sign or discard it.</div></div>`;
    if(n.status==='draft')return`<div class="cd nt draft">${head}<textarea data-act="editNote" data-arg="${escA(n.id)}" data-ev="change">${escA(n.body)}</textarea>${lostBox(n)}
      <button class="b sm" data-act="signNote" data-arg="${escA(n.id)}"${user()?'':' disabled title="Sign in to sign notes"'}>Sign</button><button class="b sec sm" data-act="discardNote" data-arg="${escA(n.id)}">Discard</button></div>`;
    if(n.status==='discarded')return`<div class="cd nt discarded">${head}${n.discardedBy?`<div class="mu">Discarded by ${escA(n.discardedBy)}. Kept, not deleted.</div>`:''}</div>`;
    const am=n.amendments.map((x,i)=>`<div class="mu">Amendment ${i+1} · ${escA(x.by)} · ${x.at.slice(0,16).replace('T',' ')} · reason: ${escA(x.reason)}</div>`).join('');
    const form=AMEND[n.id]?`<label>Reason for amendment</label><input id="am_r_${escA(n.id)}"><label>Amended text</label><textarea id="am_b_${escA(n.id)}">${escA(noteCurrent(n))}</textarea>
      <button class="b sm" data-act="submitAmend" data-arg="${escA(n.id)}"${user()?'':' disabled title="Sign in to amend notes"'}>Submit amendment</button><button class="b sec sm" data-act="toggleAmend" data-arg="${escA(n.id)}">Cancel</button>`
      :`<button class="b sec sm" data-act="toggleAmend" data-arg="${escA(n.id)}"${canW||!n.srvId?'':' disabled title="Your role cannot change cases"'}>Amend…</button>`;
    return`<div class="cd nt signed">${head}<pre class="body">${escA(noteCurrent(n))}</pre>${lostBox(n)}<div class="mu">Signed by ${escA(n.signedBy)} · ${n.signedAt.slice(0,16).replace('T',' ')}</div>${am}
      ${n.amendments.length?`<details><summary class="mu">Original (as signed)</summary><pre class="body">${escA(n.body)}</pre></details>`:''}${form}</div>`;
  }).join('')||`<div class="empty">${srvM&&CASE.notesOk!==true?'Open a patient case on the Patients tab to see and write its notes.':'No notes yet.'}</div>`;
}
