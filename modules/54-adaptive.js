// R1c: adaptive history, display logic only. Classic script: shares the page's global scope.
// Top level is plain values and function declarations; page state (CASE) and renderForms are used only when a function runs.
/* A rule says: show the follow-up question (child) once an earlier question (parent) of the SAME set has one of these answers.
   Nothing is stored, scored or inferred. Three safety rules, enforced in adaptHidden:
   1. a follow-up that already has a value, an explicit Unknown or an entered-in-error row is always shown;
   2. "Show all questions" (ADAPT_ALL) shows everything;
   3. a rule whose parent is not in the same set is ignored (the question is shown).
   Complaint-set questions (R1a/R1b) are deliberately not gated here. */
const ADAPT_ALL={on:false};
const ADAPT_RULES=[
  {child:'opd_allergy_detail',parent:'opd_allergy',when:['Known (describe in the details field)']},
  {child:'adm_allergy_detail',parent:'adm_allergy',when:['Known (describe in the details field)']},
  {child:'opd_referral',parent:'opd_dispo',when:['Referred']}
];
function adaptRule(fid){return ADAPT_RULES.find(r=>r.child===fid)}
function adaptIsParent(fid){return ADAPT_RULES.some(r=>r.parent===fid)}
function adaptHidden(set,f,a){   // true when this question is held back for now
  if(ADAPT_ALL.on)return false;
  const r=adaptRule(f.id);if(!r)return false;
  if(!(set.fields||[]).some(x=>x.id===r.parent))return false;
  const ck=vkey(a,f.id),pk=vkey(a,r.parent);
  const own=CASE.values[ck];
  if((own!==undefined&&own!==null&&own!=='')||(CASE.vunk||{})[ck]||((CASE.vbad||{})[ck]||[]).length)return false;
  return!r.when.includes(CASE.values[pk]);
}
function adaptNote(hidden){
  if(!hidden&&!ADAPT_ALL.on)return'';
  return`<label class="mu" style="display:block;margin-top:6px"><input type="checkbox" data-act="adaptAll" data-ev="change"${ADAPT_ALL.on?' checked':''}> Show all questions${ADAPT_ALL.on?'':' ('+Number(hidden)+' follow-up '+(hidden===1?'question is':'questions are')+' hidden until an earlier answer asks for them)'}</label>`;
}
