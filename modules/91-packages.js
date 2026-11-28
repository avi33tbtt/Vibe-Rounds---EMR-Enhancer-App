// Task D9: Import tab, section "Marketplace package": choose a package bundle file, read staged proposals and blockers, accept or reject each one.
// Server data only: the server decides, the page shows the buttons. No network until a file is chosen. Nothing is stored in the browser. All package text goes through escA.
// Prototype. Synthetic data only. Not for clinical use.
const PKG={list:[],open:null,imp:null,msg:'',info:'',loaded:false,busy:false,err:{},f:{},user:null};
const PKG_ST={staged:'to review',accepted:'accepted',rejected:'rejected'};
const pkgReset=()=>{PKG.list=[];PKG.open=null;PKG.imp=null;PKG.msg='';PKG.info='';PKG.loaded=false;PKG.err={};PKG.f={};PKG.busy=false};
const pkgT=v=>escA(String(v||'').slice(0,16).replace('T',' '));
const pkgOk=()=>srvCan('import:write');
function pkgKeep(){const b=$('packageBox');if(b)b.querySelectorAll('[data-k]').forEach(e=>{PKG.f[e.id]=e.value})}
async function packagesLoad(){
  const u=Srv.user?Srv.user.username:null;if(PKG.user!==u){pkgReset();PKG.user=u}
  if(!pkgOk()){pkgReset();return renderPackages()}
  const r=await api('GET','/api/import/packages');
  if(!pkgOk())return;
  if(r.status!==200){PKG.msg='The staged packages could not be loaded: '+apiMsg(r);PKG.list=[];PKG.loaded=true;return renderPackages()}
  PKG.list=r.body.imports||[];PKG.msg='';PKG.loaded=true;
  if(PKG.open!==null)return pkgFetch(PKG.open);
  renderPackages();
}
async function pkgFetch(id){
  const r=await api('GET','/api/import/packages/'+id);
  if(!pkgOk())return;
  if(r.status!==200){PKG.open=null;PKG.imp=null;PKG.msg='The package could not be loaded: '+apiMsg(r);return renderPackages()}
  PKG.imp=r.body.import;PKG.open=id;renderPackages();
}
async function pkgOpen(arg){
  if(!/^\d{1,9}$/.test(arg||'')||!pkgOk())return;
  pkgKeep();PKG.f={};PKG.err={};PKG.msg='';PKG.info='';await pkgFetch(Number(arg));
}
function pkgClose(){PKG.open=null;PKG.imp=null;PKG.f={};PKG.err={};renderPackages()}
function pkgPick(el){
  const f=el.files&&el.files[0];if(!f||!pkgOk())return;
  if(f.size>2*1024*1024){PKG.info='That file is too large (2 MB at most).';el.value='';return renderPackages()}
  const rd=new FileReader();
  rd.onload=()=>{el.value='';pkgSend(String(rd.result))};
  rd.onerror=()=>{el.value='';PKG.info='That file could not be read.';renderPackages()};
  rd.readAsText(f);
}
async function pkgSend(text){
  if(PKG.busy||!pkgOk())return;
  let j;try{j=JSON.parse(text)}catch(e){PKG.info='That file is not valid JSON.';return renderPackages()}
  if(!j||typeof j!=='object'||Array.isArray(j)){PKG.info='A package bundle is a JSON object.';return renderPackages()}
  PKG.busy=true;PKG.info='Staging…';renderPackages();
  const r=await api('POST','/api/import/packages',j);   // the parsed file and nothing else
  PKG.busy=false;if(!pkgOk())return;
  const id=r.body&&(r.status===201?r.body.import&&r.body.import.id:r.status===409?r.body.importId||r.body.bundleId:null);
  if(r.status===201){PKG.info='';toast('Package staged for review.');PKG.f={};PKG.err={};PKG.open=null;await packagesLoad();if(id)await pkgOpen(String(id));return}
  if(r.status===409&&id){PKG.info='This package was staged before; showing the first copy.';await packagesLoad();await pkgOpen(String(id));PKG.info='This package was staged before; showing the first copy.';return renderPackages()}
  PKG.info=apiMsg(r);renderPackages();
}
// Why a proposal cannot be accepted here ('' means the accept control is offered). The server checks all of it again.
function pkgWhy(p){
  if(!p.ready)return'This proposal has blockers and cannot be accepted.';
  if(!srvCan('sets:write'))return'Your role cannot create sets or pathways.';
  return'';
}
const pkgTitle=p=>{const b=p.body&&typeof p.body==='object'?p.body:{};return b.title||(b.definition&&b.definition.title)||''};
function pkgMap(m){
  if(!Array.isArray(m)||!m.length)return'';
  return'<h3>Concepts</h3>'+m.map(e=>{const o=e&&e.owner,us=Array.isArray(e&&e.users)?e.users:[];
    return`<div class="mu">${escA(e&&e.concept)} · ${escA(e&&e.status)} · owner: ${o?escA(o.set)+' / '+escA(o.field):'none'} · used by ${us.length}</div>`}).join('');
}
function renderPackages(){
  const box=$('packageBox');if(!box)return;
  if(!pkgOk()){pkgReset();box.innerHTML='';return}
  pkgKeep();
  const dis=PKG.busy?' disabled':'';
  let h=`<div class="note">Choose a Marketplace package file (JSON, 2 MB at most). It is only staged as <b>proposals</b> for you to look at: nothing becomes a set or pathway until you accept one, and accepting makes a <b>draft</b> that still goes through review and publish. Prototype. Synthetic data only. Not for clinical use.
    <div class="flex" style="margin-top:6px"><button class="b sm" data-act="pkgChoose"${dis}>Choose a file</button> <button class="b sec sm" data-act="pkgReload">Reload</button></div>${PKG.info?`<div class="gen-warn">${escA(PKG.info)}</div>`:''}${PKG.msg?`<div class="gen-warn">${escA(PKG.msg)}</div>`:''}</div>`;
  if(PKG.open!==null&&PKG.imp)h+=pkgOne(PKG.imp);
  else{
    h+='<h3>Staged packages</h3>';
    if(PKG.loaded&&!PKG.list.length&&!PKG.msg)h+='<div class="empty">No package has been staged yet.</div>';
    PKG.list.forEach(b=>{h+=`<div class="cd"><b>Package #${escA(b.id)}</b> <span class="mu">${escA(String(b.bundle_hash||'').slice(0,12))} · staged by ${escA(b.staged_by)} · ${pkgT(b.staged_at)}</span>
      <div class="mu">${escA(b.staged_count)} to review · ${escA(b.accepted_count)} accepted · ${escA(b.rejected_count)} rejected</div>
      <div class="flex" style="margin-top:4px"><button class="b sec sm" data-act="pkgOpen" data-arg="${Number(b.id)}">Open</button></div></div>`});
  }
  box.innerHTML=h;
}
function pkgOne(b){
  let h=`<div class="flex"><button class="b sec sm" data-act="pkgClose">&larr; All packages</button></div><h3>Package #${escA(b.id)}</h3><div class="mu">staged by ${escA(b.staged_by)} · ${pkgT(b.staged_at)}</div>`;
  (b.blockers||[]).forEach(x=>{h+=`<div class="gen-warn">Blocker: ${escA(x&&x.code)} ${escA(x&&x.message)}</div>`});
  h+=pkgMap(b.concept_map);
  if(!(b.proposals||[]).length)h+='<div class="empty">This package has no proposals.</div>';
  (b.proposals||[]).forEach(p=>{
    const id=Number(p.id),st=p.status,why=st==='staged'?pkgWhy(p):'',dis=PKG.busy?' disabled':'';
    h+=`<div class="cd"><span class="kind">${escA(p.kind)}</span> <span class="bd" style="background:var(${st==='accepted'?'--g':st==='rejected'?'--r':'--a'})">${escA(PKG_ST[st]||st)}</span> <b>${escA(pkgTitle(p))}</b> <span class="mu">${escA(p.slug)}</span>`;
    (p.blockers||[]).forEach(x=>{h+=`<div class="gen-warn">Blocker: ${escA(x&&x.code)} ${escA(x&&x.message)}</div>`});
    if(st==='accepted')h+='<div class="mu">Accepted as a draft. Final.</div>';
    else if(st==='rejected')h+=`<div class="mu">Rejected by ${escA(p.rejected_by)} · ${pkgT(p.rejected_at)}: ${escA(p.reject_reason)}. Final.</div>`;
    else{
      if(why)h+=`<div class="mu">${escA(why)}</div>`;
      else{
        if(p.kind==='pathway')h+='<div class="mu">Publish and review its sets first.</div>';
        h+=`<div class="flex" style="margin-top:4px"><button class="b sm" data-act="pkgAccept" data-arg="${id}"${dis}>Accept as draft ${p.kind==='pathway'?'pathway':'set'}</button></div>`;
      }
      h+=`<div style="margin-top:6px"><textarea id="pkg_r_${id}" data-k="1" rows="2" maxlength="1000" placeholder="Reason (required to reject, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(PKG.f['pkg_r_'+id]||'')}</textarea>
        <div class="flex" style="margin-top:4px"><button class="b sec sm" data-act="pkgReject" data-arg="${id}"${dis}>Reject</button></div></div>`;
    }
    if(PKG.err[id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(PKG.err[id])}</div>`;
    h+='</div>';
  });
  return h;
}
async function pkgAccept(arg){
  if(!/^\d{1,9}$/.test(arg||'')||PKG.busy||!PKG.imp||!pkgOk())return;
  const id=Number(arg),p=PKG.imp.proposals.find(x=>x.id===id);
  if(!p||p.status!=='staged'||pkgWhy(p))return;
  delete PKG.err[id];
  PKG.busy=true;renderPackages();
  const r=await api('POST','/api/import/package-proposals/'+id+(p.kind==='pathway'?'/accept-pathway':'/accept'),{rowVersion:p.row_version});   // only this field
  PKG.busy=false;if(!pkgOk())return;
  if(r.status===200){toast('Proposal accepted as a draft.');await packagesLoad();return}
  PKG.err[id]=apiMsg(r)+(Array.isArray(r.body.sets)?' ('+r.body.sets.map(String).join(', ')+')':'');
  if(r.status===409)await packagesLoad();else renderPackages();
}
async function pkgReject(arg){
  if(!/^\d{1,9}$/.test(arg||'')||PKG.busy||!PKG.imp||!pkgOk())return;
  const id=Number(arg),p=PKG.imp.proposals.find(x=>x.id===id);
  if(!p||p.status!=='staged')return;
  pkgKeep();delete PKG.err[id];
  const reason=(PKG.f['pkg_r_'+id]||'').trim();
  if(!reason){PKG.err[id]='A reason is required.';return renderPackages()}
  PKG.busy=true;renderPackages();
  const r=await api('POST','/api/import/package-proposals/'+id+'/reject',{reason,rowVersion:p.row_version});   // only these two fields
  PKG.busy=false;if(!pkgOk())return;
  if(r.status===200){delete PKG.f['pkg_r_'+id];toast('Proposal rejected.');await packagesLoad();return}
  PKG.err[id]=apiMsg(r);
  if(r.status===409)await packagesLoad();else renderPackages();
}
