/* export-bundle.js : F7a. De-identification of element rows for the analytics export (browser + Node). Pure: no database, no clock.
   Decision 22: dates become days since the encounter start. A patient, encounter or row id never leaves; each becomes a salted hash.
   No name, MRN, phone or national id is ever read here: element rows carry none. Free-text values are copied as recorded (not scrubbed). */
(function(root){
/* SHA-256 of a string (hex), pure JS so the same code runs in the browser and in Node. */
var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function utf8(s){ var u=unescape(encodeURIComponent(String(s))), b=[]; for(var i=0;i<u.length;i++) b.push(u.charCodeAt(i)); return b; }
function sha256(s){
  var b=utf8(s), l=b.length*8, h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  b.push(0x80); while(b.length%64!==56) b.push(0);
  var hi=Math.floor(l/4294967296); for(var i=3;i>=0;i--) b.push((hi>>>(i*8))&255); for(i=3;i>=0;i--) b.push((l>>>(i*8))&255);
  var rr=function(x,n){ return (x>>>n)|(x<<(32-n)); };
  for(var o=0;o<b.length;o+=64){
    var w=[]; for(i=0;i<16;i++) w[i]=(b[o+4*i]<<24)|(b[o+4*i+1]<<16)|(b[o+4*i+2]<<8)|b[o+4*i+3];
    for(i=16;i<64;i++){ var s0=rr(w[i-15],7)^rr(w[i-15],18)^(w[i-15]>>>3), s1=rr(w[i-2],17)^rr(w[i-2],19)^(w[i-2]>>>10); w[i]=(w[i-16]+s0+w[i-7]+s1)|0; }
    var a=h[0],bb=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for(i=0;i<64;i++){
      var t1=(hh+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+K[i]+w[i])|0, t2=((rr(a,2)^rr(a,13)^rr(a,22))+((a&bb)^(a&c)^(bb&c)))|0;
      hh=g; g=f; f=e; e=(d+t1)|0; d=c; c=bb; bb=a; a=(t1+t2)|0;
    }
    h=[(h[0]+a)|0,(h[1]+bb)|0,(h[2]+c)|0,(h[3]+d)|0,(h[4]+e)|0,(h[5]+f)|0,(h[6]+g)|0,(h[7]+hh)|0];
  }
  return h.map(function(x){ return ('00000000'+(x>>>0).toString(16)).slice(-8); }).join('');
}
function str(x){ return typeof x==='string'&&x.trim()!==''; }

/* elementRows = projectCase output. opts.salt (required, non-empty), opts.encounterStarts = {encounterId: ISO time}.
   Returns [{id, pseudoPatient, pseudoEncounter, resource, role, unit, codings, valueNumber, valueText, daysSinceStart, status}].
   daysSinceStart = (row time - encounter start) in days, 3 decimals; null when the time is null, the start is unknown or unreadable.
   Rows with no patient id are left out (they cannot be grouped, and an id-less row must never be guessed). The caller passes the final
   patient id after following mergedInto, so a merged patient has one pseudonym. */
function deidentify(elementRows,opts){
  var o=opts||{}; if(!str(o.salt)) throw new Error('deidentify needs a salt');
  var starts=o.encounterStarts&&typeof o.encounterStarts==='object'?o.encounterStarts:{}, out=[];
  (Array.isArray(elementRows)?elementRows:[]).forEach(function(r){
    if(!r||!r.patientId) return;
    var days=null, t=r.time?Date.parse(r.time):NaN, s=r.encounterId&&starts[r.encounterId]?Date.parse(starts[r.encounterId]):NaN;
    if(isFinite(t)&&isFinite(s)) days=Math.round((t-s)/86400000*1000)/1000;
    var fid=r.source&&r.source.fieldId?r.source.fieldId:'';
    out.push({id:r.rowId?sha256(o.salt+'|row|'+r.rowId+'|'+fid):null,
      pseudoPatient:sha256(o.salt+'|patient|'+r.patientId),
      pseudoEncounter:r.encounterId?sha256(o.salt+'|encounter|'+r.encounterId):null,
      resource:r.resource,role:r.role,unit:r.unit,codings:Array.isArray(r.codings)?r.codings.map(function(c){ return {system:c.system,code:c.code}; }):[],
      valueNumber:r.valueNumber===undefined?null:r.valueNumber,valueText:r.valueText===undefined?null:r.valueText,
      daysSinceStart:days,status:r.status||'active'});
  });
  return out;
}

var api={deidentify:deidentify,sha256:sha256};
root.ExportBundle=api;
if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
