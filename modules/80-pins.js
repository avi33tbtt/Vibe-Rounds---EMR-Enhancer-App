// R0e-1: pins (applied sets as server pins), moved unchanged from the inline script.
// Top-level constants are plain values or arrows (nothing here runs at load); PIN, CASE and the other page state stay in the page and are used only when a function runs.
/* ---------- Pins (B3b-1) ----------
   Signed in, an applied set is a server pin of ONE exact published version (case_applied_sets). The page shows that version, reads its
   definition from the server (so an older pin keeps its own fields), and moves to a newer version only by the explicit update.
   Withdrawing keeps the pin and anything recorded with it. Nothing about applied sets is written to the browser. */
const pinEntry=r=>({setId:r.slug,srvAs:String(r.id),srvSet:String(r.element_set_id),version:r.version,checksum:r.checksum,title:r.set_title,addedAt:r.applied_at,appliedBy:r.applied_by,
  fromPathway:r.from_pathway_slug||null,fromPathwayTitle:r.from_pathway_title||null,fromPathwayVersion:r.from_pathway_version||null});   // the source pathway is the server's record (B4a), so it survives a reload
async function pinDef(e){
  const k=e.srvSet+':'+e.version;if(PIN.defs[k])return true;
  const r=await api('GET','/api/element-sets/'+e.srvSet+'/versions/'+e.version),v=r.status===200&&r.body.version,d=v&&v.definition;
  if(!d||!Array.isArray(d.fields))return false;
  PIN.defs[k]={id:e.setId,kind:r.body.set.kind,title:d.title,desc:d.desc||'',fields:d.fields,version:v.version,sdc:d.sdc,srv:{setId:Number(e.srvSet),version:v.version,checksum:v.checksum}};
  return true;
}
async function pinsLoad(c){   // the case's active pins (+ its observations, B3b-2); the timeline route also lists superseded and withdrawn pins (history), which are not shown here
  const r=await api('GET','/api/cases/'+c.serverId+'/timeline?limit=500&includeErrors=1');
  if(r.status!==200){toast('Applied sets could not be loaded: '+apiMsg(r));return false}
  const act=(r.body.appliedSets||[]).filter(x=>x.state==='active').map(pinEntry);
  await Promise.all(act.map(pinDef));c.applied=act;
  c.obs=Array.isArray(r.body.observations)?r.body.observations:[];c.obsCut=c.obs.length>=500;valuesRebuild(c);return true;
}
async function pinPost(c,s){return api('POST','/api/cases/'+c.serverId+'/applied-sets',{setId:s.srv.setId,version:s.srv.version})}
async function applySetSrv(id,fromPathway){
  const c=CASE,s=getSet(id);if(!s)return toast('That set or pathway is not in the server library.');
  if(!c.serverId)return toast('Open a patient on the Patients tab first: sets are applied to a saved case.');
  if(!srvCan('cases:write'))return toast('Your role cannot change cases.');
  if(c.pinsOk!==true)return toast('The applied sets of this case are not loaded. Open the case again.');
  if(PIN.busy)return;PIN.busy=true;
  try{
    if(s.kind==='pathway')return await applyPathwaySrv(c,s);
    if(isApplied(id))return toast('Already applied');
    if(!s.srv)return toast('Not applied: only published sets from the server library can be applied to a saved case.');
    const r=await pinPost(c,s);
    if(r.status!==201){toast('Not applied: '+apiMsg(r));await pinsLoad(c);if(c===CASE)renderAll();return}
    const e=pinEntry(r.body.appliedSet);await pinDef(e);c.applied.push(e);
    if(c===CASE)renderAll();toast('Added: '+s.title);
  }finally{PIN.busy=false}
}
async function applyPathwaySrv(c,s){   // one server call: the pathway version's exact set versions are pinned together, each linked to it (B4a); the server skips what the case already has
  if(!s.srvPw)return toast('That pathway is not published on the server.');
  const r=await api('POST','/api/cases/'+c.serverId+'/applied-pathways',{pathwayId:s.srvPw.pathwayId,version:s.srvPw.version});
  if(r.status!==201){toast('Not applied: '+apiMsg(r));await pinsLoad(c);if(c===CASE)renderAll();return}
  for(const row of r.body.appliedSets||[]){const e=pinEntry(row);await pinDef(e);c.applied.push(e)}
  const sk=r.body.skipped||[];
  if(c===CASE)renderAll();
  toast('Pathway applied: '+s.title+' v'+s.srvPw.version+(sk.length?` (${sk.length} set(s) already on the case were left as they are: ${sk.map(x=>x.slug+(x.reason==='other_version_applied'?' v'+x.appliedVersion:'')).join(', ')})`:''));
}
async function removeSetSrv(id){
  const c=CASE,a=c.applied.find(x=>x.setId===id);if(!a||!a.srvAs)return;
  if(!srvCan('cases:write'))return toast('Your role cannot change cases.');
  if(!confirm(`Withdraw ${a.title} (v${a.version}) from this case? The pin and anything recorded with it stay in the record; the set just takes no new values.`))return;
  if(PIN.busy)return;PIN.busy=true;
  try{
    const r=await api('POST','/api/cases/'+c.serverId+'/applied-sets/'+a.srvAs+'/withdraw',{});
    if(r.status===200){c.applied=c.applied.filter(x=>x!==a);toast('Withdrawn')}else{toast(apiMsg(r));await pinsLoad(c)}
    if(c===CASE)renderAll();
  }finally{PIN.busy=false}
}
async function upgradeSrv(a,s){   // the explicit update: the server pins the newer published version and supersedes the old pin
  const c=CASE;if(PIN.busy)return;PIN.busy=true;
  try{
    const r=await pinPost(c,s);
    if(r.status!==201){toast(apiMsg(r));await pinsLoad(c);if(c===CASE)renderAll();return}
    const e=pinEntry(r.body.appliedSet);await pinDef(e);c.applied=c.applied.map(x=>x===a?e:x);
    if(c===CASE)renderAll();toast('Updated to v'+e.version);
  }finally{PIN.busy=false}
}
