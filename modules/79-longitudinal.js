// R9f: Longitudinal screen (one patient, overall timeline grouped by year and day, read only). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server (GET /api/patients/:id/longitudinal, R9e) projects the patient's records into display events. This page only shows
   them, grouped by year and day. It sends no free text and writes nothing. Effective time (when it was true) and recorded time
   (when it was entered) are shown apart. Entered-in-error rows are hidden unless asked for, then struck through. Events whose
   context cannot be established say "unmapped"; nothing is guessed. Context views come in R9g; this is the overall view only.
   Nothing here implies that two events are related because they are close in time. All text is escaped. */
const LG_PAGE=100;
const LG={events:[],pid:null,total:0,offset:0,hidden:0,truncated:false,errs:false,from:'',to:'',msg:'',loaded:false,busy:false,ctx:[],counts:null,avail:[],sel:null};
const LG_KIND={observation:'Value',note:'Signed note',problem:'Problem',allergy:'Allergy',medication:'Medication',encounter:'Encounter',note_amendment:'Note amendment',context_change:'Context change'};
const lgReset=()=>{LG.events=[];LG.pid=null;LG.total=0;LG.offset=0;LG.hidden=0;LG.truncated=false;LG.msg='';LG.loaded=false;LG.ctx=[];LG.counts=null;LG.avail=[];LG.sel=null};
const lgTime=v=>v?String(v).slice(0,16).replace('T',' '):'not recorded';
function renderLongitudinalNav(){
  const b=$('navLongitudinal');if(!b)return;
  const show=srvCan('cases:read');b.style.display=show?'':'none';
  if(!show){lgReset();if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
function lgQuery(offset){
  const p=['limit='+LG_PAGE,'offset='+offset];
  if(/^\d{4}-\d{2}-\d{2}$/.test(LG.from))p.push('from='+LG.from);
  if(/^\d{4}-\d{2}-\d{2}$/.test(LG.to))p.push('to='+LG.to);
  if(LG.ctx.length)p.push('context='+LG.ctx.map(encodeURIComponent).join(','));
  if(LG.errs)p.push('includeErrors=1');
  return '?'+p.join('&');
}
async function longitudinalLoad(more){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('cases:read')||!pid){lgReset();LG.pid=pid||null;return renderLongitudinal()}
  if(LG.busy)return;
  if(LG.pid!==pid){lgReset();LG.pid=pid}
  const off=more?LG.events.length:0;
  LG.busy=true;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/longitudinal'+lgQuery(off));
  LG.busy=false;
  if(!srvCan('cases:read')||!CASE||CASE.patientId!==pid)return;   // signed out or another patient opened meanwhile
  if(r.status!==200){LG.msg='The longitudinal view could not be loaded: '+apiMsg(r);if(!more)LG.events=[];LG.loaded=true;return renderLongitudinal()}
  const b=r.body||{};
  LG.events=more?LG.events.concat(b.events||[]):(b.events||[]);
  LG.total=Number(b.total)||0;LG.hidden=Number(b.hiddenInError)||0;LG.truncated=!!b.truncated;LG.msg='';LG.loaded=true;
  if(b.counts&&typeof b.counts==='object')LG.counts=b.counts;
  if(Array.isArray(b.available))LG.avail=b.available;
  renderLongitudinal();
}
const lgKeep=()=>{const f=$('lg_from'),t=$('lg_to');if(f)LG.from=f.value;if(t)LG.to=t.value};
function lgWhat(e){
  if(e.kind==='observation'){
    let v=e.value;if(v&&typeof v==='object')v=v.value!==undefined?v.value:JSON.stringify(v);
    const val=(v===null||v===undefined||v==='')?'no value':String(v);
    return`<b>${escA(e.fieldKey)}</b>: ${escA(val)}${e.unit?' '+escA(e.unit):''}${e.correctsId?` <span class="mu">(corrects value #${escA(e.correctsId)})</span>`:''}`;
  }
  if(e.kind==='note')return'<b>Signed note</b> <span class="mu">(open the Notes tab of the case to read it)</span>';
  return`<b>${escA(e.label||LG_KIND[e.kind]||e.kind)}</b>`;
}
// Context views (R9g): All, one context, or several together. The server filters; a record in two contexts is sent once.
function lgToggle(key){
  if(key==='all')LG.ctx=[];
  else if(LG.avail.some(a=>a.key===key))LG.ctx=LG.ctx.includes(key)?LG.ctx.filter(k=>k!==key):LG.ctx.concat(key);
  else return;
  lgKeep();return longitudinalLoad(false);
}
function lgChips(){
  if(!LG.avail.length)return'';
  const n=k=>LG.counts&&LG.counts[k]!==undefined?' ('+escA(LG.counts[k])+')':'';
  const chip=(k,label,on)=>`<button class="b ${on?'':'sec '}sm" data-act="longCtx" data-arg="${escA(k)}" aria-pressed="${on}"${LG.busy?' disabled':''}>${escA(label)}${n(k)}</button>`;
  let h='<div class="flex" style="margin:6px 0;gap:4px;flex-wrap:wrap">'+chip('all','All history',!LG.ctx.length)+LG.avail.map(a=>chip(a.key,a.label,LG.ctx.includes(a.key))).join('')+'</div>';
  if(LG.ctx.length>1)h+='<div class="mu">Combined view: records in any of the chosen contexts, each shown once, with every context it belongs to.</div>';
  else if(!LG.ctx.length&&LG.counts&&LG.counts.unmapped)h+=`<div class="mu">${escA(LG.counts.unmapped)} record(s) have no established context (unmapped); they appear in All history only.</div>`;
  return h;
}
function lgLanes(e){
  const c=Array.isArray(e.contexts)?e.contexts:[];
  if(c.length)return c.map(x=>`<span class="bd" title="${escA((x.reasons||[]).join('; '))}">${escA(x.label)}</span>`).join(' ');
  if(e.scope==='shared')return`<span class="mu">(shared: ${escA(e.scopeLabel||'shared')})</span>`;
  return e.scope==='unmapped'?'<span class="mu">(context: unmapped)</span>':'';
}
// Event detail drawer (R9h-1). Facts come from the record; the labels under "Worked out by this page" are derived here and say so.
// Previous/next look only at the events loaded in this page, never at older or newer unloaded ones. No causal wording.
function lgSelect(key){const e=LG.events.find(x=>x.key===key);LG.sel=e?e.key:null;renderLongitudinal()}
function lgNeighbours(e){
  if(e.kind!=='observation'||!e.fieldKey)return{prev:null,next:null};
  const same=LG.events.filter(x=>x.kind==='observation'&&x.fieldKey===e.fieldKey&&(!x.inError&&x.status!=='entered_in_error'||x.key===e.key));
  const i=same.findIndex(x=>x.key===e.key);
  return{prev:i>0?same[i-1]:null,next:i>=0&&i<same.length-1?same[i+1]:null};
}
function lgVal(e){
  let v=e.value;if(v&&typeof v==='object')v=v.value!==undefined?v.value:JSON.stringify(v);
  const val=(v===null||v===undefined||v==='')?'no value':String(v);
  return escA(val)+(e.unit&&val!=='no value'?' '+escA(e.unit):'');
}
function lgDrawer(){
  const e=LG.sel&&LG.events.find(x=>x.key===LG.sel);
  if(!e)return'';
  const gone=e.status==='entered_in_error',nb=lgNeighbours(e);
  const nbLine=(lbl,x)=>x?`<div>${lbl}: ${lgVal(x)} <span class="mu">(effective ${escA(lgTime(x.effectiveAt))}, ${escA(String(x.status||'no status'))})</span> <button class="b sec sm" data-act="longSelect" data-arg="${escA(x.key)}">Show</button></div>`:`<div class="mu">${lbl}: none among the loaded events</div>`;
  const mem=(Array.isArray(e.contexts)?e.contexts:[]).map(c=>`<li>${escA(c.label)}: ${escA((c.reasons||[]).join('; ')||'no reason recorded')}</li>`).join('');
  const chosen=LG.ctx.length?LG.avail.filter(a=>LG.ctx.includes(a.key)).map(a=>a.label).join(' + '):'';
  const why=!LG.ctx.length?'This is the overall view, which lists every record.':'It is listed because it belongs to a chosen context ('+escA(chosen)+').';
  return`<div class="note" id="lg_drawer" role="complementary" aria-label="Event detail"${gone?' style="border-left:4px solid var(--r)"':''}>
    <div class="flex" style="justify-content:space-between"><b>Event detail</b> <button class="b sec sm" data-act="longClose">Close</button></div>
    <h4 style="margin:6px 0 2px">From the record</h4>
    <div><span class="kind">${escA(e.kindLabel||LG_KIND[e.kind]||e.kind)}</span> ${e.kind==='observation'?`<b>${escA(e.fieldKey)}</b>: ${lgVal(e)}`:lgWhat(e)}${gone?' <span class="bd" style="background:var(--r)">entered in error</span>':''}</div>
    <div class="mu">Status: ${escA(e.status||'none')}${e.correctsId?' · corrects value #'+escA(e.correctsId):''}</div>
    <div class="mu">Effective (when true): ${escA(lgTime(e.effectiveAt))}</div>
    <div class="mu">Recorded (when entered): ${escA(lgTime(e.recordedAt))}</div>
    <div class="mu">By: ${escA(e.by===null||e.by===undefined?'unknown':e.by)}</div>
    <div class="mu">${lgSource(e)}</div>
    <h4 style="margin:8px 0 2px">Worked out by this page</h4>
    <div class="mu">Context: ${escA(e.scopeLabel||e.scope||'unmapped')}</div>
    ${mem?`<ul class="mu">${mem}</ul>`:''}
    <div class="mu">${why}</div>
    ${e.kind==='observation'?`<h4 style="margin:8px 0 2px">Same field, before and after</h4>${nbLine('Previous',nb.prev)}${nbLine('Next',nb.next)}`:''}
    <div class="mu" style="margin-top:6px">Events close in time are not shown as related, and nothing here says one caused another.</div></div>`;
}
function lgSource(e){
  const ref=`source ${escA(e.kind)} #${escA(e.sourceId)}`;
  if(e.caseId===null||e.caseId===undefined)return ref+' · no case';
  return`${ref} · case #${escA(e.caseId)} <button class="b sec sm" data-act="longOpenCase" data-arg="${escA(e.caseId)}" aria-label="Open case ${escA(e.caseId)}">Open case</button>`;
}
function renderLongitudinal(){
  const box=$('longitudinalBox');if(!box)return;
  if(!srvCan('cases:read')){box.innerHTML='';return}
  lgKeep();
  let h='<div class="gen-warn"><b>SYNTHETIC DEMO DATA — NOT FOR CLINICAL USE</b></div>';
  if(!CASE||!CASE.patientId){box.innerHTML=h+'<div class="empty">Open a registered patient\'s case first (Patients tab). The longitudinal view belongs to the patient and spans all their cases.</div>';return}
  const dis=LG.busy?' disabled':'';
  h+=`<div class="note">Overall record of <b>${escA(caseName(CASE))}</b>, oldest first, grouped by year and day. Read only. Each line shows when it was true or started (effective) and when it was entered (recorded) as separate things. Lines close in time are not shown as related. Note text is not shown here; open the source to read it.${LG.msg?' '+escA(LG.msg):''}
    <div class="field-row" style="margin-top:4px"><label class="mu">From <input type="date" id="lg_from" value="${escA(LG.from)}" aria-label="From date"></label>
    <label class="mu">To <input type="date" id="lg_to" value="${escA(LG.to)}" aria-label="To date"></label>
    <label class="mu"><input type="checkbox" id="lg_errs" data-act="longErrors" data-ev="change"${LG.errs?' checked':''}> Show entered in error</label>
    <button class="b sm" data-act="longReload"${dis}>Apply</button></div></div>`;
  h+=lgChips();
  if(LG.sel&&!LG.events.some(x=>x.key===LG.sel))LG.sel=null;
  h+=lgDrawer();
  if(LG.truncated)h+='<div class="gen-warn">Some sources have more rows than one request can read, so this view may be incomplete. Narrow the dates.</div>';
  if(!LG.errs&&LG.hidden)h+=`<div class="mu">${escA(LG.hidden)} entered-in-error row(s) are hidden.</div>`;
  if(LG.loaded&&!LG.events.length&&!LG.msg)h+=`<div class="empty">Nothing recorded ${LG.ctx.length?'for this context ':''}in this period.</div>`;
  let year='',day='';
  LG.events.forEach(e=>{
    const d=String(e.at||'').slice(0,10)||'undated',y=d==='undated'?'undated':d.slice(0,4);
    if(y!==year){year=y;day='';h+=`<h3 style="margin:14px 0 2px">${escA(y)}</h3>`}
    if(d!==day){day=d;h+=`<h4 style="margin:10px 0 2px">${escA(d)}</h4>`}
    const gone=e.status==='entered_in_error';
    h+=`<div class="cd"><span class="kind">${escA(e.kindLabel||LG_KIND[e.kind]||e.kind)}</span> <span${gone?' style="text-decoration:line-through"':''}>${lgWhat(e)}</span>
      ${gone?'<span class="bd" style="background:var(--r)">entered in error</span>':''} ${lgLanes(e)}
      <button class="b sec sm" data-act="longSelect" data-arg="${escA(e.key)}" aria-pressed="${LG.sel===e.key}">Details</button>
      <div class="mu">Effective ${escA(lgTime(e.effectiveAt))} · recorded ${escA(lgTime(e.recordedAt))} · by ${escA(e.by===null||e.by===undefined?'unknown':e.by)} · ${lgSource(e)}</div></div>`;
  });
  if(LG.events.length<LG.total)h+=`<div class="flex" style="margin-top:6px"><button class="b sec sm" data-act="longMore"${dis}>Load more (${escA(LG.events.length)} of ${escA(LG.total)})</button></div>`;
  else if(LG.loaded&&LG.events.length)h+=`<div class="mu">${escA(LG.total)} event(s) shown.</div>`;
  box.innerHTML=h;
}
async function lgOpenCase(serverId){
  // event.caseId is the server id; the page lists cases by a local id that carries it as serverId. Nothing is written.
  let c=CASES.find(x=>String(x.serverId)===String(serverId));
  if(!c&&srvMode()){await storeLoadCases();c=CASES.find(x=>String(x.serverId)===String(serverId))}
  if(!c){toast('That case could not be found.');return}
  await openCase(c.id);
  const b=document.querySelector('[data-t=case]');if(b)b.click();
}
