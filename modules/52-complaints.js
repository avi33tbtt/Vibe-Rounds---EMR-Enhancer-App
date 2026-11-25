// R1a: OPD complaint sets and the complaint picker. Classic script: shares the page's global scope.
// Top level is plain values and function declarations only; page functions (applySet, isApplied) are called when used.
/* Complaint sets are ordinary element sets recognised by the id prefix `cc_` (no new set kind).
   Data only: neutral history questions. No terminology codes, no doses, no thresholds, no rules, no advice.
   R1b: each set starts with six attribute fields (onset, started on, duration amount and unit, course, severity in the patient's words). Field ids are prefixed per set so they never clash with another built-in set.
   The page adds these to BUILTIN; the library module offers them in the demo import. */
const COMPLAINT_PREFIX='cc_';
const CC={q:''};
const COMPLAINT_SETS=[
  {id:'cc_fever',kind:'template',title:'Complaint: Fever',desc:'History questions for a patient who came with fever',
   fields:[
     {id:'fev_onset',label:'Onset as described',type:'select',options:['Sudden','Gradual','Not sure']},
     {id:'fev_start',label:'Started on (best estimate)',type:'datetime'},
     {id:'fev_dur',label:'How long it has been present (amount)',type:'number'},
     {id:'fev_dur_u',label:'How long it has been present (unit of time)',type:'select',options:['Hours','Days','Weeks','Months','Years']},
     {id:'fev_course',label:'Course since it started',type:'select',options:['Getting better','Staying the same','Getting worse','Comes and goes','Not sure']},
     {id:'fev_sev',label:"Severity in the patient's own words",type:'select',options:['Mild','Moderate','Severe','Not stated']},
     {id:'fev_pattern',label:'Pattern of fever as described',type:'select',options:['Continuous','Comes and goes','Not sure']},
     {id:'fev_chills',label:'Chills or shivering reported',type:'boolean'},
     {id:'fev_sweats',label:'Sweating reported',type:'boolean'},
     {id:'fev_rash',label:'Rash noticed',type:'boolean'},
     {id:'fev_contact',label:'Contact with someone who was unwell',type:'boolean'},
     {id:'fev_travel',label:'Recent travel or exposure (where and what)',type:'text'},
     {id:'fev_taken',label:'What the patient has already taken, as reported',type:'text'}
   ]},
  {id:'cc_cough',kind:'template',title:'Complaint: Cough or breathing difficulty',desc:'History questions for cough or breathlessness',
   fields:[
     {id:'cgh_onset',label:'Onset as described',type:'select',options:['Sudden','Gradual','Not sure']},
     {id:'cgh_start',label:'Started on (best estimate)',type:'datetime'},
     {id:'cgh_dur',label:'How long it has been present (amount)',type:'number'},
     {id:'cgh_dur_u',label:'How long it has been present (unit of time)',type:'select',options:['Hours','Days','Weeks','Months','Years']},
     {id:'cgh_course',label:'Course since it started',type:'select',options:['Getting better','Staying the same','Getting worse','Comes and goes','Not sure']},
     {id:'cgh_sev',label:"Severity in the patient's own words",type:'select',options:['Mild','Moderate','Severe','Not stated']},
     {id:'cgh_type',label:'Type of cough',type:'select',options:['Dry','With sputum','No cough','Not sure']},
     {id:'cgh_blood',label:'Blood in the sputum reported',type:'boolean'},
     {id:'cgh_wheeze',label:'Wheeze or noisy breathing reported',type:'boolean'},
     {id:'cgh_rest',label:'Breathless while resting',type:'boolean'},
     {id:'cgh_contact',label:'Contact with a person who has a long-lasting cough',type:'boolean'},
     {id:'cgh_smoke',label:'Tobacco or smoke exposure (what and how long)',type:'text'}
   ]},
  {id:'cc_abdo',kind:'template',title:'Complaint: Abdominal pain',desc:'History questions for pain in the abdomen',
   fields:[
     {id:'abd_onset',label:'Onset as described',type:'select',options:['Sudden','Gradual','Not sure']},
     {id:'abd_start',label:'Started on (best estimate)',type:'datetime'},
     {id:'abd_dur',label:'How long it has been present (amount)',type:'number'},
     {id:'abd_dur_u',label:'How long it has been present (unit of time)',type:'select',options:['Hours','Days','Weeks','Months','Years']},
     {id:'abd_course',label:'Course since it started',type:'select',options:['Getting better','Staying the same','Getting worse','Comes and goes','Not sure']},
     {id:'abd_sev',label:"Severity in the patient's own words",type:'select',options:['Mild','Moderate','Severe','Not stated']},
     {id:'abd_site',label:'Where the pain is felt',type:'select',options:['Upper abdomen','Lower abdomen','Left side','Right side','Around the navel','All over']},
     {id:'abd_vomit',label:'Vomiting reported',type:'boolean'},
     {id:'abd_bowel',label:'Bowel habit',type:'select',options:['No change','Loose stools','Constipation','Not asked']},
     {id:'abd_urine',label:'Urinary symptoms reported',type:'boolean'},
     {id:'abd_food',label:'Relation to food, as described',type:'text'},
     {id:'abd_surg',label:'Previous abdominal surgery',type:'text'}
   ]},
  {id:'cc_headache',kind:'template',title:'Complaint: Headache',desc:'History questions for headache',
   fields:[
     {id:'hdc_onset',label:'Onset as described',type:'select',options:['Sudden','Gradual','Not sure']},
     {id:'hdc_start',label:'Started on (best estimate)',type:'datetime'},
     {id:'hdc_dur',label:'How long it has been present (amount)',type:'number'},
     {id:'hdc_dur_u',label:'How long it has been present (unit of time)',type:'select',options:['Hours','Days','Weeks','Months','Years']},
     {id:'hdc_course',label:'Course since it started',type:'select',options:['Getting better','Staying the same','Getting worse','Comes and goes','Not sure']},
     {id:'hdc_sev',label:"Severity in the patient's own words",type:'select',options:['Mild','Moderate','Severe','Not stated']},
     {id:'hdc_site',label:'Where the headache is felt',type:'select',options:['One side','Both sides','Front','Back','All over']},
     {id:'hdc_vision',label:'Change in vision reported',type:'boolean'},
     {id:'hdc_vomit',label:'Vomiting reported',type:'boolean'},
     {id:'hdc_injury',label:'Recent head injury',type:'boolean'},
     {id:'hdc_before',label:'Similar headaches before',type:'boolean'},
     {id:'hdc_triggers',label:'What brings it on or eases it, as described',type:'text'}
   ]},
  {id:'cc_chest',kind:'template',title:'Complaint: Chest pain',desc:'History questions for chest pain',
   fields:[
     {id:'cpn_onset',label:'Onset as described',type:'select',options:['Sudden','Gradual','Not sure']},
     {id:'cpn_start',label:'Started on (best estimate)',type:'datetime'},
     {id:'cpn_dur',label:'How long it has been present (amount)',type:'number'},
     {id:'cpn_dur_u',label:'How long it has been present (unit of time)',type:'select',options:['Hours','Days','Weeks','Months','Years']},
     {id:'cpn_course',label:'Course since it started',type:'select',options:['Getting better','Staying the same','Getting worse','Comes and goes','Not sure']},
     {id:'cpn_sev',label:"Severity in the patient's own words",type:'select',options:['Mild','Moderate','Severe','Not stated']},
     {id:'cpn_site',label:'Where the pain is felt',type:'select',options:['Centre','Left','Right','Not localised']},
     {id:'cpn_exert',label:'Comes on with effort',type:'boolean'},
     {id:'cpn_spread',label:'Spreads to another part of the body (where)',type:'text'},
     {id:'cpn_sweat',label:'Sweating with the pain reported',type:'boolean'},
     {id:'cpn_breath',label:'Breathlessness with the pain reported',type:'boolean'},
     {id:'cpn_prev',label:'Previous heart or lung illness',type:'text'}
   ]},
  {id:'cc_joint',kind:'template',title:'Complaint: Back or joint pain',desc:'History questions for back or joint pain',
   fields:[
     {id:'jnt_onset',label:'Onset as described',type:'select',options:['Sudden','Gradual','Not sure']},
     {id:'jnt_start',label:'Started on (best estimate)',type:'datetime'},
     {id:'jnt_dur',label:'How long it has been present (amount)',type:'number'},
     {id:'jnt_dur_u',label:'How long it has been present (unit of time)',type:'select',options:['Hours','Days','Weeks','Months','Years']},
     {id:'jnt_course',label:'Course since it started',type:'select',options:['Getting better','Staying the same','Getting worse','Comes and goes','Not sure']},
     {id:'jnt_sev',label:"Severity in the patient's own words",type:'select',options:['Mild','Moderate','Severe','Not stated']},
     {id:'jnt_site',label:'Which joint or part of the back',type:'text'},
     {id:'jnt_swelling',label:'Swelling reported',type:'boolean'},
     {id:'jnt_injury',label:'Injury before it started',type:'boolean'},
     {id:'jnt_morning',label:'Stiffness in the morning reported',type:'boolean'},
     {id:'jnt_numb',label:'Numbness or weakness reported',type:'boolean'},
     {id:'jnt_daily',label:'Effect on daily activities, as described',type:'text'}
   ]}
];
// The complaint sets the picker can offer now: signed in, only what the server has published (the page library); signed out, the demo sets.
function ccSets(){
  const q=CC.q.trim().toLowerCase();
  return REGISTRY.filter(s=>String(s.id).startsWith(COMPLAINT_PREFIX)&&(!q||String(s.title).toLowerCase().includes(q)||String(s.desc||'').toLowerCase().includes(q)));
}
function renderComplaints(){
  const box=$('ccList');if(!box)return;
  const all=REGISTRY.filter(s=>String(s.id).startsWith(COMPLAINT_PREFIX)),list=ccSets();
  if(!all.length){box.innerHTML='<div class="mu">'+(srvMode()?'No complaint sets are published on the server yet. An admin or doctor can send the demo library for review in the Library tab; a reviewer approves it and an admin publishes it.':'No complaint sets are in the library.')+'</div>';return}
  if(!list.length){box.innerHTML='<div class="mu">No complaint matches this search.</div>';return}
  box.innerHTML=list.map(s=>{
    const on=!!CASE&&isApplied(s.id);
    return `<button class="b sm sec" data-act="applySet" data-arg="${escA(s.id)}"${on?' disabled':''}>${escA(s.title.replace(/^Complaint:\s*/,''))}${on?' (added)':''}</button> `;
  }).join('');
}
