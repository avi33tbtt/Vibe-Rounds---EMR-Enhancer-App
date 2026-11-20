/* core-elements.js : F6. What patient registration provides as elements (browser + Node). Data only, no recording set:
   nobody enters data here. Only what registration really captures (F0-inventory.md, section 3; patients.js INSERT INTO patients):
   sex (FHIR Patient.gender) and birth date (Patient.birthDate; the export gives the year only when the age was estimated).
   MRN, name, phone and national id are identifiers, never elements. No codes are filled in. */
(function(root){
var E=typeof module!=='undefined'?require('./elements.js'):root.Elements;
var SET_ID='core.registration';
/* column = the patients column that really holds the value (checked against patients.js by core-elements.test.js). */
var FIELDS=[
  {fieldId:'sex',column:'sex',type:'select',resource:'Patient.gender',note:'values: female, male, other, unknown'},
  {fieldId:'birthDate',column:'date_of_birth',type:'date',resource:'Patient.birthDate',note:'year only when the age was estimated'}
];
function provides(){
  return FIELDS.map(function(f){
    var fld={type:f.type,fhir:{resource:f.resource.split('.')[0]}};
    return {fieldId:f.fieldId,group:null,role:E.roleOf(fld),resource:f.resource.split('.')[0],unit:'-',system:null,code:null,
      key:E.elementKey({setId:SET_ID},fld,[]),note:f.note};
  });
}
var api={setId:SET_ID,recording:false,fields:FIELDS,provides:provides};
root.CoreElements=api;
if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
