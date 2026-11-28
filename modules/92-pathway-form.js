// Task D11: the page draws the form of ONE applied package pathway from its layout (entry_form), using PathwayForm (pathway-form.js, D10).
// Task D13: two or more package pathways are drawn from the server's composed form (GET /api/cases/:id/composed-form, D12); a shared concept is drawn once, at its owner set.
// pfRender() returns an HTML string, or null when the old stacked form must be used (no layout, built-in or hand-made sets, or the composed answer is not here yet or not available).
// Layout only: every field is drawn by the existing fieldHTML, so values, series and storage are unchanged. No applied set is ever hidden. All text goes through escA.
// Prototype. Synthetic data only. Not for clinical use.
const CF={key:null,form:null,ok:false,busy:null};   // D13: the composed form of the open case, for the exact set of active pins in `key`
const cfKey=()=>CASE.serverId+':'+CASE.applied.filter(a=>a.srvAs).map(a=>a.srvAs).sort().join(',');
const cfMany=()=>srvCase()&&srvCan('cases:read')&&new Set(CASE.applied.filter(a=>a.srvAs&&a.fromPathway).map(a=>a.fromPathway+'@'+a.fromPathwayVersion)).size>=2;
async function cfLoad(){   // once per key; a failure or composed:false is remembered for that key (no retry loop); a late answer for an old key is dropped
  const key=cfKey(),c=CASE;if(CF.busy===key)return;CF.busy=key;let r;
  try{r=await api('GET','/api/cases/'+c.serverId+'/composed-form')}catch(e){r={status:0}}
  if(CF.busy===key)CF.busy=null;
  if(c!==CASE||cfKey()!==key)return;
  const ok=r.status===200&&!!r.body&&r.body.composed===true&&!!r.body.form&&Array.isArray(r.body.form.sections);
  CF.key=key;CF.ok=ok;CF.form=ok?r.body.form:null;renderForms();
}
const PF_TABS={problems:'Problems',allergies:'Allergies',medications:'Medications',orders:'Orders'};
function pfGoTab(t){   // only the four known tabs; the argument is looked up, never used to build a selector from free text
  if(!Object.prototype.hasOwnProperty.call(PF_TABS,t))return;
  const b=document.querySelector('nav [data-t="'+t+'"]');if(b&&b.style.display!=='none')b.click();
}
function pfSource(){   // the one pathway (slug and version) that placed this case's pins, with its stored layout; otherwise null
  if(!srvCase()||typeof PathwayForm==='undefined')return null;
  const from=CASE.applied.filter(a=>a.srvAs&&a.fromPathway);
  if(new Set(from.map(a=>a.fromPathway)).size!==1)return null;
  const vs=new Set(from.map(a=>String(a.fromPathwayVersion)));if(vs.size!==1)return null;
  const pw=PATHWAYS.find(p=>p.id===from[0].fromPathway&&p.layout&&p.srvPw&&String(p.srvPw.version)===[...vs][0]);
  return pw?{pw,from}:null;
}
function pfElement(it,pinOf,placed,by){
  const a=pinOf[it.set],s=resolve(a);let hid=0,qh=0,h=`<div class="mu" style="margin:6px 0"><b>${escA(it.title)}</b> · via pathway</div>`;
  it.fields.forEach(pf=>{
    const f=s.fields.find(x=>x.id===pf.id);if(!f)return;   // the full field (required, repeat, rationale) comes from the pinned definition
    if(adaptHidden(s,f,a)){hid++;return}if(modeHidden(s,f,a)){qh++;return}
    h+=fieldHTML(f,a);
    const u=by[it.set+'\u0000'+f.id];if(u)h+=`<div class="mu">Also used by: ${u.map(escA).join(', ')}</div>`;   // D13: the other sets that share this concept
  });
  placed.add(it.set);
  return[it.title,h+adaptNote(hid)+modeNote(qh)];
}
function pfSection(it){
  if(it.tab===null)return['Care episode','<div class="mu">Care episode: the layout marks a place here; the EMR has no separate area for it.</div>'];
  const n=PF_TABS[it.tab]||'';
  return[n,`<div class="mu" style="margin:6px 0">${escA(n)} are recorded in their own tab. <button class="b sec sm" data-act="pfGoTab" data-arg="${escA(it.tab)}">Open ${escA(n)}</button></div>`];
}
function pfDraw(form,pinOf){
  const placed=new Set(),by={};
  (form.shared||[]).forEach(x=>{const t=x.users.map(u=>pinOf[u.set]?resolve(pinOf[u.set]).title:null).filter(Boolean);if(t.length)by[x.owner.set+'\u0000'+x.owner.field]=t});
  let html='';
  form.sections.forEach(sec=>{
    let body='';
    sec.items.forEach(it=>{
      if(it.kind==='element'&&!pinOf[it.set])return;   // a set the page has no pin for is not drawn
      const[name,h]=it.kind==='element'?pfElement(it,pinOf,placed,by):pfSection(it);
      body+=it.visible?h:`<details><summary class="mu">Hidden by default: ${escA(name)}</summary>${h}</details>`;
    });
    html+=`<div class="cd"><h3 style="margin:0 0 6px">${escA(sec.label)}</h3>${body}</div>`;
  });
  const codes={};(form.problems||[]).forEach(p=>{if(p.code!=='section-marker')codes[p.code]=(codes[p.code]||0)+1});   // the care-episode marker is information, not a fault
  Object.keys(codes).forEach(c=>{html+=`<div class="note">Not shown: layout problem (${escA(c)}${codes[c]>1?' ×'+Number(codes[c]):''}).</div>`});
  CASE.applied.forEach(a=>{if(!placed.has(a.setId))html+=formCard(a)});   // anything the layout does not place stays visible as an ordinary card
  return html;
}
function pfRender(){
  const src=pfSource();
  if(src){
    const defs={},pinOf={};
    src.from.forEach(a=>{const s=resolve(a);if(s&&s.fields){defs[a.setId]={title:s.title,fields:s.fields};pinOf[a.setId]=a}});
    return pfDraw(PathwayForm.buildForm({entryForm:src.pw.layout.entryForm,contexts:src.pw.layout.contexts,sets:defs}),pinOf);
  }
  if(!cfMany())return null;
  const key=cfKey();if(CF.key!==key){cfLoad();return null}   // not here yet: the old form stays until the answer comes
  if(!CF.ok)return null;
  const pinOf={};CASE.applied.forEach(a=>{const s=a.srvAs&&resolve(a);if(s&&s.fields)pinOf[a.setId]=a});
  return pfDraw(CF.form,pinOf);
}
