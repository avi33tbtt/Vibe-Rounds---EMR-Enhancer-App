/* views.js : pure view-data helpers for EMR Enhancer (browser + Node).
   No DOM, no set ids. validateView(set) checks a set's optional "view" block. See VIEWS.md. */
(function(root){
var VIEW_TYPES=['flowsheet','fever','dailygrid'];
var VIEW_KEYS=['type','timeField','tempField','unitField','thresholdField','thresholdUnitField','extra',
  'methodField','targetLowField','targetHighField','echo','slotField','glucoseField','doseField','byField','slots',
  'summary','board','banner','statusboard','actions','crosscheck','drives'];
var SUMMARY_TYPES=['sumBy'];
var SUMMARY_KEYS=['type','timeField','keyField','valueField','windowsHours','label'];
var BOARD_SHOW=['latest','age'];
var BOARD_KEYS=['show','fields'];
var ECHO_KEYS=['setId','label'];
var BANNED=['eval','function','threshold','band','dose','limit','target','default'];

function collectFields(set){
  var out={};
  ((set&&set.sections)||[]).forEach(function(s){
    ((s&&s.fields)||[]).forEach(function(f){ if(f&&f.id) out[f.id]=f; });
  });
  return out;
}

function walkBanned(node,path,errors){
  if(!node||typeof node!=='object') return;
  if(Array.isArray(node)){ node.forEach(function(n,i){walkBanned(n,path+'['+i+']',errors);}); return; }
  Object.keys(node).forEach(function(k){
    if(BANNED.indexOf(String(k).toLowerCase())>=0) errors.push('view key "'+path+k+'" is not allowed (view data holds ids, labels and windows only)');
    walkBanned(node[k],path+k+'.',errors);
  });
}

function walkFieldRefs(node,path,fields,errors){
  if(!node||typeof node!=='object') return;
  if(Array.isArray(node)){ node.forEach(function(n,i){walkFieldRefs(n,path+'['+i+']',fields,errors);}); return; }
  Object.keys(node).forEach(function(k){
    var v=node[k];
    if(/Field$/.test(k)&&typeof v==='string'&&!fields[v]) errors.push('view.'+path+k+' refers to field "'+v+'" which is not in the set');
    if(k==='extra'&&Array.isArray(v)) v.forEach(function(id){ if(!fields[id]) errors.push('view.'+path+'extra refers to field "'+id+'" which is not in the set'); });
    if(v&&typeof v==='object') walkFieldRefs(v,path+k+'.',fields,errors);
  });
}

function validateSummary(entry,i,fields,errors,warnings){
  var p='view.summary['+i+']';
  if(!entry||typeof entry!=='object'||Array.isArray(entry)){ errors.push(p+' must be an object'); return; }
  if(SUMMARY_TYPES.indexOf(entry.type)<0) errors.push(p+' has unknown type "'+entry.type+'"');
  Object.keys(entry).forEach(function(k){ if(SUMMARY_KEYS.indexOf(k)<0) errors.push(p+' has unknown key "'+k+'"'); });
  function need(key,okTypes,what){
    var id=entry[key];
    if(typeof id!=='string'||!id){ errors.push(p+'.'+key+' is required'); return; }
    var f=fields[id];
    if(!f){ return; } /* missing id is reported by the field-reference check */
    if(okTypes.indexOf(f.type)<0) errors.push(p+'.'+key+' field "'+id+'" must be '+what+', not '+f.type);
  }
  need('timeField',['datetime'],'a datetime');
  need('valueField',['number','integer'],'number or integer');
  need('keyField',['text','select'],'text or select');
  var w=entry.windowsHours;
  if(!Array.isArray(w)||!w.length) errors.push(p+'.windowsHours must be a non-empty list');
  else {
    if(w.length>8) errors.push(p+'.windowsHours has more than 8 entries');
    w.forEach(function(h){ if(typeof h!=='number'||!isFinite(h)||h<=0||Math.floor(h)!==h) errors.push(p+'.windowsHours entry "'+h+'" must be a positive integer'); });
  }
  if(entry.label===undefined) warnings.push(p+' has no label');
  else if(typeof entry.label!=='string') errors.push(p+'.label must be text');
}

/* V8c2: view.board = {show:'latest'|'age', fields?:[field ids of the set]}. Display only; fields limits which values a ward-board cell shows. */
function validateBoard(b,fields,errors){
  var p='view.board';
  if(!b||typeof b!=='object'||Array.isArray(b)){ errors.push(p+' must be an object'); return; }
  Object.keys(b).forEach(function(k){ if(BOARD_KEYS.indexOf(k)<0) errors.push(p+' has unknown key "'+k+'"'); });
  if(b.show!==undefined&&BOARD_SHOW.indexOf(b.show)<0) errors.push(p+'.show must be "latest" or "age", not "'+b.show+'"');
  if(b.fields!==undefined){
    if(!Array.isArray(b.fields)||!b.fields.length) errors.push(p+'.fields must be a non-empty list of field ids');
    else b.fields.forEach(function(id){
      if(typeof id!=='string'||!id) errors.push(p+'.fields has an entry that is not text');
      else if(!fields[id]) errors.push(p+'.fields refers to field "'+id+'" which is not in the set');
    });
  }
}

/* V8d3: field.pair = {with, code, short}: this field and the field it names are one paired reading (for example two numbers shown as "a / b").
   Both fields must be in the same group of the set. code and short are text. Display and export only. */
var PAIR_KEYS=['with','code','short'];
function validatePairs(set,errors){
  var fs=[];
  ((set&&set.sections)||[]).forEach(function(s){ ((s&&s.fields)||[]).forEach(function(f){ if(f&&f.id) fs.push(f); }); });
  fs.forEach(function(f){
    if(f.pair===undefined) return;
    var p='field "'+f.id+'" pair', q=f.pair;
    if(!q||typeof q!=='object'||Array.isArray(q)){ errors.push(p+' must be an object'); return; }
    Object.keys(q).forEach(function(k){ if(PAIR_KEYS.indexOf(k)<0) errors.push(p+' has unknown key "'+k+'"'); });
    ['code','short'].forEach(function(k){ if(q[k]!==undefined&&(typeof q[k]!=='string'||!q[k])) errors.push(p+'.'+k+' must be text'); });
    var o=fs.filter(function(x){ return x.id===q.with; })[0];
    if(typeof q.with!=='string'||!q.with) errors.push(p+'.with is required');
    else if(q.with===f.id) errors.push(p+'.with cannot name the field itself');
    else if(!o) errors.push(p+'.with refers to field "'+q.with+'" which is not in the set');
    else if((o.group||o.id)!==(f.group||f.id)) errors.push(p+'.with field "'+q.with+'" is not in the same group');
  });
}

/* V8d7: field.followUp = {label, history?:{group,valueField,dateField}}: this date field is the "next due" date of a follow-up, and label is its short name
   in the due badge and due list. history names the repeat group (its date field and its number field) used for "days since last reading". Display only. */
var FOLLOWUP_KEYS=['label','history'];
var HISTORY_KEYS=['group','valueField','dateField'];
function validateFollowUps(set,errors){
  var fs=[];
  ((set&&set.sections)||[]).forEach(function(s){ ((s&&s.fields)||[]).forEach(function(f){ if(f&&f.id) fs.push(f); }); });
  var flagged=fs.filter(function(f){ return f.followUp!==undefined; });
  if(flagged.length>1) errors.push('only one field of a set may carry followUp');
  flagged.forEach(function(f){
    var p='field "'+f.id+'" followUp', q=f.followUp;
    if(!q||typeof q!=='object'||Array.isArray(q)){ errors.push(p+' must be an object'); return; }
    Object.keys(q).forEach(function(k){ if(FOLLOWUP_KEYS.indexOf(k)<0) errors.push(p+' has unknown key "'+k+'"'); });
    if(f.type!=='date') errors.push(p+' must be on a date field');
    if(f.repeat) errors.push(p+' cannot be on a repeat field');
    if(q.label!==undefined&&(typeof q.label!=='string'||!q.label)) errors.push(p+'.label must be text');
    var h=q.history; if(h===undefined) return;
    if(!h||typeof h!=='object'||Array.isArray(h)){ errors.push(p+'.history must be an object'); return; }
    Object.keys(h).forEach(function(k){ if(HISTORY_KEYS.indexOf(k)<0) errors.push(p+'.history has unknown key "'+k+'"'); });
    HISTORY_KEYS.forEach(function(k){ if(typeof h[k]!=='string'||!h[k]) errors.push(p+'.history.'+k+' is required text'); });
    if(typeof h.group!=='string'||!h.group) return;
    var inG=function(id){ return fs.filter(function(x){ return x.id===id&&(x.group||x.id)===h.group; })[0]; };
    var vf=inG(h.valueField), df=inG(h.dateField);
    if(typeof h.valueField==='string'&&h.valueField){ if(!vf) errors.push(p+'.history.valueField "'+h.valueField+'" is not in group "'+h.group+'"'); else if(['number','integer'].indexOf(vf.type)<0) errors.push(p+'.history.valueField must be a number or integer field'); }
    if(typeof h.dateField==='string'&&h.dateField){ if(!df) errors.push(p+'.history.dateField "'+h.dateField+'" is not in group "'+h.group+'"'); else if(['date','datetime'].indexOf(df.type)<0) errors.push(p+'.history.dateField must be a date or datetime field'); }
  });
}

function validateView(set){
  var errors=[],warnings=[];
  validatePairs(set,errors);
  validateFollowUps(set,errors);
  var v=set&&set.view;
  if(v===undefined||v===null) return {errors:errors,warnings:warnings};
  if(typeof v!=='object'||Array.isArray(v)){ errors.push('view must be an object'); return {errors:errors,warnings:warnings}; }
  var fields=collectFields(set);
  if(v.type===undefined) warnings.push('view has no type');
  else if(VIEW_TYPES.indexOf(v.type)<0) errors.push('unknown view type "'+v.type+'"');
  Object.keys(v).forEach(function(k){ if(VIEW_KEYS.indexOf(k)<0) errors.push('unknown view key "'+k+'"'); });
  walkBanned(v,'',errors);
  walkFieldRefs(v,'',fields,errors);
  if(v.summary!==undefined){
    if(!Array.isArray(v.summary)) errors.push('view.summary must be a list');
    else v.summary.forEach(function(e,i){ validateSummary(e,i,fields,errors,warnings); });
  }
  if(v.board!==undefined) validateBoard(v.board,fields,errors);
  /* V8d5: view.echo = {setId, label}: a note that points to the card of another set. Text only. */
  if(v.echo!==undefined){
    var e=v.echo;
    if(!e||typeof e!=='object'||Array.isArray(e)) errors.push('view.echo must be an object');
    else {
      Object.keys(e).forEach(function(k){ if(ECHO_KEYS.indexOf(k)<0) errors.push('view.echo has unknown key "'+k+'"'); });
      ECHO_KEYS.forEach(function(k){ if(typeof e[k]!=='string'||!e[k]) errors.push('view.echo.'+k+' is required text'); });
    }
  }
  return {errors:errors,warnings:warnings};
}

var SURFACE_TYPES=['case_tab','patients_columns','patients_panel','banner_chips','export_section'];
var SECTION_TYPES=['narrative','activePathways','latestValues','ackedAlerts','newRows','setTable','statusboard','linkedgrid'];
function posInt(n){ return typeof n==='number'&&isFinite(n)&&n>0&&Math.floor(n)===n; }

/* Pathways whose contexts include "emr". knownSetIds (optional array or Set) lets the caller check that members exist. */
function validatePathwayViews(p,knownSetIds){
  var errors=[],warnings=[];
  if(!p||!Array.isArray(p.contexts)||p.contexts.indexOf('emr')<0) return {errors:errors,warnings:warnings};
  var s=p.surface;
  if(!s||typeof s!=='object'||Array.isArray(s)) errors.push('surface is required');
  else {
    if(SURFACE_TYPES.indexOf(s.type)<0) errors.push('unknown surface type "'+s.type+'"');
    if(s.type==='case_tab'){
      if(typeof s.id!=='string'||!s.id) errors.push('case_tab surface needs an id');
      if(typeof s.label!=='string'||!s.label) errors.push('case_tab surface needs a label');
    }
  }
  if(p.sections!==undefined){
    if(!Array.isArray(p.sections)) errors.push('sections must be a list');
    else p.sections.forEach(function(sec,i){
      var q='sections['+i+']';
      if(!sec||typeof sec!=='object'||Array.isArray(sec)){ errors.push(q+' must be an object'); return; }
      if(SECTION_TYPES.indexOf(sec.type)<0) errors.push(q+' has unknown type "'+sec.type+'"');
      if(sec.hours!==undefined&&!posInt(sec.hours)) errors.push(q+'.hours must be a positive integer');
      if(sec.windowsHours!==undefined){
        if(!Array.isArray(sec.windowsHours)||sec.windowsHours.length>8||!sec.windowsHours.every(posInt)) errors.push(q+'.windowsHours must be up to 8 positive integers');
      }
    });
  }
  if(!Array.isArray(p.rules)||p.rules.length!==0) errors.push('rules must be an empty list');
  walkBanned(p.surface,'surface.',errors);
  walkBanned(p.sections,'sections.',errors);
  if(knownSetIds){
    var has=function(id){ return knownSetIds.has?knownSetIds.has(id):knownSetIds.indexOf(id)>=0; };
    (Array.isArray(p.members)?p.members:[]).forEach(function(m){
      var id=typeof m==='string'?m:(m&&m.setId);
      if(!id||!has(id)) errors.push('member "'+id+'" is not an existing set');
    });
  }
  return {errors:errors,warnings:warnings};
}

/* V3b: pure helpers. Same reading of a row as enhancer.html: time = new Date(row[timeField]).getTime(), entered_in_error rows are skipped. */
function fieldsById(set){ return collectFields(set); }

/* Rows whose time is readable and within [fromMs, toMs] (both edges included). Returns the original row objects. */
function rowsInWindow(rows,timeField,fromMs,toMs){
  var out=[];
  (Array.isArray(rows)?rows:[]).forEach(function(r){
    if(!r||typeof r!=='object'||Array.isArray(r)||r.__status==='entered_in_error') return;
    var t=new Date(r[timeField]).getTime();
    if(isNaN(t)||t<fromMs||t>toMs) return;
    out.push(r);
  });
  return out;
}

/* V4a: plain sum per key inside a window. Same behaviour as the old sumByType: plain numbers per key,
   entered_in_error rows skipped, unreadable time or value skipped, blank key becomes '(no type)'.
   spec = {timeField, keyField, valueField}. Never compared to anything. */
function fnum(x){ return x===''||x==null||isNaN(parseFloat(x))?null:parseFloat(x); }
function sumBy(rows,spec,fromMs,toMs){
  var o={};
  if(!spec) return o;
  rowsInWindow(rows,spec.timeField,fromMs,toMs).forEach(function(r){
    var x=fnum(r[spec.valueField]);
    if(x==null) return;
    var k=String(r[spec.keyField]||'').trim()||'(no type)';
    o[k]=(o[k]||0)+x;
  });
  return o;
}

/* P2a: coding choices on a field (see CODING.md). field.coding = {allow:[code system ids, 'local' or 'none']}.
   No coding block means {allow:['none']}. Any mix is allowed. The software never fills a code in, so keys named default or auto are refused.
   knownSystems: list (or Set) of code_systems ids, or of objects with an id. Returns {errors}. */
var CODING_KEYS=['allow'], CODING_BANNED=['default','auto'];
function codingAllow(field){
  var c=field&&field.coding;
  return c&&Array.isArray(c.allow)?c.allow.slice():['none'];
}
function isLegacyCoding(c){ return !!c&&typeof c==='object'&&!Array.isArray(c)&&c.allow===undefined&&(c.code!==undefined||c.system!==undefined); }
function walkCoding(node,path,errors){
  if(!node||typeof node!=='object') return;
  if(Array.isArray(node)){ node.forEach(function(n,i){walkCoding(n,path+'['+i+']',errors);}); return; }
  Object.keys(node).forEach(function(k){
    if(CODING_BANNED.indexOf(String(k).toLowerCase())>=0) errors.push('coding key "'+path+k+'" is not allowed (a code is never filled in by the software)');
    walkCoding(node[k],path+k+'.',errors);
  });
}
function validateCoding(field,knownSystems){
  var errors=[];
  if(!field||typeof field!=='object'||field.coding===undefined||field.coding===null) return {errors:errors};
  var who='field "'+(field.id||'?')+'" ';
  var c=field.coding;
  if(isLegacyCoding(c)) return {errors:errors};   /* the client attaches {system,code,display} to a field in memory; that is a bound code, not a choice block */
  if(typeof c!=='object'||Array.isArray(c)){ errors.push(who+'coding must be an object'); return {errors:errors}; }
  walkCoding(c,'coding.',errors);
  Object.keys(c).forEach(function(k){
    if(CODING_KEYS.indexOf(k)<0&&CODING_BANNED.indexOf(k.toLowerCase())<0) errors.push(who+'coding has unknown key "'+k+'"');
  });
  var known={};
  if(knownSystems&&typeof knownSystems.forEach==='function') knownSystems.forEach(function(x){ var id=typeof x==='string'?x:(x&&x.id); if(id) known[id]=true; });
  if(!Array.isArray(c.allow)||!c.allow.length) errors.push(who+'coding.allow must be a non-empty list');
  else c.allow.forEach(function(id){
    if(typeof id!=='string'||!id) errors.push(who+'coding.allow has an entry that is not text');
    else if(id!=='local'&&id!=='none'&&!known[id]) errors.push(who+'coding.allow names unknown code system "'+id+'"');
  });
  return {errors:errors};
}

/* P3b: validateCoding over every field of a set (sections[].fields[] and fields[]). Returns {errors}. */
function validateSetCoding(set,knownSystems){
  var errors=[];
  var fs=[].concat.apply([],((set&&set.sections)||[]).map(function(x){ return (x&&x.fields)||[]; })).concat((set&&set.fields)||[]);
  fs.forEach(function(f){ validateCoding(f,knownSystems).errors.forEach(function(e){ errors.push(e); }); });
  return {errors:errors};
}

/* R2: access block check (see VIEWS.md "Access block"). el.access = {view, enter, amend, approve, configure, export}, each a non-empty list of role names.
   roles = the role list from permissions.js (passed in, so this file names no role). A missing action is allowed: it means no role has it (default deny).
   Returns {errors}. It does not compare against permissions.js rights: that is canElement (R3). */
var ACCESS_ACTIONS=['view','enter','amend','approve','configure','export'];
function validateAccess(el,roles){
  var errors=[];
  var who='element "'+((el&&(el.setId||el.id))||'?')+'" ';
  var a=el&&el.access;
  if(a===undefined||a===null){ errors.push(who+'has no access block'); return {errors:errors}; }
  if(typeof a!=='object'||Array.isArray(a)){ errors.push(who+'access must be an object'); return {errors:errors}; }
  var known={};
  (Array.isArray(roles)?roles:[]).forEach(function(r){ known[r]=true; });
  Object.keys(a).forEach(function(k){
    if(ACCESS_ACTIONS.indexOf(k)<0){ errors.push(who+'access has unknown action "'+k+'"'); return; }
    var list=a[k];
    if(!Array.isArray(list)||!list.length){ errors.push(who+'access.'+k+' must be a non-empty list of roles (leave the action out to give it to no one)'); return; }
    var seen={};
    list.forEach(function(r){
      if(typeof r!=='string'||!r) errors.push(who+'access.'+k+' has an entry that is not text');
      else if(!known[r]) errors.push(who+'access.'+k+' names unknown role "'+r+'"');
      else if(seen[r]) errors.push(who+'access.'+k+' lists role "'+r+'" more than once');
      seen[r]=true;
    });
  });
  return {errors:errors};
}

/* R8a: plain words for an access block, and the screen-side mirror of canElement. The server stays the control (permissions.js canElement); this only decides what to show or hide.
   describeAccess(access, roles, actions?) -> "Seen by: everyone. Entered by: doctor, nurse. ..." ; roles = the role list, so a block naming all of them reads "everyone".
   accessAllows(el, role, action, canFn) -> false when the element's list leaves the role out, or canFn(base action) says no (canFn is Store.can). An element with no block returns true:
   today's role rules apply and the caller's own Store.can check decides. ACCESS_BASE_ACTION must equal ELEMENT_BASE_ACTION in permissions.js (a test checks it). */
var ACCESS_WORDS={view:'Seen by',enter:'Entered by',amend:'Corrected by',approve:'Approved by',configure:'Changed by',export:'Exported by'};
var ACCESS_BASE_ACTION={view:'case.read',enter:'row.add',amend:'row.amend_own',approve:'rule.approve',configure:'set.write',export:'analytics.export'};
function describeAccess(access,roles,actions){
  if(!access||typeof access!=='object'||Array.isArray(access)) return 'Access: not set (the role rules apply).';
  var all=Array.isArray(roles)?roles:[];
  var wanted=Array.isArray(actions)&&actions.length?actions:ACCESS_ACTIONS;
  return wanted.filter(function(a){ return ACCESS_ACTIONS.indexOf(a)>=0; }).map(function(a){
    var l=Array.isArray(access[a])?access[a]:[];
    var everyone=all.length>0&&all.every(function(r){ return l.indexOf(r)>=0; });
    return ACCESS_WORDS[a]+': '+(!l.length?'no one':everyone?'everyone':l.join(', '))+'.';
  }).join(' ');
}
function accessAllows(el,role,action,canFn){
  if(ACCESS_ACTIONS.indexOf(action)<0) return false;
  var a=el&&el.access;
  if(!a||typeof a!=='object'||Array.isArray(a)) return true;
  var l=a[action];
  if(!Array.isArray(l)||l.indexOf(role)<0) return false;
  return typeof canFn==='function'?!!canFn(ACCESS_BASE_ACTION[action]):true;
}

var api={validateView:validateView,validatePathwayViews:validatePathwayViews,rowsInWindow:rowsInWindow,fieldsById:fieldsById,sumBy:sumBy,validateCoding:validateCoding,validateSetCoding:validateSetCoding,codingAllow:codingAllow,validateAccess:validateAccess,ACCESS_ACTIONS:ACCESS_ACTIONS,describeAccess:describeAccess,accessAllows:accessAllows,ACCESS_BASE_ACTION:ACCESS_BASE_ACTION};
root.Views=api;
if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
