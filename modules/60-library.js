// R0d-1: the server library screen (sets and pathways, demo import), moved unchanged from the inline script.
// Top-level constants are plain values or arrows (nothing here runs at load); page functions are called only when used.
/* ---------- Server library (B2b-1) ----------
   Signed in: the library is the PUBLISHED sets on the server (latest published version of each). They are read-only here.
   The demo built-ins are not shown; an admin or doctor can send the demo library for review once (8c-2): it is created as v1 and submitted, and shows here only after an informatician approves it and an admin publishes it.
   Pinning an exact version on a case, the visible diff and the explicit update are done in B3a/B3b, not here. */
const LIB={busy:false,msg:'',loaded:false,slugs:new Set(),pwSlugs:new Set()};
const SRV_RO='Sets from the server library are read-only. Make a new version through the library API, or use a different id.';
const srvLocked=id=>{const s=REGISTRY.find(x=>x.id===id);return!!(s&&s.srv)};
const DEMO_IMPORT=['basic_emr','glucose_ss','dka_ctx','snake_ctx','vitals','opd_visit','ipd_admission','ipd_progress','ipd_discharge','cc_fever','cc_cough','cc_abdo','cc_headache','cc_chest','cc_joint'];
const DEF_FIELD_KEYS=['id','label','type','unit','options','repeat','required','derived','flag','rationale','citation','codingPolicy','linkId','sdcType','text','path'];
function libDef(s,withCodes=true){   // the whitelist the server accepts: declarative text, true/false, lists and objects only
  const fields=(s.fields||[]).map(f=>{
    const o={};copyFieldKeys(f,o);
    const bs=bnds(f).map(b=>{const x={system:String(b.system),code:String(b.code)};if(b.display)x.display=String(b.display);if(['manual','llm','sdc'].includes(b.source))x.source=b.source;return x});
    if(bs.length&&withCodes)o.bindings=bs;
    return o;
  });
  const d={title:s.title,fields};if(s.desc)d.desc=s.desc;return d;
}
function copyFieldKeys(f,o){DEF_FIELD_KEYS.forEach(k=>{if(f[k]!==undefined&&f[k]!==null)o[k]=JSON.parse(JSON.stringify(f[k]))})}
function libApply(sets,pws){
  PATHWAYS=pws||[];
  const ids=new Set(sets.map(x=>x.id));
  REGISTRY=[...sets,...REGISTRY.filter(x=>!x.srv&&!ids.has(x.id)&&!BUILTIN.find(b=>b.id===x.id))];
  LIB.loaded=true;renderAll();
}
async function libLoad(){
  if(!srvMode())return;
  LIB.msg='';
  if(!srvCan('sets:read')){LIB.msg='Your role cannot read the library.';return libApply([],[])}
  const l=await api('GET','/api/element-sets');
  if(!Srv.user)return;
  if(l.status!==200){LIB.msg='The library could not be loaded: '+apiMsg(l);return libApply([],[])}
  LIB.slugs=new Set((l.body.sets||[]).map(x=>x.slug));
  const pubs=(l.body.sets||[]).filter(x=>x.published_version);
  const res=await Promise.all(pubs.map(x=>api('GET','/api/element-sets/'+x.id+'/versions/'+x.published_version)));
  if(!Srv.user)return;
  const sets=[];let skipped=0;
  res.forEach((r,i)=>{
    const x=pubs[i],v=r.status===200&&r.body.version,d=v&&v.definition;
    if(!d||!Array.isArray(d.fields)){skipped++;return}
    sets.push({id:x.slug,kind:x.kind,title:d.title,desc:d.desc||'',fields:d.fields,version:v.version,sdc:d.sdc,
      srv:{setId:x.id,version:v.version,checksum:v.checksum,publishedBy:v.published_by}});
  });
  if(skipped)LIB.msg=skipped+' published set(s) could not be read and are left out.';
  const pws=await pwLoad();
  if(!Srv.user)return;
  libApply(sets,pws);
}
async function pwLoad(){   // published pathways (B4b): the latest published version of each, with its exact steps
  LIB.pwSlugs=new Set();
  const l=await api('GET','/api/pathways');
  if(l.status!==200){LIB.msg=(LIB.msg?LIB.msg+' ':'')+'Pathways could not be loaded: '+apiMsg(l);return[]}
  LIB.pwSlugs=new Set((l.body.pathways||[]).map(x=>x.slug));
  const pubs=(l.body.pathways||[]).filter(x=>x.published_version);
  const res=await Promise.all(pubs.map(x=>api('GET','/api/pathways/'+x.id+'/versions/'+x.published_version)));
  const out=[];let bad=0;
  res.forEach((r,i)=>{
    const x=pubs[i],v=r.status===200&&r.body.version;
    if(!v||!Array.isArray(v.steps)){bad++;return}
    out.push({id:x.slug,kind:'pathway',title:v.title,desc:v.description||'',members:v.steps.map(t=>t.set_slug),
      srvPw:{pathwayId:x.id,version:v.version,checksum:v.checksum,steps:v.steps.map(t=>({slug:t.set_slug,version:t.set_version}))}});
  });
  if(bad)LIB.msg=(LIB.msg?LIB.msg+' ':'')+bad+' published pathway(s) could not be read and are left out.';
  return out;
}
function renderLibSrv(){
  const box=$('libSrv');if(!box)return;
  if(!srvMode()){box.innerHTML='';return}
  const have=new Set(REGISTRY.filter(x=>x.srv).map(x=>x.id)),todo=DEMO_IMPORT.filter(id=>!have.has(id)&&!LIB.slugs.has(id));   // already on the server in any state (draft, in review, published) is not offered again
  let h=`<div class="note">Signed in: this library is read from the server (published versions only) and is read-only here.${LIB.msg?' '+escA(LIB.msg):''}</div>`;
  if(srvCan('sets:write')&&srvCan('sets:submit')&&todo.length)
    h+=`<div class="cd"><b>Send the demo library for review</b><div class="mu" style="margin:4px 0 8px">One time, as v1 submitted by you (${escA(Srv.user.username)}): ${todo.map(id=>escA(BUILTIN.find(b=>b.id===id).title)).join(', ')}. Synthetic demo content. It goes in without terminology codes (the server cannot verify them yet; add them in a later version). It appears in this library only after an informatician approves it and an admin publishes it.</div><button class="b sm" data-act="libImport"${LIB.busy?' disabled':''}>Create and submit for review</button></div>`;
  const pw=pwTodo();
  if(srvCan('sets:write')&&srvCan('sets:publish')&&(pw.ready.length||pw.waiting.length)){
    h+=`<div class="cd"><b>Import the demo pathways</b><div class="mu" style="margin:4px 0 8px">One time, as published v1 by you (${escA(Srv.user.username)}). Each step names the exact published version of a set. ${pw.ready.length?'Ready: '+pw.ready.map(x=>escA(x.title)).join(', ')+'.':'None are ready yet.'}${pw.waiting.length?' Waiting for their sets to be published: '+pw.waiting.map(x=>escA(x.title)).join(', ')+'.':''}</div>${pw.ready.length?`<button class="b sm" data-act="libPwImport"${LIB.busy?' disabled':''}>Import ${pw.ready.length} demo pathway(s)</button>`:''}</div>`;
  }
  box.innerHTML=h;
}
const pwTodo=()=>{   // demo pathways not on the server yet (in any state), split by whether every member set is published there
  const pub=Object.fromEntries(REGISTRY.filter(x=>x.srv).map(x=>[x.id,x.srv])),todo=DEMO_PATHWAYS.filter(x=>!LIB.pwSlugs.has(x.id));
  return{ready:todo.filter(x=>x.members.every(m=>pub[m])),waiting:todo.filter(x=>!x.members.every(m=>pub[m]))};
};
async function libPwImport(){
  if(LIB.busy||!srvCan('sets:write')||!srvCan('sets:publish'))return;
  const todo=pwTodo().ready;if(!todo.length)return;
  if(!confirm('Create and publish version 1 of these demo pathways on the server?\n\n'+todo.map(x=>'- '+x.title).join('\n')+'\n\nEach step names the exact set version published now. A published pathway version cannot be changed.'))return;
  LIB.busy=true;renderLibSrv();
  const out=[],pub=Object.fromEntries(REGISTRY.filter(x=>x.srv).map(x=>[x.id,x.srv]));
  try{
    for(const x of todo){
      const c=await api('POST','/api/pathways',{slug:x.id,title:x.title,description:x.desc||'',steps:x.members.map(m=>({setId:pub[m].setId,version:pub[m].version}))});
      if(!Srv.user)return;
      if(c.status!==201){out.push(x.title+': '+(c.status===409&&c.body&&c.body.error==='slug_taken'?'already on the server (not changed)':apiMsg(c))+'.');continue}
      const p=await api('POST','/api/pathways/'+c.body.pathway.id+'/versions/1/publish',{});
      if(!Srv.user)return;
      out.push(p.status===200?x.title+': v1 published.':x.title+': created as a draft but not published ('+apiMsg(p)+').');
    }
  }finally{LIB.busy=false}
  await libLoad();
  if(Srv.user){LIB.msg=out.join(' ');renderLibSrv();toast(out.length?out[out.length-1]:'Nothing imported')}
}
async function libImport(){
  if(LIB.busy||!srvCan('sets:write')||!srvCan('sets:submit'))return;
  const have=new Set(REGISTRY.filter(x=>x.srv).map(x=>x.id)),todo=DEMO_IMPORT.filter(id=>!have.has(id)&&!LIB.slugs.has(id));   // already on the server in any state (draft, in review, published) is not offered again
  if(!todo.length)return;
  if(!confirm('Create version 1 of these demo sets on the server and submit them for review?\n\n'+todo.map(id=>'- '+BUILTIN.find(b=>b.id===id).title).join('\n')+'\n\nThey are not usable until a reviewer approves them and an admin publishes them. A submitted version cannot be changed.'))return;
  LIB.busy=true;renderLibSrv();
  const out=[];
  try{
    for(const id of todo){
      const b=BUILTIN.find(x=>x.id===id);
      const c=await api('POST','/api/element-sets',{slug:id,kind:b.kind,definition:libDef(b,false)});   // 8c-2: no codes. The server cannot verify a code yet, and review refuses unverified ones, so the demo goes in uncoded
      if(!Srv.user)return;
      if(c.status!==201){out.push(b.title+': '+(c.status===409?'a set with this id already exists on the server (not changed)':apiMsg(c))+'.');continue}
      const p=await api('POST','/api/element-sets/'+c.body.set.id+'/versions/1/submit',{});
      if(!Srv.user)return;
      out.push(p.status===200?b.title+': v1 submitted for review.':b.title+': created as a draft but not submitted ('+apiMsg(p)+').');
    }
  }finally{LIB.busy=false}
  await libLoad();
  if(Srv.user){LIB.msg=out.join(' ');renderLibSrv();toast(out.length?out[out.length-1]:'Nothing imported')}
  await verLoad();
}
