// R1f: quick and detailed mode, display logic only. Classic script: shares the page's global scope.
// Top level is plain values and function declarations; page state (CASE) and renderForms are used only when a function runs.
/* Quick mode keeps only the listed questions of a long form on the screen. Nothing is stored, sent, scored or inferred,
   and the context envelope is the same in both modes. Safety rules, enforced in modeHidden:
   1. a question that already holds a value (a scalar value, any row of a repeating field), an explicit Unknown or an entered-in-error row is always shown;
   2. Detailed (the default) shows everything;
   3. a set with no entry in QUICK_FIELDS is never touched, and an entry naming no real field of the set is ignored.
   Not gated on purpose: IPD sets (safety checklist items), complaint, examination and assessment sets. Same caution as R1c.
   The table is keyed by the applied set's id, which is the same for a built-in and a server-pinned set.
   The mode lives in the page only (not in storage, not on the server) and resets to Detailed on reload. */
const MODE={quick:false};
const QUICK_FIELDS={
  opd_visit:['opd_visit_type','opd_cc','opd_hpi','opd_meds','opd_allergy','opd_allergy_detail','opd_impression','opd_plan','opd_advice','opd_warn','opd_referral','opd_dispo','opd_fu']
};
function modeHidden(set,f,a){   // true when this question is left off the screen in Quick mode
  if(!MODE.quick||!a)return false;
  const q=QUICK_FIELDS[a.setId];if(!q)return false;
  const ids=(set.fields||[]).map(x=>x.id);
  if(!q.some(id=>ids.includes(id)))return false;
  if(q.includes(f.id))return false;
  const k=vkey(a,f.id),own=CASE.values[k];
  if(Array.isArray(own)?own.length>0:(own!==undefined&&own!==null&&own!==''))return false;
  if((CASE.vunk||{})[k]||((CASE.vbad||{})[k]||[]).length)return false;
  return true;
}
function modeNote(n){
  if(!MODE.quick||!n)return'';
  return`<div class="mu" style="margin-top:6px">Quick view: ${Number(n)} more ${n===1?'question is':'questions are'} not shown. <button class="b sec sm" data-act="setMode" data-arg="detailed">Show detailed</button></div>`;
}
function setMode(v){MODE.quick=v==='quick';renderMode();renderForms()}
function renderMode(){
  for(const [id,on] of [['modeQuick',MODE.quick],['modeDetailed',!MODE.quick]]){
    const b=$(id);if(!b)continue;
    b.setAttribute('aria-pressed',on?'true':'false');b.classList.toggle('sec',!on);
  }
}
