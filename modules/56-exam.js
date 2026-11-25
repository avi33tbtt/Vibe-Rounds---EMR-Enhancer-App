// R1d: structured examination sets and the examination picker. Classic script: shares the page's global scope.
// Top level is plain values and function declarations only; page functions (applySet, isApplied) are called when used.
/* Examination sets are ordinary element sets recognised by the id prefix `ex_` (no new set kind).
   Data only: one select per finding with the same three answers, then one free-text details field.
   No codes, no doses, no thresholds, no normal ranges, no numbers, no rules, no advice. Measured values stay in the vitals set.
   "Not examined" is an explicit answer so a blank is never read as normal.
   Selects reach the context envelope as plain strings; the text field is withheld from it as narrative (envelope.js).
   Field ids are prefixed per set so two applied sets never share a value. */
const EXAM_PREFIX='ex_';
const EX_ANS=['Not examined','Nothing abnormal found','Abnormal finding'];
const EXAM_SETS=[
  {id:'ex_general',kind:'template',title:'Examination: General',desc:'General examination findings as the examiner records them',
   fields:[
     {id:'exg_appear',label:'General appearance',type:'select',options:EX_ANS},
     {id:'exg_pallor',label:'Pallor',type:'select',options:EX_ANS},
     {id:'exg_icterus',label:'Yellow discolouration of eyes or skin',type:'select',options:EX_ANS},
     {id:'exg_cyan',label:'Bluish discolouration of lips or fingers',type:'select',options:EX_ANS},
     {id:'exg_oedema',label:'Swelling of feet or legs',type:'select',options:EX_ANS},
     {id:'exg_nodes',label:'Lymph glands',type:'select',options:EX_ANS},
     {id:'exg_hydr',label:'Hydration',type:'select',options:EX_ANS},
     {id:'exg_details',label:'Details in the examiner\'s words',type:'text'}
   ]},
  {id:'ex_cvs',kind:'template',title:'Examination: Heart and circulation',desc:'Heart and circulation findings as the examiner records them',
   fields:[
     {id:'exc_pulse',label:'Pulse rhythm and character',type:'select',options:EX_ANS},
     {id:'exc_neck',label:'Neck veins',type:'select',options:EX_ANS},
     {id:'exc_sounds',label:'Heart sounds',type:'select',options:EX_ANS},
     {id:'exc_murmur',label:'Murmur',type:'select',options:EX_ANS},
     {id:'exc_periph',label:'Pulses in the arms and legs',type:'select',options:EX_ANS},
     {id:'exc_details',label:'Details in the examiner\'s words',type:'text'}
   ]},
  {id:'ex_resp',kind:'template',title:'Examination: Chest and breathing',desc:'Chest findings as the examiner records them',
   fields:[
     {id:'exr_shape',label:'Chest shape and movement',type:'select',options:EX_ANS},
     {id:'exr_effort',label:'Effort of breathing',type:'select',options:EX_ANS},
     {id:'exr_percuss',label:'Percussion note',type:'select',options:EX_ANS},
     {id:'exr_breath',label:'Breath sounds',type:'select',options:EX_ANS},
     {id:'exr_added',label:'Added sounds',type:'select',options:EX_ANS},
     {id:'exr_details',label:'Details in the examiner\'s words',type:'text'}
   ]},
  {id:'ex_abdomen',kind:'template',title:'Examination: Abdomen',desc:'Abdominal findings as the examiner records them',
   fields:[
     {id:'exa_shape',label:'Shape and distension',type:'select',options:EX_ANS},
     {id:'exa_tender',label:'Tenderness',type:'select',options:EX_ANS},
     {id:'exa_organs',label:'Liver and spleen',type:'select',options:EX_ANS},
     {id:'exa_mass',label:'Lump or mass',type:'select',options:EX_ANS},
     {id:'exa_bowel',label:'Bowel sounds',type:'select',options:EX_ANS},
     {id:'exa_details',label:'Details in the examiner\'s words',type:'text'}
   ]},
  {id:'ex_neuro',kind:'template',title:'Examination: Nervous system',desc:'Nervous system findings as the examiner records them',
   fields:[
     {id:'exn_alert',label:'Level of alertness',type:'select',options:EX_ANS},
     {id:'exn_orient',label:'Orientation',type:'select',options:EX_ANS},
     {id:'exn_speech',label:'Speech',type:'select',options:EX_ANS},
     {id:'exn_cranial',label:'Cranial nerves',type:'select',options:EX_ANS},
     {id:'exn_power',label:'Muscle power',type:'select',options:EX_ANS},
     {id:'exn_tone',label:'Muscle tone',type:'select',options:EX_ANS},
     {id:'exn_sens',label:'Sensation',type:'select',options:EX_ANS},
     {id:'exn_reflex',label:'Reflexes',type:'select',options:EX_ANS},
     {id:'exn_gait',label:'Gait',type:'select',options:EX_ANS},
     {id:'exn_details',label:'Details in the examiner\'s words',type:'text'}
   ]}
];
// One button per examination set the page library offers now (signed in: only what the server has published; signed out: the demo sets).
function renderExam(){
  const box=$('exList');if(!box)return;
  const list=REGISTRY.filter(s=>String(s.id).startsWith(EXAM_PREFIX));
  if(!list.length){box.innerHTML='<div class="mu">'+(srvMode()?'No examination sets are published on the server yet. An admin or doctor can send the demo library for review in the Library tab; a reviewer approves it and an admin publishes it.':'No examination sets are available.')+'</div>';return}
  box.innerHTML=list.map(s=>{
    const on=!!CASE&&isApplied(s.id);
    return `<button class="b sm sec" data-act="applySet" data-arg="${escA(s.id)}"${on?' disabled':''}>${escA(s.title.replace(/^Examination:\s*/,''))}${on?' (added)':''}</button> `;
  }).join('');
}
