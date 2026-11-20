const test=require('node:test');
const assert=require('node:assert');
const {validateView}=require('./views.js');

/* Made-up set: ids and options are invented, not taken from any seed set. */
function madeUp(view){
  return {setId:'test.fluids',kind:'care',version:1,sections:[{title:'Rows',fields:[
    {id:'t_when',label:'When',type:'datetime',repeat:true,group:'g'},
    {id:'t_kind',label:'Kind',type:'select',options:['A','B'],repeat:true,group:'g'},
    {id:'t_label',label:'Label',type:'text',repeat:true,group:'g'},
    {id:'t_amt',label:'Amount',type:'number',unit:'mL',repeat:true,group:'g'},
    {id:'t_count',label:'Count',type:'integer',repeat:true,group:'g'},
    {id:'t_flag',label:'Flag',type:'boolean',repeat:true,group:'g'}]}],view:view};
}
const good=()=>({type:'flowsheet',timeField:'t_when',
  summary:[{type:'sumBy',timeField:'t_when',keyField:'t_kind',valueField:'t_amt',windowsHours:[8,12,24],label:'sum of entered rows'}]});
const withSummary=(patch)=>{const v=good();Object.assign(v.summary[0],patch);return madeUp(v);};
const hasErr=(set,re)=>{const r=validateView(set);assert.ok(r.errors.some(e=>re.test(e)),'expected error '+re+' in '+JSON.stringify(r.errors));};

test('passing case shaped like the I/O example',()=>{
  const r=validateView(madeUp(good()));
  assert.deepStrictEqual(r.errors,[]);
});
test('a set with no view block is fine',()=>{
  assert.deepStrictEqual(validateView(madeUp(undefined)).errors,[]);
});
test('unknown view type',()=>hasErr(madeUp({type:'hologram'}),/unknown view type/));
test('unknown view key',()=>hasErr(madeUp({type:'flowsheet',colour:'red'}),/unknown view key "colour"/));
test('unknown summary type',()=>hasErr(withSummary({type:'average'}),/unknown type/));
test('referenced field id missing',()=>hasErr(withSummary({valueField:'nope'}),/"nope".*not in the set/));
test('timeField must be a datetime',()=>hasErr(withSummary({timeField:'t_label'}),/timeField.*datetime/));
test('valueField must be number or integer',()=>hasErr(withSummary({valueField:'t_flag'}),/valueField.*number or integer/));
test('valueField accepts integer',()=>assert.deepStrictEqual(validateView(withSummary({valueField:'t_count'})).errors,[]));
test('keyField must be text or select',()=>hasErr(withSummary({keyField:'t_amt'}),/keyField.*text or select/));
test('windowsHours must be positive integers',()=>{
  hasErr(withSummary({windowsHours:[0]}),/positive integer/);
  hasErr(withSummary({windowsHours:[-4]}),/positive integer/);
  hasErr(withSummary({windowsHours:[1.5]}),/positive integer/);
  hasErr(withSummary({windowsHours:['8']}),/positive integer/);
});
test('windowsHours max 8 entries',()=>hasErr(withSummary({windowsHours:[1,2,3,4,5,6,7,8,9]}),/more than 8/));
test('key named eval or function',()=>{
  hasErr(madeUp({type:'flowsheet',eval:'1+1'}),/"eval" is not allowed/);
  const v=good(); v.summary[0].function='x';
  hasErr(madeUp(v),/"summary\[0\]\.function"|function.*not allowed/);
});
test('keys named threshold, band, dose, limit, target, default',()=>{
  ['threshold','band','dose','limit','target','default'].forEach(k=>{
    const v=good(); v[k]=1;
    hasErr(madeUp(v),new RegExp('"'+k+'" is not allowed'));
  });
});
test('banned key nested inside summary is caught',()=>{
  const v=good(); v.summary[0].limit=5;
  hasErr(madeUp(v),/limit.*not allowed/);
});
test('summary without label gives a warning, not an error',()=>{
  const v=good(); delete v.summary[0].label;
  const r=validateView(madeUp(v));
  assert.deepStrictEqual(r.errors,[]);
  assert.ok(r.warnings.length>0);
});

/* ---- V8c2: view.board (made-up set) ---- */
const withBoard=(b)=>{const v=good();v.board=b;return madeUp(v);};
test('board: {show:latest}, {show:age} and {fields:[...]} pass',()=>{
  assert.deepStrictEqual(validateView(withBoard({show:'latest'})).errors,[]);
  assert.deepStrictEqual(validateView(withBoard({show:'age'})).errors,[]);
  assert.deepStrictEqual(validateView(withBoard({fields:['t_amt','t_kind']})).errors,[]);
  assert.deepStrictEqual(validateView(withBoard({show:'latest',fields:['t_amt']})).errors,[]);
});
test('board: must be an object',()=>{hasErr(withBoard('latest'),/board must be an object/);hasErr(withBoard([]),/board must be an object/);});
test('board: unknown key',()=>hasErr(withBoard({colour:'red'}),/board has unknown key "colour"/));
test('board: show must be in the closed list',()=>hasErr(withBoard({show:'trend'}),/show must be "latest" or "age"/));
test('board: fields must be a non-empty list of text',()=>{
  hasErr(withBoard({fields:'t_amt'}),/fields must be a non-empty list/);
  hasErr(withBoard({fields:[]}),/fields must be a non-empty list/);
  hasErr(withBoard({fields:[5]}),/not text/);});
test('board: fields must be fields of the set',()=>hasErr(withBoard({fields:['t_amt','nope']}),/"nope".*not in the set/));
test('board: a banned key inside it is caught',()=>hasErr(withBoard({show:'latest',limit:3}),/limit.*not allowed/));

/* ---- V2c: validatePathwayViews (made-up pathways; the two examples come from VIEWS.md) ---- */
const {validatePathwayViews}=require('./views.js');
const board=()=>({setId:'pathway.emr.ward_board',kind:'pathway',contexts:['emr'],members:[],rules:[],surface:{type:'patients_columns',columnsFrom:'pinned'}});
const handover=()=>({setId:'pathway.emr.handover',kind:'pathway',contexts:['emr'],members:[],rules:[],
  surface:{type:'case_tab',id:'ho',label:'Handover',print:true},
  sections:[{type:'narrative'},{type:'activePathways'},{type:'latestValues',scope:'applied'},{type:'ackedAlerts',hours:24},{type:'newRows',since:'lastHandover'}]});
const pErr=(p,re,known)=>{const r=validatePathwayViews(p,known);assert.ok(r.errors.some(e=>re.test(e)),'expected '+re+' in '+JSON.stringify(r.errors));};

test('pathway: ward_board example passes',()=>assert.deepStrictEqual(validatePathwayViews(board()).errors,[]));
test('pathway: handover example passes',()=>assert.deepStrictEqual(validatePathwayViews(handover()).errors,[]));
test('pathway: non-emr pathway is ignored',()=>{const p=board();p.contexts=['care'];p.surface={type:'nonsense'};assert.deepStrictEqual(validatePathwayViews(p).errors,[]);});
test('pathway: surface missing',()=>{const p=board();delete p.surface;pErr(p,/surface is required/);});
test('pathway: unknown surface type',()=>{const p=board();p.surface.type='hologram';pErr(p,/unknown surface type/);});
test('pathway: case_tab needs id and label',()=>{const p=handover();delete p.surface.id;delete p.surface.label;pErr(p,/needs an id/);pErr(p,/needs a label/);});
test('pathway: unknown section type',()=>{const p=handover();p.sections.push({type:'chart'});pErr(p,/unknown type "chart"/);});
test('pathway: hours must be a positive integer',()=>{const p=handover();p.sections[3].hours=0;pErr(p,/hours must be a positive integer/);});
test('pathway: windowsHours must be positive integers, max 8',()=>{
  const p=handover();p.sections[3].windowsHours=[1,-2];pErr(p,/windowsHours/);
  p.sections[3].windowsHours=[1,2,3,4,5,6,7,8,9];pErr(p,/windowsHours/);});
test('pathway: rules must be []',()=>{const p=board();p.rules=[{id:'x'}];pErr(p,/rules must be an empty list/);const q=board();delete q.rules;pErr(q,/rules must be an empty list/);});
test('pathway: banned key in surface or sections',()=>{const p=handover();p.sections[3].limit=5;pErr(p,/limit.*not allowed/);});
test('pathway: members must exist when the caller passes the known ids',()=>{
  const p=board();p.members=[{setId:'test.a'},{setId:'test.missing'}];
  pErr(p,/test\.missing/,new Set(['test.a']));
  assert.deepStrictEqual(validatePathwayViews(p,new Set(['test.a','test.missing'])).errors,[]);});

/* ---- V3b: rowsInWindow and fieldsById (made-up set) ---- */
const {rowsInWindow,fieldsById}=require('./views.js');
const T=(s)=>new Date(s).getTime();
test('fieldsById maps every field id of a made-up set',()=>{
  const m=fieldsById(madeUp(undefined));
  assert.deepStrictEqual(Object.keys(m).sort(),['t_amt','t_count','t_flag','t_kind','t_label','t_when']);
  assert.strictEqual(m.t_amt.unit,'mL');
});
test('fieldsById on an empty or odd set gives {}',()=>{
  assert.deepStrictEqual(fieldsById({}),{});
  assert.deepStrictEqual(fieldsById(null),{});
});
test('rowsInWindow: both window edges are included',()=>{
  const rows=[{t_when:'2026-01-01T08:00'},{t_when:'2026-01-01T10:00'},{t_when:'2026-01-01T12:00'},{t_when:'2026-01-01T12:01'},{t_when:'2026-01-01T07:59'}];
  const r=rowsInWindow(rows,'t_when',T('2026-01-01T08:00'),T('2026-01-01T12:00'));
  assert.deepStrictEqual(r.map(x=>x.t_when),['2026-01-01T08:00','2026-01-01T10:00','2026-01-01T12:00']);
});
test('rowsInWindow: entered_in_error rows are skipped',()=>{
  const rows=[{t_when:'2026-01-01T09:00',__status:'entered_in_error'},{t_when:'2026-01-01T09:30',__status:'active'},{t_when:'2026-01-01T09:45'}];
  const r=rowsInWindow(rows,'t_when',T('2026-01-01T00:00'),T('2026-01-02T00:00'));
  assert.strictEqual(r.length,2);
  assert.ok(r.every(x=>x.__status!=='entered_in_error'));
});
test('rowsInWindow: unreadable or missing time is skipped, odd rows ignored',()=>{
  const rows=[{t_when:'not a time'},{t_when:''},{},null,'x',[1],{t_when:'2026-01-01T09:00'}];
  const r=rowsInWindow(rows,'t_when',T('2026-01-01T00:00'),T('2026-01-02T00:00'));
  assert.strictEqual(r.length,1);
  assert.deepStrictEqual(rowsInWindow(null,'t_when',0,1),[]);
});
test('rowsInWindow: returns the original row objects, not copies',()=>{
  const row={t_when:'2026-01-01T09:00'};
  assert.strictEqual(rowsInWindow([row],'t_when',T('2026-01-01T00:00'),T('2026-01-02T00:00'))[0],row);
});

/* ---- V4a: sumBy (made-up set; the ported sum-by-type cases go in sum-by-type.test.js) ---- */
const {sumBy}=require('./views.js');
const SP={timeField:'t_when',keyField:'t_kind',valueField:'t_amt'};
const W=[T('2026-01-01T00:00'),T('2026-01-02T00:00')];
test('sumBy: plain numbers per key',()=>{
  const rows=[{t_when:'2026-01-01T09:00',t_kind:'A',t_amt:'100'},{t_when:'2026-01-01T10:00',t_kind:'A',t_amt:50},{t_when:'2026-01-01T11:00',t_kind:'B',t_amt:'20.5'}];
  assert.deepStrictEqual(sumBy(rows,SP,...W),{A:150,B:20.5});
});
test('sumBy: entered_in_error, bad time, bad value and out-of-window rows are skipped',()=>{
  const rows=[{t_when:'2026-01-01T09:00',t_kind:'A',t_amt:10,__status:'entered_in_error'},{t_when:'x',t_kind:'A',t_amt:10},
    {t_when:'2026-01-01T09:00',t_kind:'A',t_amt:'abc'},{t_when:'2026-01-05T09:00',t_kind:'A',t_amt:10},{t_when:'2026-01-01T09:00',t_kind:'A',t_amt:7}];
  assert.deepStrictEqual(sumBy(rows,SP,...W),{A:7});
});
test('sumBy: blank key goes under (no type); window edges included',()=>{
  const rows=[{t_when:'2026-01-01T00:00',t_kind:'  ',t_amt:3},{t_when:'2026-01-02T00:00',t_amt:4}];
  assert.deepStrictEqual(sumBy(rows,SP,...W),{'(no type)':7});
});
test('sumBy: a different made-up set with other field names',()=>{
  const spec={timeField:'when2',keyField:'what',valueField:'qty'};
  const rows=[{when2:'2026-03-01T01:00',what:'x',qty:2},{when2:'2026-03-01T02:00',what:'y',qty:5},{when2:'2026-03-01T03:00',what:'x',qty:1}];
  assert.deepStrictEqual(sumBy(rows,spec,T('2026-03-01T00:00'),T('2026-03-02T00:00')),{x:3,y:5});
});
test('sumBy: no rows, no spec, or non-list rows give {}',()=>{
  assert.deepStrictEqual(sumBy([],SP,...W),{});
  assert.deepStrictEqual(sumBy(null,SP,...W),{});
  assert.deepStrictEqual(sumBy([{t_amt:1}],null,...W),{});
});

/* ---- V8d: pair, echo, methodField, targetLowField / targetHighField (made-up set) ---- */
const pairSet=(pair,extra)=>{const s=madeUp(undefined);s.sections[0].fields[3].pair=pair;if(extra)s.sections[0].fields.push(extra);return s;};
test('pair: a good pair, in the same group, passes (also with no view block)',()=>{
  assert.deepStrictEqual(validateView(pairSet({with:'t_count',code:'Two numbers',short:'AB'})).errors,[]);
  assert.deepStrictEqual(validateView(pairSet({with:'t_count'})).errors,[]);
});
test('pair: must be an object with known keys',()=>{
  hasErr(pairSet('t_count'),/pair must be an object/);
  hasErr(pairSet({with:'t_count',colour:'x'}),/unknown key "colour"/);
});
test('pair: with is required, not itself, in the set, in the same group',()=>{
  hasErr(pairSet({}),/\.with is required/);
  hasErr(pairSet({with:'t_amt'}),/cannot name the field itself/);
  hasErr(pairSet({with:'nope'}),/"nope".*not in the set/);
  hasErr(pairSet({with:'t_other'},{id:'t_other',label:'O',type:'number',repeat:true,group:'h'}),/not in the same group/);
});
test('pair: code and short must be text',()=>{
  hasErr(pairSet({with:'t_count',code:5}),/code must be text/);
  hasErr(pairSet({with:'t_count',short:''}),/short must be text/);
});
test('methodField, targetLowField, targetHighField must be fields of the set',()=>{
  assert.deepStrictEqual(validateView(madeUp({type:'fever',timeField:'t_when',methodField:'t_label'})).errors,[]);
  hasErr(madeUp({type:'fever',timeField:'t_when',methodField:'nope'}),/"nope".*not in the set/);
  assert.deepStrictEqual(validateView(madeUp({type:'dailygrid',timeField:'t_when',targetLowField:'t_amt',targetHighField:'t_count'})).errors,[]);
  hasErr(madeUp({type:'dailygrid',timeField:'t_when',targetLowField:'nope'}),/"nope".*not in the set/);
});
test('echo: {setId,label} passes; wrong shape, unknown key or missing text is refused',()=>{
  const e=(x)=>madeUp({type:'dailygrid',timeField:'t_when',echo:x});
  assert.deepStrictEqual(validateView(e({setId:'test.other',label:'Other'})).errors,[]);
  hasErr(e('x'),/echo must be an object/);
  hasErr(e({setId:'test.other',label:'O',colour:'x'}),/unknown key "colour"/);
  hasErr(e({setId:'test.other'}),/echo\.label is required/);
  hasErr(e({label:'O'}),/echo\.setId is required/);
});
test('extra: names fields of the set',()=>{
  assert.deepStrictEqual(validateView(madeUp({type:'fever',timeField:'t_when',extra:['t_amt']})).errors,[]);
  hasErr(madeUp({type:'fever',timeField:'t_when',extra:['nope']}),/"nope".*not in the set/);
});
