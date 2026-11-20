const test=require('node:test'), assert=require('node:assert');
const {projectCase}=require('./elements.js');
const SET={setId:'x.demo',version:3,sections:[{fields:[
  {id:'amt',type:'number',unit:'mL',fhir:{resource:'Observation'}},
  {id:'level',type:'number',unitField:'lvl_unit',fhir:{resource:'Observation'}},
  {id:'lvl_unit',type:'select',meta:true},
  {id:'note',type:'text',fhir:{resource:'Observation'}},
  {id:'loose',type:'number',unit:'kg'}]}]};
const base={patientId:'p1',encounterId:'e1',caseId:'c1',sets:[SET],bindings:[]};
const row=(o)=>Object.assign({id:'r1',set_id:'x.demo',row_time:'2026-01-01T08:00:00Z',status:'active',row:{}},o);

test('entered_in_error row is skipped',()=>{
  assert.deepStrictEqual(projectCase({...base,rows:[row({status:'entered_in_error',row:{amt:5}})]}),[]);
});
test('null row_time is kept as null',()=>{
  const r=projectCase({...base,rows:[row({row_time:null,row:{amt:5}})]});
  assert.strictEqual(r.length,1); assert.strictEqual(r[0].time,null);
});
test('field with no fhir block is absent; empty values absent',()=>{
  const r=projectCase({...base,rows:[row({row:{loose:9,amt:'',note:'  '}})]});
  assert.deepStrictEqual(r,[]);
});
test('codings come only from bindings (empty list when none)',()=>{
  const none=projectCase({...base,rows:[row({row:{amt:5}})]})[0];
  assert.deepStrictEqual(none.codings,[]); assert.ok(!('system' in none)&&!('code' in none));
  const b=[{set_id:'x.demo',field_id:'amt',system:'lsys',code:'A1'}];
  const got=projectCase({...base,bindings:b,rows:[row({row:{amt:5}})]})[0];
  assert.deepStrictEqual(got.codings,[{system:'lsys',code:'A1'}]);
});
test('two systems on one field give two codings, in order, no repeats; other fields are unaffected',()=>{
  const b=[{set_id:'x.demo',field_id:'amt',system:'sysa',code:'1'},{set_id:'x.demo',field_id:'amt',system:'sysb',code:'2'},
    {set_id:'x.demo',field_id:'amt',system:'sysa',code:'1'},{set_id:'x.demo',field_id:'note',system:'sysa',code:'9'}];
  const r=projectCase({...base,bindings:b,rows:[row({row:{amt:5,note:'n'}})]});
  assert.deepStrictEqual(r.find(x=>x.source.fieldId==='amt').codings,[{system:'sysa',code:'1'},{system:'sysb',code:'2'}]);
  assert.deepStrictEqual(r.find(x=>x.source.fieldId==='note').codings,[{system:'sysa',code:'9'}]);
});
test('a system the field does not allow is absent; none allows no code; local needs localSystems; no coding block keeps all',()=>{
  const mk=(allow)=>({setId:'x.c',version:1,sections:[{fields:[{id:'v',type:'number',unit:'mL',fhir:{resource:'Observation'},coding:{allow}}]}]});
  const b=[{set_id:'x.c',field_id:'v',system:'sysa',code:'1'},{set_id:'x.c',field_id:'v',system:'sysb',code:'2'},{set_id:'x.c',field_id:'v',system:'mine',code:'3'}];
  const run=(set,extra)=>projectCase({...base,sets:[set],bindings:b,...extra,rows:[row({set_id:'x.c',row:{v:1}})]})[0].codings.map(c=>c.system);
  assert.deepStrictEqual(run(mk(['sysa'])),['sysa']);
  assert.deepStrictEqual(run(mk(['none'])),[]);
  assert.deepStrictEqual(run(mk(['local'])),[]);
  assert.deepStrictEqual(run(mk(['local']),{localSystems:['mine']}),['mine']);
  assert.deepStrictEqual(run(mk(['sysa','local']),{localSystems:['mine']}),['sysa','mine']);
  const legacy=mk(['x']); delete legacy.sections[0].fields[0].coding;
  assert.deepStrictEqual(run(legacy),['sysa','sysb','mine']);
});
test('comma value stays text; plain digits become number; no conversion',()=>{
  const r=projectCase({...base,rows:[row({row:{amt:'2,5'}}),row({id:'r2',row:{amt:'250'}})]});
  assert.strictEqual(r[0].valueText,'2,5'); assert.strictEqual(r[0].valueNumber,null);
  assert.strictEqual(r[1].valueNumber,250); assert.strictEqual(r[1].unit,'mL');
});
test('per-row unit comes from that row; source and ids carried',()=>{
  const r=projectCase({...base,rows:[row({row:{level:4,lvl_unit:'mmol/L'}}),row({id:'r2',row:{level:4}})]});
  assert.strictEqual(r[0].unit,'mmol/L'); assert.strictEqual(r[1].unit,'-');
  assert.deepStrictEqual(r[0].source,{setId:'x.demo',setVersion:3,fieldId:'level'});
  assert.strictEqual(r[0].patientId,'p1'); assert.strictEqual(r[0].rowId,'r1');
});
