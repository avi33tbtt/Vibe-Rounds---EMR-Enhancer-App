// R3h: Timeline screen (one patient, all their cases, read only). Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* The server (GET /api/patients/:id/timeline) merges observations, signed notes, problems, allergies and medications.
   This page only shows them, grouped by day. It sends no free text and writes nothing. Effective time (when it was true) and
   recorded time (when it was entered) are shown apart. Entered-in-error rows are hidden unless asked for, and then shown struck through. All text is escaped. */
const TL_PAGE=100;
const TL={events:[],pid:null,total:0,offset:0,hidden:0,truncated:false,errs:false,from:'',to:'',msg:'',loaded:false,busy:false};
const TL_KIND={observation:'Value',note:'Signed note',problem:'Problem',allergy:'Allergy',medication:'Medication'};
const TL_STAT={entered_in_error:'entered in error'};
const tlReset=()=>{TL.events=[];TL.pid=null;TL.total=0;TL.offset=0;TL.hidden=0;TL.truncated=false;TL.msg='';TL.loaded=false};
const tlTime=v=>v?String(v).slice(0,16).replace('T',' '):'not recorded';
function renderTimelineNav(){
  const b=$('navTimeline');if(!b)return;
  const show=srvCan('cases:read');b.style.display=show?'':'none';
  if(!show){tlReset();if(b.classList.contains('on'))document.querySelector('[data-t=case]').click()}
}
function tlQuery(offset){
  const p=['limit='+TL_PAGE,'offset='+offset];
  if(/^\d{4}-\d{2}-\d{2}$/.test(TL.from))p.push('from='+TL.from);
  if(/^\d{4}-\d{2}-\d{2}$/.test(TL.to))p.push('to='+TL.to);
  if(TL.errs)p.push('includeErrors=1');
  return '?'+p.join('&');
}
async function timelineLoad(more){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('cases:read')||!pid){tlReset();TL.pid=pid||null;return renderTimeline()}
  if(TL.busy)return;
  if(TL.pid!==pid){tlReset();TL.pid=pid}
  const off=more?TL.events.length:0;
  TL.busy=true;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/timeline'+tlQuery(off));
  TL.busy=false;
  if(!srvCan('cases:read')||!CASE||CASE.patientId!==pid)return;   // signed out or another patient opened meanwhile
  if(r.status!==200){TL.msg='The timeline could not be loaded: '+apiMsg(r);if(!more)TL.events=[];TL.loaded=true;return renderTimeline()}
  const b=r.body||{};
  TL.events=more?TL.events.concat(b.events||[]):(b.events||[]);
  TL.total=Number(b.total)||0;TL.hidden=Number(b.hiddenInError)||0;TL.truncated=!!b.truncated;TL.msg='';TL.loaded=true;
  renderTimeline();
}
const tlKeep=()=>{const f=$('tl_from'),t=$('tl_to');if(f)TL.from=f.value;if(t)TL.to=t.value};
function tlWhat(e){
  if(e.kind==='observation'){
    let v=e.value;if(v&&typeof v==='object')v=v.value!==undefined?v.value:JSON.stringify(v);
    const val=(v===null||v===undefined||v==='')?'no value':String(v);
    return`<b>${escA(e.fieldKey)}</b>: ${escA(val)}${e.unit?' '+escA(e.unit):''}${e.correctsId?` <span class="mu">(corrects value #${escA(e.correctsId)})</span>`:''}`;
  }
  if(e.kind==='note')return'<b>Signed note</b> <span class="mu">(open the Notes tab of the case to read it)</span>';
  return`<b>${escA(e.label)}</b>`;
}
function renderTimeline(){
  const box=$('timelineBox');if(!box)return;
  if(!srvCan('cases:read')){box.innerHTML='';return}
  tlKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='<div class="empty">Open a registered patient\'s case first (Patients tab). The timeline belongs to the patient and spans all their cases.</div>';return}
  const dis=TL.busy?' disabled':'';
  let h=`<div class="note">Timeline of <b>${escA(caseName(CASE))}</b> (synthetic data only). Read only: values, signed notes, problems, allergies and medications from all cases, oldest first. Note text and reasons are not shown here; open the source to read them. Each line shows when it was true or started (effective) and when it was entered (recorded) as separate things.${TL.msg?' '+escA(TL.msg):''}
    <div class="field-row" style="margin-top:4px"><label class="mu">From <input type="date" id="tl_from" value="${escA(TL.from)}" aria-label="From date"></label>
    <label class="mu">To <input type="date" id="tl_to" value="${escA(TL.to)}" aria-label="To date"></label>
    <label class="mu"><input type="checkbox" id="tl_errs" data-act="timelineErrors" data-ev="change"${TL.errs?' checked':''}> Show entered in error</label>
    <button class="b sm" data-act="timelineReload"${dis}>Apply</button></div></div>`;
  if(TL.truncated)h+='<div class="gen-warn">Some sources have more rows than one request can read, so this timeline may be incomplete. Narrow the dates.</div>';
  if(!TL.errs&&TL.hidden)h+=`<div class="mu">${escA(TL.hidden)} entered-in-error row(s) are hidden.</div>`;
  if(TL.loaded&&!TL.events.length&&!TL.msg)h+='<div class="empty">Nothing recorded in this period.</div>';
  let day='';
  TL.events.forEach(e=>{
    const d=String(e.at||'').slice(0,10)||'undated';
    if(d!==day){day=d;h+=`<h4 style="margin:10px 0 2px">${escA(d)}</h4>`}
    const gone=e.status==='entered_in_error',st=TL_STAT[e.status]||e.status;
    h+=`<div class="cd"><span class="kind">${escA(TL_KIND[e.kind]||e.kind)}</span> <span${gone?' style="text-decoration:line-through"':''}>${tlWhat(e)}</span>
      ${gone?`<span class="bd" style="background:var(--r)">${escA(st)}</span>`:''}
      <div class="mu">Effective ${escA(tlTime(e.effectiveAt))} · recorded ${escA(tlTime(e.recordedAt))} · by ${escA(e.by)} · case #${escA(e.caseId===null||e.caseId===undefined?'none':e.caseId)} · source ${escA(e.kind)} #${escA(e.sourceId)}</div></div>`;
  });
  if(TL.events.length<TL.total)h+=`<div class="flex" style="margin-top:6px"><button class="b sec sm" data-act="timelineMore"${dis}>Load more (${escA(TL.events.length)} of ${escA(TL.total)})</button></div>`;
  else if(TL.loaded&&TL.events.length)h+=`<div class="mu">${escA(TL.total)} event(s) shown.</div>`;
  box.innerHTML=h;
}
