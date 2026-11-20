/* views.js : pure view-data helpers for EMR Enhancer (browser + Node).
   No DOM, no set ids. validateView(set) checks a set's optional "view" block. See VIEWS.md. */
(function(root){
var VIEW_TYPES=['flowsheet','fever','dailygrid'];
var VIEW_KEYS=['type','timeField','tempField','unitField','thresholdField','thresholdUnitField','extra',
  'slotField','glucoseField','doseField','byField','slots',
  'summary','board','banner','statusboard','actions','crosscheck','drives'];
var SUMMARY_TYPES=['sumBy'];
var SUMMARY_KEYS=['type','timeField','keyField','valueField','windowsHours','label'];
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

function validateView(set){
  var errors=[],warnings=[];
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

var api={validateView:validateView,validatePathwayViews:validatePathwayViews,rowsInWindow:rowsInWindow,fieldsById:fieldsById,sumBy:sumBy};
root.Views=api;
if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
