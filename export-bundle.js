/* export-bundle.js : F7a + F7b. De-identify element rows for the analytics export (browser + Node, pure, writes nothing).
   Decision 22: dates become days since the encounter start. The output holds NO name, MRN, phone, national id, set id or field id:
   each output row is built from a fixed list of keys, never copied whole. Ids become salted HMAC-SHA-256 pseudonyms (stable for one salt). */
(function(root){
var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function rotr(x,n){return (x>>>n)|(x<<(32-n));}
function sha256(msg){                                   // Uint8Array -> Uint8Array(32), synchronous so it works in a browser too
  var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var l=msg.length, n=((l+9+63)>>6)<<6, buf=new Uint8Array(n); buf.set(msg); buf[l]=0x80;
  var dv=new DataView(buf.buffer); dv.setUint32(n-8,Math.floor(l/0x20000000)); dv.setUint32(n-4,(l<<3)>>>0);
  var w=new Array(64), i;
  for(var o=0;o<n;o+=64){
    for(i=0;i<16;i++) w[i]=dv.getUint32(o+i*4);
    for(i=16;i<64;i++){var s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3), s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10); w[i]=(w[i-16]+s0+w[i-7]+s1)|0;}
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(i=0;i<64;i++){
      var t1=(h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i])|0, t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
  }
  var out=new Uint8Array(32), ov=new DataView(out.buffer); for(i=0;i<8;i++) ov.setUint32(i*4,H[i]>>>0); return out;
}
function utf8(s){return new TextEncoder().encode(String(s));}
function hmacHex(key,msg){
  var k=utf8(key); if(k.length>64) k=sha256(k);
  var ip=new Uint8Array(64), op=new Uint8Array(64), i; for(i=0;i<64;i++){var kb=i<k.length?k[i]:0; ip[i]=kb^0x36; op[i]=kb^0x5c;}
  var m=utf8(msg), inner=new Uint8Array(64+m.length); inner.set(ip); inner.set(m,64);
  var ih=sha256(inner), outer=new Uint8Array(96); outer.set(op); outer.set(ih,64);
  return Array.prototype.map.call(sha256(outer),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');
}
var WITHHELD_ROLES=['text','actor','link'];             // free text can hold names; an actor identifies staff; a link can point anywhere
var KEYS=['patientId','encounterId','caseId','rowId','resource','role','unit','system','code','valueNumber','valueText','daysFromStart','status'];
function startOf(starts,id){ if(!starts||id==null) return null; var v=typeof starts.get==='function'?starts.get(id):starts[id]; var t=v==null?NaN:Date.parse(v); return isNaN(t)?null:t; }
/* deidentify(elementRows, {salt, encounterStarts, keepFreeText}) -> new rows (input is not changed).
   salt: required string, 8 characters or more. encounterStarts: {encounterId: ISO time} or a Map; an encounter with no start gives daysFromStart null.
   The caller passes the FINAL patient id (mergedInto already followed), so a merged patient gets one pseudonym. */
function deidentify(rows,opts){
  opts=opts||{}; var salt=opts.salt;
  if(typeof salt!=='string'||salt.length<8) throw new Error('deidentify needs a salt of at least 8 characters');
  var pseudo=function(kind,id){return id==null?null:'p-'+hmacHex(salt,kind+'|'+id).slice(0,32);};
  return (rows||[]).map(function(r){
    var t=r.time==null?NaN:Date.parse(r.time), s=startOf(opts.encounterStarts,r.encounterId);
    var days=(isNaN(t)||s==null)?null:Math.round((t-s)/86400000*1000)/1000;       // decimal days, about 1.4 minutes; the real date is never kept
    var held=!opts.keepFreeText&&WITHHELD_ROLES.indexOf(r.role)>=0;
    return {patientId:pseudo('patient',r.patientId),encounterId:pseudo('encounter',r.encounterId),caseId:pseudo('case',r.caseId),rowId:pseudo('row',r.rowId),
      resource:r.resource==null?null:r.resource,role:r.role==null?null:r.role,unit:r.unit==null?null:r.unit,system:r.system==null?null:r.system,code:r.code==null?null:r.code,
      valueNumber:r.valueNumber==null?null:r.valueNumber,valueText:held||r.valueText==null?null:r.valueText,daysFromStart:days,status:r.status==null?null:r.status};
  });
}
/* F7b. Both functions take rows ALREADY passed through deidentify(); they never see a set id or field id. */
function codingOf(r){ return r.code==null?null:{coding:[r.system==null?{code:String(r.code)}:{system:r.system,code:String(r.code)}]}; }  // a code appears only if the row carries one
function toResource(r){
  var res={resourceType:r.resource,id:r.rowId};
  if(r.status!=null) res.status=r.status;
  if(r.patientId!=null) res.subject={reference:'Patient/'+r.patientId};
  if(r.encounterId!=null) res.encounter={reference:'Encounter/'+r.encounterId};
  var c=codingOf(r); if(c) res.code=c;
  if(r.resource==='Observation'){
    if(r.valueNumber!=null) res.valueQuantity=r.unit==null?{value:r.valueNumber}:{value:r.valueNumber,unit:r.unit};   // unit as recorded, never converted
    else if(r.valueText!=null) res.valueString=r.valueText;
  }
  res.extension=[{url:'urn:emr-enhancer:days-from-encounter-start',valueDecimal:r.daysFromStart}].filter(function(e){return e.valueDecimal!=null;});
  if(!res.extension.length) delete res.extension;
  return res;
}
/* buildExportBundle(rows) -> FHIR R4 transaction Bundle. PUT by id, so a re-export updates the same resources. Rows with no resource type are skipped. */
function buildExportBundle(rows){
  var entry=(rows||[]).filter(function(r){return r&&r.resource&&r.rowId;}).map(function(r){var res=toResource(r); return {resource:res,request:{method:'PUT',url:res.resourceType+'/'+res.id}};});
  return {resourceType:'Bundle',type:'transaction',entry:entry};
}
/* buildManifest(rows) -> {elements:[{resource,role,unit,system,code,count}]}, sorted. No set or field id exists in these rows. */
function buildManifest(rows){
  var m={}; (rows||[]).forEach(function(r){
    if(!r||!r.resource) return;
    var k=[r.resource,r.role,r.unit,r.system,r.code].map(function(x){return x==null?'':String(x);}).join('|');
    (m[k]=m[k]||{resource:r.resource,role:r.role==null?null:r.role,unit:r.unit==null?null:r.unit,system:r.system==null?null:r.system,code:r.code==null?null:r.code,count:0}).count++;
  });
  return {elements:Object.keys(m).sort().map(function(k){return m[k];})};
}
var api={deidentify:deidentify,buildExportBundle:buildExportBundle,buildManifest:buildManifest,KEYS:KEYS,WITHHELD_ROLES:WITHHELD_ROLES,_hmacHex:hmacHex};
root.ExportBundle=api;
if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
