// R0b-1: signed-in session state and the one API helper, moved unchanged from the inline script.
// Functions it calls at run time (renderWho, storeLeave, toast) are defined elsewhere; nothing here runs at load.
/* ---------- Server: sign-in, patients, encounters (chunk 01) ----------
   Patient identity comes from the server. A case stores only patientId; name/MRN/age are never copied into the case. */
const Srv={user:null,pts:{},t:null};
const SEXL={M:'M',F:'F',O:'Other',U:'Unknown'};
const srvCan=p=>!!Srv.user&&Srv.user.perms.includes(p);
const caseName=c=>c.patientId?(Srv.pts[c.patientId]?.name||'Registered patient #'+c.patientId):(c.patient.name||'Unnamed patient');
const caseMrn=c=>c.patientId?(Srv.pts[c.patientId]?.mrn||'—'):(c.patient.mrn||'—');
async function api(method,path,body){
  if(location.protocol==='file:')return{status:0,body:{error:'offline',message:'This page was opened as a file. Start the server (npm start) and open it from http://localhost to use patient registration.'}};
  try{
    const r=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-EMR':'1'},body:body===undefined?undefined:JSON.stringify(body)});
    let j=null;try{j=await r.json()}catch(e){}
    if(r.status===401&&Srv.user&&path!=='/api/login'&&path!=='/api/me'){Srv.user=null;Srv.pts={};storeLeave();renderWho();toast('Session expired — sign in again')}
    return{status:r.status,body:j||{}};
  }catch(e){return{status:0,body:{error:'offline',message:'Cannot reach the server.'}}}
}
const apiMsg=r=>r.body.message||(r.status===403?'Your role does not have permission for this action.':r.status===0?r.body.message:'Something went wrong ('+(r.body.error||r.status)+').');
const user=()=>Srv.user?String(Srv.user.username||''):'';   // signer, author and amender: the signed-in session only, never a typed field
