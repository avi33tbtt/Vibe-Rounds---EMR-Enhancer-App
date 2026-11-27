// R0d-2: set versions (8d-2) and the reviewer queue (8d-1), moved unchanged from the inline script.
// Top-level constants are plain values or arrows (nothing here runs at load); page functions are called only when used.
/* ---------- Set versions: status badges and Submit for review (8d-2) ----------
   Shows every server version with its state. `local draft` = draft, in review or rejected; `local reviewed` = approved, published or
   retired. Anything past draft is frozen (the server and the database refuse changes); a change is a new version, made through the
   library API (the page has no draft editor). Submit sends nothing but the request: the server records who and when, and runs the lint
   check, whose findings are shown here. Review itself is the Review tab (8d-1). All text is escaped. */
const VER={items:[],err:{},lint:{},busy:false,loaded:false,msg:''};
const VER_LBL={draft:'draft',in_review:'in review',rejected:'rejected',reviewed:'approved',published:'published',retired:'retired'};
const VER_NOTE={in_review:'Waiting for a reviewer.',rejected:'Rejected: this version is final. Write a new version.',reviewed:'Approved and frozen. An admin publishes it.',published:'Published and frozen.',retired:'Retired and frozen.'};
const verTier=st=>['reviewed','published','retired'].includes(st)?'local reviewed':'local draft';
async function verLoad(){
  if(!srvCan('sets:read')){VER.items=[];VER.loaded=false;VER.err={};VER.lint={};return renderVers()}
  const l=await api('GET','/api/element-sets');
  if(!srvCan('sets:read'))return;
  if(l.status!==200){VER.msg='The versions could not be loaded: '+apiMsg(l);VER.items=[];VER.loaded=true;return renderVers()}
  const sets=l.body.sets||[];
  const det=await Promise.all(sets.map(x=>api('GET','/api/element-sets/'+x.id)));
  if(!srvCan('sets:read'))return;
  VER.items=[];
  sets.forEach((x,i)=>{if(det[i].status===200)(det[i].body.versions||[]).forEach(v=>VER.items.push({set_id:x.id,slug:x.slug,title:x.title,...v}))});
  VER.msg='';VER.loaded=true;renderVers();
}
function verFindings(fs){return fs.length?`<ul>${fs.map(f=>`<li><span class="gen-warn">${escA(f.severity)}</span> ${escA(f.rule)} · ${escA(f.path)}: ${escA(f.message)}</li>`).join('')}</ul>`:''}
function renderVers(){
  const box=$('libVers');if(!box)return;
  if(!srvMode()||!srvCan('sets:read')){box.innerHTML='';return}
  const canSub=srvCan('sets:submit');
  let h=`<div class="cd"><b>Set versions</b> <button class="b sec sm" data-act="verReload">Refresh</button><div class="mu" style="margin:4px 0">Every version on the server and its state. Past draft a version is frozen; changes are a new version.${VER.msg?' '+escA(VER.msg):''}</div>`;
  if(VER.loaded&&!VER.items.length&&!VER.msg)h+='<div class="empty">No versions on the server yet.</div>';
  VER.items.slice().sort((a,b)=>a.slug<b.slug?-1:a.slug>b.slug?1:b.version-a.version).forEach(v=>{
    const key=v.set_id+':'+v.version,lbl=VER_LBL[v.status]||v.status;
    h+=`<div style="margin:6px 0;padding-top:6px;border-top:1px solid var(--b,#ddd)"><span class="bd" style="background:var(${v.status==='rejected'?'--r':verTier(v.status)==='local draft'?'--a':'--g'})">${escA(verTier(v.status))}</span> <b>${escA(v.title)}</b> <span class="mu">${escA(v.slug)} · v${escA(v.version)} · ${escA(lbl)} · by ${escA(v.created_by)}</span>`;
    if(v.status==='draft')h+=canSub?` <button class="b sm" data-act="verSubmit" data-arg="${escA(key)}"${VER.busy?' disabled':''}>Submit for review</button>`:' <span class="mu">Draft. Your role cannot submit it.</span>';
    else if(v.status==='reviewed'&&srvCan('sets:publish'))h+=` <button class="b sm" data-act="verPublish" data-arg="${escA(key)}"${VER.busy?' disabled':''}>Publish</button> <span class="mu">Approved. Publishing freezes it and makes it usable.</span>`;
    else h+=` <span class="mu">${escA(VER_NOTE[v.status]||'')}</span>`;
    if(VER.err[key])h+=`<div class="gen-warn">${escA(VER.err[key])}</div>`;
    if(VER.lint[key])h+=verFindings(VER.lint[key]);
    h+='</div>';
  });
  box.innerHTML=h+'</div>';
}
async function verSubmit(arg){
  const m=/^(\d+):(\d+)$/.exec(arg||'');if(!m||VER.busy||!srvCan('sets:submit'))return;
  const key=arg;delete VER.err[key];delete VER.lint[key];
  if(!confirm('Submit this version for review? After that it is frozen and cannot be edited.'))return;
  VER.busy=true;renderVers();
  const r=await api('POST','/api/element-sets/'+m[1]+'/versions/'+m[2]+'/submit',{});
  VER.busy=false;if(!srvCan('sets:read'))return;
  if(r.status===200){
    const fs=(r.body.review&&r.body.review.lint&&r.body.review.lint.findings)||[];
    toast('Submitted for review.');await verLoad();
    if(fs.length){VER.lint[key]=fs;renderVers()}
    return;
  }
  VER.err[key]=apiMsg(r);
  const lint=r.body&&r.body.lint&&r.body.lint.findings;if(lint)VER.lint[key]=lint;
  if(r.status===409)await verLoad();else renderVers();
}

async function verPublish(arg){
  const m=/^(\d+):(\d+)$/.exec(arg||'');if(!m||VER.busy||!srvCan('sets:publish'))return;
  const key=arg;delete VER.err[key];
  if(!confirm('Publish this approved version? It is frozen from then on and becomes usable in the library.'))return;
  VER.busy=true;renderVers();
  const r=await api('POST','/api/element-sets/'+m[1]+'/versions/'+m[2]+'/publish',{});
  VER.busy=false;if(!srvCan('sets:read'))return;
  if(r.status===200){toast('Published.');await verLoad();await libLoad();return}
  VER.err[key]=apiMsg(r);
  if(r.status===409)await verLoad();else renderVers();
}

/* ---------- Reviewer queue (8d-1) ----------
   Only a signed-in user with sets:review (the informatician role) sees the Review tab. The list, lint findings, who reviewed and when,
   and the approval counts are the server's values. The server decides everything (own version, second reviewer, status); this page
   only shows the buttons. All text is escaped. Submitting a set and the status badges are 8d-2, not here. */
const REV={items:[],err:{},draft:{},msg:'',busy:false,loaded:false};
function renderReviewNav(){
  const b=$('navReview');if(!b)return;
  const show=srvCan('sets:review');b.style.display=show?'':'none';
  if(!show){REV.items=[];REV.err={};REV.draft={};REV.msg='';REV.loaded=false;if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
async function reviewLoad(){
  if(!srvCan('sets:review')){REV.items=[];renderReview();return}
  REV.msg='';
  const q=await api('GET','/api/review-queue');
  if(!srvCan('sets:review'))return;
  if(q.status!==200){REV.msg='The queue could not be loaded: '+apiMsg(q);REV.items=[];REV.loaded=true;return renderReview()}
  const rows=q.body.queue||[];
  const det=await Promise.all(rows.map(r=>api('GET','/api/element-sets/'+r.set_id+'/versions/'+r.version+'/review')));
  if(!srvCan('sets:review'))return;
  REV.items=rows.map((r,i)=>{const d=det[i].status===200?det[i].body:null;
    return{...r,reviews:d?d.reviews:[],needed:d?d.approvalsNeeded:(r.lint&&r.lint.needsTwoReviewers?2:1),detailFailed:!d}});
  REV.loaded=true;renderReview();
}
const revT=x=>String(x||'').slice(0,16).replace('T',' ');
function renderReview(){
  const box=$('reviewBox');if(!box)return;
  if(!srvCan('sets:review')){box.innerHTML='';return}
  let h=`<div class="note">Versions waiting for review. You cannot review a version you wrote or submitted, and each reviewer counts once. Reviewer and time are recorded by the server.${REV.msg?' '+escA(REV.msg):''} <button class="b sec sm" data-act="reviewReload">Refresh</button></div>`;
  if(REV.loaded&&!REV.items.length&&!REV.msg)h+='<div class="empty">Nothing is waiting for review.</div>';
  REV.items.forEach(r=>{
    const key=r.set_id+':'+r.version,me=Srv.user.username;
    const own=me===r.created_by||me===r.submitted_by,done=r.reviews.some(x=>x.reviewer===me);
    const apr=r.reviews.filter(x=>x.decision==='approve').length;
    const fs=(r.lint&&r.lint.findings)||[];
    h+=`<div class="cd"><b>${escA(r.title)}</b> <span class="mu">${escA(r.slug)} · v${escA(r.version)}</span> <span class="bd" style="background:var(--a)">in review</span>
      <div class="mu">Written by ${escA(r.created_by)} · submitted by ${escA(r.submitted_by)} at ${escA(revT(r.submitted_at))} · approvals ${apr} of ${escA(r.needed)}${r.needed>1?' (the lint check flagged this set: two different reviewers are needed)':''}</div>`;
    h+=fs.length?`<div style="margin-top:6px"><b>Lint findings (${fs.length})</b><ul>${fs.map(f=>`<li><span class="gen-warn">${escA(f.severity)}</span> ${escA(f.rule)} · ${escA(f.path)}: ${escA(f.message)}</li>`).join('')}</ul></div>`:'<div class="mu" style="margin-top:6px">Lint: no findings.</div>';
    if(r.detailFailed)h+='<div class="mu">The earlier reviews could not be loaded.</div>';
    if(r.reviews.length)h+=`<div style="margin-top:6px"><b>Reviews so far</b><ul>${r.reviews.map(x=>`<li>${escA(x.reviewer)} · ${escA(x.decision)} · ${escA(revT(x.created_at))}: ${escA(x.reason)}</li>`).join('')}</ul></div>`;
    if(own)h+='<div class="mu" style="margin-top:6px">You wrote or submitted this version, so you cannot review it.</div>';
    else if(done)h+='<div class="mu" style="margin-top:6px">You have already reviewed this version.</div>';
    else h+=`<div style="margin-top:6px"><textarea id="rv_${escA(r.set_id)}_${escA(r.version)}" rows="2" maxlength="1000" placeholder="Reason (required, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(REV.draft[key]||'')}</textarea>
      <div class="flex" style="margin-top:4px"><button class="b sm" data-act="reviewApprove" data-arg="${escA(key)}"${REV.busy?' disabled':''}>Approve</button> <button class="b sec sm" data-act="reviewReject" data-arg="${escA(key)}"${REV.busy?' disabled':''}>Reject</button></div></div>`;
    if(REV.err[key])h+=`<div class="gen-warn" style="margin-top:4px">${escA(REV.err[key])}</div>`;
    h+='</div>';
  });
  box.innerHTML=h;
}
async function reviewDecide(decision,arg){
  const m=/^(\d+):(\d+)$/.exec(arg||'');if(!m||REV.busy||!srvCan('sets:review'))return;
  const key=arg,ta=$('rv_'+m[1]+'_'+m[2]),reason=ta?ta.value.trim():'';
  REV.draft[key]=reason;delete REV.err[key];
  if(!reason){REV.err[key]='A reason is required.';return renderReview()}
  if(!confirm((decision==='approve'?'Approve':'Reject')+' this version?'+(decision==='reject'?' A rejection ends it: the author has to write a new version.':'')))return;
  REV.busy=true;renderReview();
  const r=await api('POST','/api/element-sets/'+m[1]+'/versions/'+m[2]+'/'+decision,{reason});
  REV.busy=false;if(!srvCan('sets:review'))return;
  if(r.status===200){delete REV.draft[key];toast(decision==='approve'?(r.body.status==='reviewed'?'Approved: the version is now approved.':'Approval recorded; a second reviewer is needed.'):'Rejected.');await reviewLoad();return}
  REV.err[key]=apiMsg(r);
  if(r.status===409)await reviewLoad();else renderReview();
}
