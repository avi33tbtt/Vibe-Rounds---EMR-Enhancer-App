// R2f-5a: Local terms screen (list, add a draft, submit, approve or reject, publish, retire). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server decides everything (status steps, own-term rule, second step by a different person); this page only shows the buttons the
   role may use and the server's own message when it refuses. Who and when are the server's values. All text is escaped. */
const TERM={items:[],err:{},draft:{},msg:'',busy:false,loaded:false,form:{code:'',display:'',category:'other',definition:''},formErr:''};
const TERM_CATS=['finding','condition','test','procedure','observation','other'];
const TERM_LBL={draft:'draft',in_review:'in review',rejected:'rejected',reviewed:'approved',published:'published',retired:'retired'};
const TERM_NOTE={in_review:'Waiting for a reviewer.',rejected:'Rejected: this version is final. Add a new version.',reviewed:'Approved and frozen. An admin publishes it.',published:'Published and frozen.',retired:'Retired and frozen.'};
const TERM_PERM={submit:'terms:submit',approve:'terms:review',reject:'terms:review',publish:'terms:publish',retire:'terms:publish'};
const TERM_DONE={submit:'Submitted for review.',approve:'Approved.',reject:'Rejected.',publish:'Published.',retire:'Retired.'};
function renderTermsNav(){
  const b=$('navTerms');if(!b)return;
  const show=srvCan('terms:read');b.style.display=show?'':'none';
  if(!show){termPickClose();TERM.items=[];TERM.err={};TERM.draft={};TERM.msg='';TERM.formErr='';TERM.loaded=false;if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
async function termsLoad(){
  if(!srvCan('terms:read')){TERM.items=[];TERM.loaded=false;return renderTerms()}
  const r=await api('GET','/api/local-terms');
  if(!srvCan('terms:read'))return;
  if(r.status!==200){TERM.msg='The terms could not be loaded: '+apiMsg(r);TERM.items=[];TERM.loaded=true;return renderTerms()}
  TERM.items=r.body.terms||[];TERM.msg='';TERM.loaded=true;renderTerms();
}
const termKeep=()=>['code','display','category','definition'].forEach(k=>{const e=$('tf_'+k);if(e)TERM.form[k]=e.value});
function renderTerms(){
  const box=$('termsBox');if(!box)return;
  if(!srvCan('terms:read')){box.innerHTML='';return}
  termKeep();
  const f=TERM.form,me=Srv.user.username;
  let h=`<div class="note">Free in-house terms (system <b>local</b>). No licensed code system is used. A term is usable only once it is published. A term version is frozen after it is submitted; a change is a new version. Who and when are recorded by the server.${TERM.msg?' '+escA(TERM.msg):''} <button class="b sec sm" data-act="termReload">Refresh</button></div>`;
  if(srvCan('terms:write'))h+=`<div class="cd"><b>Add a draft term</b> <span class="mu">(an existing code gets its next version)</span>
    <div class="field-row"><input id="tf_code" placeholder="code, e.g. demo.fever" maxlength="64" value="${escA(f.code)}" aria-label="Code" style="flex:.8">
    <input id="tf_display" placeholder="display (the term)" maxlength="200" value="${escA(f.display)}" aria-label="Display" style="flex:1.4">
    <select id="tf_category" aria-label="Category" style="flex:.6">${TERM_CATS.map(c=>`<option value="${escA(c)}"${c===f.category?' selected':''}>${escA(c)}</option>`).join('')}</select></div>
    <textarea id="tf_definition" rows="2" maxlength="500" placeholder="definition (optional, up to 500 characters)" aria-label="Definition" style="width:100%">${escA(f.definition)}</textarea>
    <div class="flex" style="margin-top:4px"><button class="b sm" data-act="termAdd"${TERM.busy?' disabled':''}>Add draft</button></div>${TERM.formErr?`<div class="gen-warn">${escA(TERM.formErr)}</div>`:''}</div>`;
  if(TERM.loaded&&!TERM.items.length&&!TERM.msg)h+='<div class="empty">No local terms yet.</div>';
  TERM.items.forEach(t=>{
    const id=escA(t.id),dis=TERM.busy?' disabled':'';
    h+=`<div class="cd"><b>${escA(t.display)}</b> <span class="mu">${escA(t.code)} · v${escA(t.version)} · ${escA(t.category)}</span> <span class="bd" style="background:var(${t.status==='rejected'?'--r':t.status==='published'||t.status==='reviewed'?'--g':'--a'})">${escA(TERM_LBL[t.status]||t.status)}</span>
      <div class="mu">Written by ${escA(t.created_by)} · ${escA(String(t.created_at||'').slice(0,16).replace('T',' '))}</div>${t.definition?`<div>${escA(t.definition)}</div>`:''}`;
    if(t.status==='draft')h+=srvCan('terms:submit')?` <button class="b sm" data-act="termSubmit" data-arg="${id}"${dis}>Submit for review</button>`:' <span class="mu">Draft. Your role cannot submit it.</span>';
    else if(t.status==='in_review'&&srvCan('terms:review')){
      if(me===t.created_by)h+='<div class="mu" style="margin-top:6px">You wrote this term, so you cannot review it.</div>';
      else h+=`<div style="margin-top:6px"><textarea id="tr_${id}" rows="2" maxlength="1000" placeholder="Reason (required, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(TERM.draft[t.id]||'')}</textarea>
        <div class="flex" style="margin-top:4px"><button class="b sm" data-act="termApprove" data-arg="${id}"${dis}>Approve</button> <button class="b sec sm" data-act="termReject" data-arg="${id}"${dis}>Reject</button></div></div>`;
    }else if(t.status==='reviewed'&&srvCan('terms:publish'))h+=` <button class="b sm" data-act="termPublish" data-arg="${id}"${dis}>Publish</button>`;
    else if(t.status==='published'&&srvCan('terms:publish'))h+=` <button class="b sec sm" data-act="termRetire" data-arg="${id}"${dis}>Retire</button>`;
    else h+=` <span class="mu">${escA(TERM_NOTE[t.status]||'')}</span>`;
    if(TERM.err[t.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(TERM.err[t.id])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function termAdd(){
  if(TERM.busy||!srvCan('terms:write'))return;
  termKeep();
  const f=TERM.form,body={code:f.code.trim(),display:f.display.trim(),category:f.category};   // only these four fields are ever sent
  if(f.definition.trim())body.definition=f.definition.trim();
  TERM.formErr='';
  if(!body.code||!body.display){TERM.formErr='Code and display are required.';return renderTerms()}
  TERM.busy=true;renderTerms();
  const r=await api('POST','/api/local-terms',body);
  TERM.busy=false;if(!srvCan('terms:read'))return;
  if(r.status===201){TERM.form={code:'',display:'',category:'other',definition:''};['code','display','category','definition'].forEach(k=>{const e=$('tf_'+k);if(e)e.value=TERM.form[k]});   // clear the boxes too: renderTerms reads them back
    toast('Draft term added.');await termsLoad();return}
  TERM.formErr=apiMsg(r);renderTerms();
}
async function termStep(action,arg){
  if(!/^\d{1,9}$/.test(arg||'')||!Object.hasOwn(TERM_PERM,action)||TERM.busy||!srvCan(TERM_PERM[action]))return;
  const id=Number(arg),body={};delete TERM.err[id];
  if(action==='approve'||action==='reject'){
    const ta=$('tr_'+id),reason=ta?ta.value.trim():'';
    TERM.draft[id]=reason;
    if(!reason){TERM.err[id]='A reason is required.';return renderTerms()}
    body.reason=reason;
  }
  if(!confirm(action[0].toUpperCase()+action.slice(1)+' this term version?'+(action==='submit'?' After that it is frozen and cannot be edited.':action==='reject'?' A rejection ends it: write a new version.':'')))return;
  TERM.busy=true;renderTerms();
  const r=await api('POST','/api/local-terms/'+id+'/'+action,body);
  TERM.busy=false;if(!srvCan('terms:read'))return;
  if(r.status===200){delete TERM.draft[id];toast(TERM_DONE[action]);await termsLoad();return}
  TERM.err[id]=apiMsg(r);
  if(r.status===409)await termsLoad();else renderTerms();
}

/* R2f-5b: local term picker for Create-screen binding rows (system local). Choose a PUBLISHED term from the server; it fills code, display
   and version. A hand-typed local code stays allowed but unverified. Local bindings are never exported as FHIR Coding (unchanged rule). */
const TPICK={items:[],row:null,q:''};
function termPickClose(){document.querySelectorAll('.tpick').forEach(e=>e.remove());TPICK.row=null;TPICK.items=[];TPICK.q=''}
async function termPick(btn){
  const r=btn.closest('.bind');if(!r)return;
  const open=r.nextElementSibling&&r.nextElementSibling.classList.contains('tpick');termPickClose();if(open)return;
  if(r.querySelector('.f-sys').value!=='local')return toast('Choose the system Local first');
  if(!srvCan('terms:read'))return toast('Sign in with access to local terms to pick a published term');
  const res=await api('GET','/api/local-terms?status=published');
  if(!srvCan('terms:read')||!r.isConnected)return;
  if(res.status!==200)return toast('The terms could not be loaded: '+apiMsg(res));
  TPICK.items=(res.body.terms||[]).filter(t=>t.status==='published');TPICK.row=r;TPICK.q='';
  const box=document.createElement('div');box.className='tpick cd';
  box.innerHTML='<div class="field-row"><input class="tp-q" placeholder="search published local terms" aria-label="Search terms" data-act="termPickFilter" data-ev="input"><button class="b sec sm" data-act="termPickClose">Close</button></div><div class="tp-list"></div>';
  r.after(box);termPickDraw();
}
function termPickDraw(){
  const box=TPICK.row&&TPICK.row.nextElementSibling;if(!box||!box.classList.contains('tpick'))return;
  const q=TPICK.q.trim().toLowerCase(),l=TPICK.items.filter(t=>!q||(t.display+' '+t.code).toLowerCase().includes(q));
  box.querySelector('.tp-list').innerHTML=l.length?l.map(t=>`<div class="field-row"><span style="flex:1"><b>${escA(t.display)}</b> <span class="mu">${escA(t.code)} · v${escA(t.version)} · ${escA(t.category)}</span></span><button class="b sm" data-act="termChoose" data-arg="${escA(t.id)}">Use</button></div>`).join(''):'<div class="empty">No published local term matches.</div>';
}
function termChoose(id){
  const r=TPICK.row,t=TPICK.items.find(x=>String(x.id)===String(id));if(!r||!t)return;
  r.querySelector('.f-code').value=t.code;r.querySelector('.f-disp').value=t.display;
  r.dataset.pver=String(t.version);r.dataset.pcode=t.code;r.dataset.pdisp=t.display;
  r.querySelector('.f-stat').textContent='local term v'+t.version+' (published); not a FHIR Coding';
  termPickClose();
}
