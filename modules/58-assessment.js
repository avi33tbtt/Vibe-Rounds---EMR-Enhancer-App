// R1e: the assessment and plan block and its picker. Classic script: shares the page's global scope.
// Top level is plain values and function declarations only; page functions (applySet, isApplied) are called when used.
/* One ordinary element set recognised by the id prefix `ap_` (no new set kind).
   Free text is the clinician's own words: nothing here suggests a diagnosis, a treatment or a dose.
   No codes (a code can only be called verified once the server checks it: R2), no thresholds, no numbers, no rules.
   One status for the whole block, not per problem: observations are stored per field, so a multi-field row cannot be linked.
   Text fields are withheld from the context envelope as narrative (envelope.js); selects, boolean and datetime flow as plain values. */
const AP_PREFIX='ap_';
const AP_SETS=[
  {id:'ap_block',kind:'template',title:'Assessment and plan',desc:'Problems, status, plan and follow-up as the clinician decides them',
   fields:[
     {id:'ap_problem',label:"Problem or diagnosis, in the clinician's words",type:'text',repeat:true},
     {id:'ap_status',label:'Status of the diagnosis as recorded',type:'select',options:['Working diagnosis','Confirmed','Not yet clear']},
     {id:'ap_ddx',label:'Other possibilities considered',type:'text'},
     {id:'ap_plan',label:'Plan item (as decided by the clinician)',type:'text',repeat:true},
     {id:'ap_advice',label:'Advice and counselling given',type:'text'},
     {id:'ap_discussed',label:'Plan discussed with the patient',type:'boolean'},
     {id:'ap_fu_to',label:'Follow-up with',type:'select',options:['Same clinic','Another clinic','Not needed','Not decided']},
     {id:'ap_fu_on',label:'Follow-up on (date)',type:'datetime'}
   ]}
];
// One button per assessment-and-plan set the page library offers now (signed in: only what the server has published; signed out: the demo set).
function renderAP(){
  const box=$('apList');if(!box)return;
  const list=REGISTRY.filter(s=>String(s.id).startsWith(AP_PREFIX));
  if(!list.length){box.innerHTML='<div class="mu">'+(srvMode()?'The assessment and plan set is not published on the server yet. An admin or doctor can send the demo library for review in the Library tab; a reviewer approves it and an admin publishes it.':'The assessment and plan set is not available.')+'</div>';return}
  box.innerHTML=list.map(s=>{
    const on=!!CASE&&isApplied(s.id);
    return `<button class="b sm sec" data-act="applySet" data-arg="${escA(s.id)}"${on?' disabled':''}>${escA(s.title)}${on?' (added)':''}</button> `;
  }).join('');
}
