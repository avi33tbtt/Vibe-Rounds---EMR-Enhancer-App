// R9f: Longitudinal screen (one patient, overall timeline grouped by year and day, read only). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server (GET /api/patients/:id/longitudinal, R9e) projects the patient's records into display events. This page only shows
   them, grouped by year and day. It sends no free text and writes nothing. Effective time (when it was true) and recorded time
   (when it was entered) are shown apart. Entered-in-error rows are hidden unless asked for, then struck through. Events whose
   context cannot be established say "unmapped"; nothing is guessed. Context views come in R9g; this is the overall view only.
   Nothing here implies that two events are related because they are close in time. All text is escaped. */
const LG_PAGE=100;
const LG={events:[],pid:null,total:0,offset:0,hidden:0,truncated:false,errs:false,from:'',to:'',msg:'',loaded:false,busy:false,ctx:[],counts:null,avail:[],sel:null,date:null,trend:''};
const LG_KIND={observation:'Value',note:'Signed note',problem:'Problem',allergy:'Allergy',medication:'Medication',encounter:'Encounter',note_amendment:'Note amendment',context_change:'Context change'};
const lgReset=()=>{LG.events=[];LG.pid=null;LG.total=0;LG.offset=0;LG.hidden=0;LG.truncated=false;LG.msg='';LG.loaded=false;LG.ctx=[];LG.counts=null;LG.avail=[];LG.sel=null;LG.date=null;LG.trend=''};
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
const lgDay=e=>String(e.at||'').slice(0,10);
// One selected date (R9h-2): chosen by selecting an event or a day heading, kept when the context view, the date range or the drawer changes.
function lgSelect(key){const e=LG.events.find(x=>x.key===key);LG.sel=e?e.key:null;if(e&&/^\d{4}-\d{2}-\d{2}$/.test(lgDay(e)))LG.date=lgDay(e);renderLongitudinal(true)}
function lgPickDate(d){LG.date=/^\d{4}-\d{2}-\d{2}$/.test(d)?d:null;renderLongitudinal(true)}
// Per lane (each context in view, or each context the server lists in the overall view): how many loaded events fall on the selected date.
function lgDateLanes(){
  if(!LG.date)return'';
  const on=LG.events.filter(e=>lgDay(e)===LG.date);
  const lanes=(LG.ctx.length?LG.avail.filter(a=>LG.ctx.includes(a.key)):LG.avail).map(a=>{const n=on.filter(e=>(e.contexts||[]).some(c=>c.key===a.key)).length;return`${escA(a.label)}: ${n}`});
  if(!LG.ctx.length)lanes.push('Unmapped: '+on.filter(e=>e.scope==='unmapped').length);
  return`<div class="note" id="lg_date">Selected date <b>${escA(LG.date)}</b> (kept when you change the view). Records on that date in this view: ${escA(on.length)}${on.length?'':' — none in the loaded part of this view'}. By lane: ${lanes.join(' · ')}. <button class="b sec sm" data-act="longClearDate">Clear date</button></div>`;
}
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
// Trend chart (R9i): one field in ONE unit at a time, drawn from the events already loaded. Values of different units are never joined
// (each field+unit pair is its own choice). A value is plotted only if it is a finite number; no value, unknown, text and entered-in-error
// are left out and counted, never drawn as zero. The axis does not start at zero and says so. Nothing here is a threshold or a target.
const lgUnit=u=>u===null||u===undefined||u===''?'':String(u);
function lgNum(e){
  let v=e.value;if(v&&typeof v==='object')v=v.value;
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  if(typeof v==='string'&&/^-?\d+(\.\d+)?$/.test(v.trim()))return Number(v);
  return null;
}
const lgWhen=e=>{const t=Date.parse(e.effectiveAt||e.at||'');return Number.isFinite(t)?t:null};
function lgSeries(){
  const obs=LG.events.filter(e=>e.kind==='observation'&&e.fieldKey);
  const groups=new Map();
  obs.forEach(e=>{
    const id=e.fieldKey+'|'+lgUnit(e.unit);
    const g=groups.get(id)||{id,field:e.fieldKey,unit:lgUnit(e.unit),pts:[],skipped:0};groups.set(id,g);
    const v=lgNum(e),t=lgWhen(e);
    if(e.status==='entered_in_error'||e.inError||v===null||t===null)g.skipped++;
    else g.pts.push({key:e.key,v,t,day:lgDay(e)});
  });
  return[...groups.values()].filter(g=>g.pts.length>=2).sort((a,b)=>a.id<b.id?-1:1);
}
function lgTrend(){
  const all=lgSeries();
  if(!all.length)return LG.events.length?'<div class="mu">Trend chart: no field has two or more plottable numeric values among the loaded events.</div>':'';
  const g=all.find(x=>x.id===LG.trend)||null;
  const opts=all.map(x=>`<option value="${escA(x.id)}"${g&&g.id===x.id?' selected':''}>${escA(x.field)} (${escA(x.unit||'no unit')})</option>`).join('');
  let h=`<div class="note" id="lg_trend_box"><label class="mu">Trend of <select id="lg_trend" data-act="longTrend" data-ev="change" aria-label="Field to chart"><option value="">none</option>${opts}</select></label>`;
  if(g){
    const W=640,H=190,L=56,R=12,T=12,B=28,pts=g.pts.slice().sort((a,b)=>a.t-b.t);
    let lo=Math.min(...pts.map(p=>p.v)),hi=Math.max(...pts.map(p=>p.v));if(lo===hi){lo-=1;hi+=1}
    const t0=pts[0].t,t1=pts[pts.length-1].t,span=(t1-t0)||1;
    const X=t=>L+(t-t0)/span*(W-L-R),Y=v=>T+(hi-v)/(hi-lo)*(H-T-B);
    const unit=g.unit?' '+escA(g.unit):'';
    const line=pts.map(p=>X(p.t).toFixed(1)+','+Y(p.v).toFixed(1)).join(' ');
    const dots=pts.map(p=>`<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="${p.key===LG.sel?6:4}" fill="${p.key===LG.sel?'#b00':'#06c'}" data-act="longSelect" data-arg="${escA(p.key)}" style="cursor:pointer" tabindex="0"><title>${escA(p.day)}: ${escA(p.v)}${unit}</title></circle>`).join('');
    const sel=LG.date?pts.find(p=>p.day===LG.date):null;
    const selLine=sel?`<line x1="${X(sel.t).toFixed(1)}" x2="${X(sel.t).toFixed(1)}" y1="${T}" y2="${H-B}" stroke="#b00" stroke-dasharray="3,3"/>`:'';
    h+=`<svg id="lg_chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Trend of ${escA(g.field)}${g.unit?' in '+escA(g.unit):''}, ${pts.length} values"><line x1="${L}" x2="${L}" y1="${T}" y2="${H-B}" stroke="currentColor" opacity=".4"/><line x1="${L}" x2="${W-R}" y1="${H-B}" y2="${H-B}" stroke="currentColor" opacity=".4"/>
      <text x="${L-4}" y="${T+8}" text-anchor="end" font-size="10" fill="currentColor">${escA(hi)}</text><text x="${L-4}" y="${H-B}" text-anchor="end" font-size="10" fill="currentColor">${escA(lo)}</text>
      <text x="${L}" y="${H-10}" font-size="10" fill="currentColor">${escA(new Date(t0).toISOString().slice(0,10))}</text><text x="${W-R}" y="${H-10}" text-anchor="end" font-size="10" fill="currentColor">${escA(new Date(t1).toISOString().slice(0,10))}</text>
      ${selLine}<polyline points="${line}" fill="none" stroke="#06c" stroke-width="1.5"/>${dots}</svg>
      <div class="mu">${escA(pts.length)} value(s) in ${escA(g.unit||'no unit')}, at their effective time. The vertical axis does not start at zero. ${g.skipped?escA(g.skipped)+' row(s) of this field and unit are not plotted (no value, not a number, or entered in error); they are not counted as zero. ':''}Click a point to see its detail. The chart shows what was recorded; it does not show why it changed.</div>`;
  }
  return h+'</div>';
}
function lgSource(e){
  const ref=`source ${escA(e.kind)} #${escA(e.sourceId)}`;
  if(e.caseId===null||e.caseId===undefined)return ref+' · no case';
  return`${ref} · case #${escA(e.caseId)} <button class="b sec sm" data-act="longOpenCase" data-arg="${escA(e.caseId)}" aria-label="Open case ${escA(e.caseId)}">Open case</button>`;
}
function renderLongitudinal(jump){
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
  h+=lgDateLanes();
  h+=lgTrend();
  h+=lgDrawer();
  if(LG.truncated)h+='<div class="gen-warn">Some sources have more rows than one request can read, so this view may be incomplete. Narrow the dates.</div>';
  if(!LG.errs&&LG.hidden)h+=`<div class="mu">${escA(LG.hidden)} entered-in-error row(s) are hidden.</div>`;
  if(LG.loaded&&!LG.events.length&&!LG.msg)h+=`<div class="empty">Nothing recorded ${LG.ctx.length?'for this context ':''}in this period.</div>`;
  let year='',day='';
  LG.events.forEach(e=>{
    const d=String(e.at||'').slice(0,10)||'undated',y=d==='undated'?'undated':d.slice(0,4);
    if(y!==year){year=y;day='';h+=`<h3 style="margin:14px 0 2px">${escA(y)}</h3>`}
    if(d!==day){day=d;const on=d===LG.date;h+=`<h4 style="margin:10px 0 2px${on?';background:var(--y,#fff3b0)':''}"${on?' id="lg_seldate" aria-current="date"':''}>${escA(d)} <button class="b sec sm" data-act="longDate" data-arg="${escA(d)}" aria-label="Select date ${escA(d)}">Select date</button></h4>`}
    const gone=e.status==='entered_in_error';
    h+=`<div class="cd"><span class="kind">${escA(e.kindLabel||LG_KIND[e.kind]||e.kind)}</span> <span${gone?' style="text-decoration:line-through"':''}>${lgWhat(e)}</span>
      ${gone?'<span class="bd" style="background:var(--r)">entered in error</span>':''} ${lgLanes(e)}
      <button class="b sec sm" data-act="longSelect" data-arg="${escA(e.key)}" aria-pressed="${LG.sel===e.key}">Details</button>
      <div class="mu">Effective ${escA(lgTime(e.effectiveAt))} · recorded ${escA(lgTime(e.recordedAt))} · by ${escA(e.by===null||e.by===undefined?'unknown':e.by)} · ${lgSource(e)}</div></div>`;
  });
  if(LG.events.length<LG.total)h+=`<div class="flex" style="margin-top:6px"><button class="b sec sm" data-act="longMore"${dis}>Load more (${escA(LG.events.length)} of ${escA(LG.total)})</button></div>`;
  else if(LG.loaded&&LG.events.length)h+=`<div class="mu">${escA(LG.total)} event(s) shown.</div>`;
  box.innerHTML=h;
  if(jump){const t=$('lg_seldate');if(t&&t.scrollIntoView)t.scrollIntoView({block:'nearest'})}
}
async function lgOpenCase(serverId){
  // event.caseId is the server id; the page lists cases by a local id that carries it as serverId. Nothing is written.
  let c=CASES.find(x=>String(x.serverId)===String(serverId));
  if(!c&&srvMode()){await storeLoadCases();c=CASES.find(x=>String(x.serverId)===String(serverId))}
  if(!c){toast('That case could not be found.');return}
  await openCase(c.id);
  const b=document.querySelector('[data-t=case]');if(b)b.click();
}
