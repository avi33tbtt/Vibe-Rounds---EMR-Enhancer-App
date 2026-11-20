/* elements.js : pure element helpers for EMR Enhancer (browser + Node). See ELEMENTS.md.
   No DOM, no set ids, no field ids. Roles come only from field.type (ELEMENTS.md, Roles table);
   a code appears only from the bindings passed in; units are never converted. */
(function(root){
/* field type -> role. Types not listed (boolean, duration_min, ...) have no role and are not elements.
   status, actor and link never come from a plain field type, so roleOf never returns them. */
var TYPE_ROLE={datetime:'time',date:'time',number:'quantity',integer:'quantity',select:'category',text:'text'};

function roleOf(field){
  if(!field||typeof field!=='object') return null;
  return Object.prototype.hasOwnProperty.call(TYPE_ROLE,field.type)?TYPE_ROLE[field.type]:null;
}

function str(x){ return typeof x==='string'&&x.trim()!==''; }

/* Codes bound to one field. binding may be one {system,code}, a list of them (several codings), or empty.
   Only entries with a non-empty system and code count. Nothing is ever made up. */
function codingsOf(binding){
  var list=Array.isArray(binding)?binding:(binding?[binding]:[]);
  return list.filter(function(b){ return b&&str(b.system)&&str(b.code); })
    .map(function(b){ return {system:b.system.trim(),code:b.code.trim()}; });
}

/* One line: Resource.value | role | unit | system:code[,system:code]   ('-' where a part is absent). */
function elementKey(set,field,binding){
  var role=roleOf(field); if(!role) return null;
  var res=field.fhir&&str(field.fhir.resource)?field.fhir.resource:null;
  var unit=str(field.unit)?field.unit:'-';
  var codes=codingsOf(binding).map(function(c){ return c.system+':'+c.code; });
  return (res?res+'.value':'-')+' | '+role+' | '+unit+' | '+(codes.length?codes.join(','):'-');
}

/* bindings: rows shaped like code_bindings {set_id, field_id, system, code, display}.
   Returns [{fieldId, group, role, resource, unit, system, code, key}] for every field of the set that has a role.
   Fields marked meta (unit selectors, display-only thresholds) are never elements.
   resource is null when the field has no fhir block: it still has a role, but it cannot be exported.
   unit is the field's unit string as typed ('-' when none); a field whose unit is chosen per row carries unitField.
   system and code are those of the first binding; the key lists all of them. */
function providesOf(set,bindings){
  var out=[];
  var rows=Array.isArray(bindings)?bindings:[];
  ((set&&set.sections)||[]).forEach(function(sec){
    ((sec&&sec.fields)||[]).forEach(function(f){
      if(!f||!f.id||f.meta) return;
      var role=roleOf(f); if(!role) return;
      var mine=rows.filter(function(b){ return b&&b.set_id===set.setId&&b.field_id===f.id; });
      var codes=codingsOf(mine);
      var e={fieldId:f.id,group:f.group||null,role:role,
        resource:f.fhir&&str(f.fhir.resource)?f.fhir.resource:null,
        unit:str(f.unit)?f.unit:'-',
        system:codes.length?codes[0].system:null,code:codes.length?codes[0].code:null,
        key:elementKey(set,f,codes)};
      if(str(f.unitField)) e.unitField=f.unitField;
      out.push(e);
    });
  });
  return out;
}

/* F3a/F3b: slot matching. requires = [{slot, role, resource?, unit?, codeSystem?, sameRowAs?}] (never a set or field id).
   provides = the list from providesOf. manualBindings = [{slot, fieldId}] chosen by a person.
   met    : role matches, resource matches (if the slot names one), unit string matches exactly (slot unit "any" or none
            matches every unit) and, if the slot names a codeSystem other than "any", the field carries a code of it.
   partly : role (and resource) match but unit or code system differs. Nothing is converted or guessed; partial[] says which.
   unmet  : no field has the role. A field whose unit is chosen per row only meets a slot with unit "any".
   sameRowAs:"other" keeps only fields in the same repeat group as a field that met the other slot.
   A manual binding is honoured as a match with basis "bound by hand", whatever the role.
   unusedFields: provided fields that no slot met or was bound to. Never judges quality of care. */
function unitText(e){ return e.unitField?'unit varies by row':(e.unit&&e.unit!=='-'?e.unit:'no unit'); }
function systemsOf(e){
  var last=String(e&&e.key||'').split(' | ')[3];
  if(!last||last==='-') return [];
  return last.split(',').map(function(c){ return c.split(':')[0]; });
}
function needSystem(slot){ return str(slot.codeSystem)&&slot.codeSystem!=='any'?slot.codeSystem:null; }
function basisOf(slot,e){
  var parts=[]; if(str(slot.resource)) parts.push(slot.resource);
  parts.push(e.role); parts.push(unitText(e));
  if(needSystem(slot)) parts.push('code system '+needSystem(slot));
  return 'matched on: '+parts.join(', ');
}
/* {met:[entries], partial:[{entry, differs:[text]}]} for one slot, before sameRowAs and manual bindings. */
function evalSlot(slot,provides){
  var met=[], partial=[];
  if(!slot||!str(slot.role)) return {met:met,partial:partial};
  var anyUnit=!str(slot.unit)||slot.unit==='any', sys=needSystem(slot);
  provides.forEach(function(e){
    if(!e||e.role!==slot.role) return;
    if(str(slot.resource)&&e.resource!==slot.resource) return;
    var differs=[];
    if(!anyUnit&&(e.unitField||e.unit!==slot.unit)) differs.push('unit differs (slot '+slot.unit+', field '+unitText(e)+')');
    if(sys&&systemsOf(e).indexOf(sys)<0){
      var has=systemsOf(e);
      differs.push('code system differs (slot needs '+sys+', field has '+(has.length?has.join(', '):'none')+')');
    }
    if(differs.length) partial.push({entry:e,differs:differs}); else met.push(e);
  });
  return {met:met,partial:partial};
}
function compatibility(requires,provides,manualBindings){
  var reqs=Array.isArray(requires)?requires:[], prov=Array.isArray(provides)?provides:[];
  var manual=Array.isArray(manualBindings)?manualBindings:[];
  var done={}, slots=[], used={};
  reqs.forEach(function(sl){
    var name=sl&&sl.slot, ev=evalSlot(sl,prov), met=ev.met, partial=ev.partial;
    if(sl&&str(sl.sameRowAs)){
      var other=done[sl.sameRowAs], groups={};
      ((other&&other.matched)||[]).forEach(function(m){
        var f=prov.filter(function(e){ return e.fieldId===m.fieldId; })[0];
        if(f&&f.group) groups[f.group]=true;
      });
      var keep=function(e){ return e.group&&groups[e.group]; };
      met=met.filter(keep); partial=partial.filter(function(x){ return keep(x.entry); });
    }
    var matched=met.map(function(e){
      return {fieldId:e.fieldId,basis:basisOf(sl,e)+(sl.sameRowAs?'; same row as '+sl.sameRowAs:'')};
    });
    var bound=[];
    manual.forEach(function(b){
      if(!b||!name||b.slot!==name||!str(b.fieldId)||bound.indexOf(b.fieldId)>=0) return;
      if(!prov.some(function(e){ return e&&e.fieldId===b.fieldId; })) return;
      bound.push(b.fieldId);
    });
    if(bound.length){
      matched=bound.map(function(id){ return {fieldId:id,basis:'bound by hand'}; })
        .concat(matched.filter(function(m){ return bound.indexOf(m.fieldId)<0; }));
      partial=partial.filter(function(x){ return bound.indexOf(x.entry.fieldId)<0; });
    }
    var r={slot:name,status:matched.length?'met':(partial.length?'partly':'unmet'),matched:matched,
      partial:matched.length?[]:partial.map(function(x){
        return {fieldId:x.entry.fieldId,differs:x.differs,basis:'role matches; '+x.differs.join('; ')};
      })};
    matched.forEach(function(m){ used[m.fieldId]=true; });
    if(name) done[name]=r;
    slots.push(r);
  });
  return {slots:slots,
    unusedFields:prov.filter(function(e){ return e&&!used[e.fieldId]; }).map(function(e){ return {fieldId:e.fieldId,key:e.key}; })};
}

var api={roleOf:roleOf,elementKey:elementKey,providesOf:providesOf,compatibility:compatibility};
root.Elements=api;
if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
