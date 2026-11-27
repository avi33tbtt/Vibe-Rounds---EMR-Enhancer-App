// R9f: Longitudinal screen (one patient, overall timeline grouped by year and day, read only). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server (GET /api/patients/:id/longitudinal, R9e) projects the patient's records into display events. This page only shows
   them, grouped by year and day. It sends no free text and writes nothing. Effective time (when it was true) and recorded time
   (when it was entered) are shown apart. Entered-in-error rows are hidden unless asked for, then struck through. Events whose
   context cannot be established say "unmapped"; nothing is guessed. Context views come in R9g; this is the overall view only.
   Nothing here implies that two events are related because they are close in time. All text is escaped. */
const LG_PAGE=100;
const LG={events:[],pid:null,total:0,offset:0,hidden:0,truncated:false,errs:false,from:'',to:'',msg:'',loaded:false,busy:false};
const LG_KIND={observation:'Value',note:'Signed note',problem:'Problem',allergy:'Allergy',medication:'Medication',encounter:'Encounter',note_amendment:'Note amendment',context_change:'Context change'};
const lgReset=()=>{LG.events=[];LG.pid=null;LG.total=0;LG.offset=0;LG.hidden=0;LG.truncated=false;LG.msg='';LG.loaded=false};
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
  if(LG.truncated)h+='<div class="gen-warn">Some sources have more rows than one request can read, so this view may be incomplete. Narrow the dates.</div>';
  if(!LG.errs&&LG.hidden)h+=`<div class="mu">${escA(LG.hidden)} entered-in-error row(s) are hidden.</div>`;
  if(LG.loaded&&!LG.events.length&&!LG.msg)h+='<div class="empty">Nothing recorded in this period.</div>';
  let year='',day='';
  LG.events.forEach(e=>{
    const d=String(e.at||'').slice(0,10)||'undated',y=d==='undated'?'undated':d.slice(0,4);
    if(y!==year){year=y;day='';h+=`<h3 style="margin:14px 0 2px">${escA(y)}</h3>`}
    if(d!==day){day=d;h+=`<h4 style="margin:10px 0 2px">${escA(d)}</h4>`}
    const gone=e.status==='entered_in_error';
    h+=`<div class="cd"><span class="kind">${escA(e.kindLabel||LG_KIND[e.kind]||e.kind)}</span> <span${gone?' style="text-decoration:line-through"':''}>${lgWhat(e)}</span>
      ${gone?'<span class="bd" style="background:var(--r)">entered in error</span>':''}${e.scope==='unmapped'?' <span class="mu">(context: unmapped)</span>':''}
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
