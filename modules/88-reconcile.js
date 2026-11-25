// R4d-2: Medication reconciliation (on the Orders tab). The recorded medication list next to the active orders; the clinician records one explicit decision per item. Server data only; nothing is stored in the browser.
// Top-level constants are plain values (nothing here runs at load); page functions are called only when used.
/* Nothing is matched, suggested or checked here: no names compared, no doses, no interactions. The server decides who may record, which items and orders are usable
   and keeps every decision (the latest one is shown). Who and when are the server's values. All text is escaped. */
const REC={history:[],orders:[],pid:null,msg:'',loaded:false,busy:false,err:{},draft:{},pick:{}};
const REC_LBL={continue:'continue',stop:'stop',not_taken:'not taken'};
const REC_DONE={continue:'Decision recorded: continue.',stop:'Decision recorded: stop.',not_taken:'Decision recorded: not taken.'};
const recReset=()=>{REC.history=[];REC.orders=[];REC.pid=null;REC.msg='';REC.loaded=false;REC.err={};REC.draft={};REC.pick={}};
async function reconcileLoad(){
  const pid=CASE&&CASE.patientId;
  if(!srvCan('orders:read')||!pid){recReset();REC.pid=pid||null;return renderReconcile()}
  REC.pid=pid;
  const r=await api('GET','/api/patients/'+encodeURIComponent(pid)+'/medication-reconciliation');
  if(!srvCan('orders:read')||!CASE||CASE.patientId!==pid)return;   // signed out or another patient opened meanwhile
  if(r.status!==200){REC.msg='The reconciliation could not be loaded: '+apiMsg(r);REC.history=[];REC.orders=[];REC.loaded=true;return renderReconcile()}
  REC.history=r.body.history||[];REC.orders=r.body.orders||[];REC.msg='';REC.loaded=true;renderReconcile();
}
function recKeep(){REC.history.forEach(h=>{const t=$('rc_r_'+h.id),s=$('rc_o_'+h.id);if(t)REC.draft[h.id]=t.value;if(s)REC.pick[h.id]=s.value})}
function renderReconcile(){
  const box=$('reconcileBox');if(!box)return;
  if(!srvCan('orders:read')){recReset();box.innerHTML='';return}
  recKeep();
  if(!CASE||!CASE.patientId){box.innerHTML='';return}
  const w=srvCan('orders:write'),dis=REC.busy?' disabled':'';
  let h=`<h3>Medication reconciliation</h3><div class="note">Reconciliation for <b>${escA(caseName(CASE))}</b> (synthetic data only). The recorded medication list is shown next to the active orders. The page matches, suggests and checks nothing: for each recorded medication you record one decision with a reason. Every decision is kept; the latest is shown. Who and when are recorded by the server. <button class="b sec sm" data-act="reconcileReload">Reload</button>${REC.msg?' '+escA(REC.msg):''}</div>`;
  h+='<div class="cd"><b>Active orders</b>'+(REC.orders.length?REC.orders.map(o=>`<div class="mu">#${escA(o.id)} ${escA(o.medication)} · dose ${escA(o.dose_text)} · route ${escA(o.route_text)} · frequency ${escA(o.frequency_text)}</div>`).join(''):'<div class="mu">No active orders.</div>')+'</div>';
  if(REC.loaded&&!REC.history.length&&!REC.msg)h+='<div class="empty">No active medications on the recorded list to reconcile.</div>';
  REC.history.forEach(m=>{
    const id=escA(m.id),d=m.decision;
    h+=`<div class="cd"><b>${escA(m.medication)}</b> <span class="mu">recorded list · dose ${m.dose_text?escA(m.dose_text):'not recorded'} · frequency ${m.frequency_text?escA(m.frequency_text):'not recorded'} · start ${m.start_date?escA(m.start_date):'unknown'}</span>`;
    h+=d?`<div class="mu">Latest decision: <b>${escA(REC_LBL[d.decision]||d.decision)}</b>${d.order_id?' (covered by order #'+escA(d.order_id)+')':''} by ${escA(d.decided_by)} · ${escA(String(d.decided_at||'').slice(0,16).replace('T',' '))}: ${escA(d.reason)}</div>`:'<div class="mu">Not reconciled yet.</div>';
    if(w){
      const opts=REC.orders.map(o=>`<option value="${escA(o.id)}"${String(o.id)===String(REC.pick[m.id])?' selected':''}>#${escA(o.id)} ${escA(o.medication)}</option>`).join('');
      h+=`<div style="margin-top:6px"><textarea id="rc_r_${id}" rows="2" maxlength="1000" placeholder="Reason (required, up to 1000 characters)" aria-label="Reason" style="width:100%">${escA(REC.draft[m.id]||'')}</textarea>
        <div class="flex" style="margin-top:4px">${REC.orders.length?`<select id="rc_o_${id}" aria-label="Order that covers it"><option value="">order that covers it (for continue)</option>${opts}</select> <button class="b sm" data-act="reconcileContinue" data-arg="${id}"${dis}>Continue</button> `:''}<button class="b sec sm" data-act="reconcileStop" data-arg="${id}"${dis}>Stop</button> <button class="b sec sm" data-act="reconcileNotTaken" data-arg="${id}"${dis}>Not taken</button></div></div>`;
    }
    if(REC.err[m.id])h+=`<div class="gen-warn" style="margin-top:4px">${escA(REC.err[m.id])}</div>`;
    h+='</div>';
  });
  if(!w)h+='<div class="mu">Your role cannot record reconciliation decisions.</div>';
  box.innerHTML=h;
}
async function reconcileStep(decision,arg){
  const pid=CASE&&CASE.patientId;
  if(!/^\d{1,9}$/.test(arg||'')||!Object.hasOwn(REC_LBL,decision)||REC.busy||!pid||!srvCan('orders:write'))return;
  const id=Number(arg),m=REC.history.find(x=>x.id===id);if(!m)return;
  recKeep();delete REC.err[id];
  const reason=(REC.draft[id]||'').trim(),body={medicationId:id,decision,reason};   // only these fields; who and when are the session's
  if(!reason){REC.err[id]='A reason is required.';return renderReconcile()}
  if(decision==='continue'){
    const oid=Number(REC.pick[id]);
    if(!Number.isInteger(oid)||oid<1){REC.err[id]='Continue needs the active order that covers it: pick one.';return renderReconcile()}
    body.orderId=oid;
  }
  if(!confirm('Record "'+REC_LBL[decision]+'" for this medication?'))return;
  REC.busy=true;renderReconcile();
  const r=await api('POST','/api/patients/'+encodeURIComponent(pid)+'/medication-reconciliation',body);
  REC.busy=false;if(!srvCan('orders:read')||!CASE||CASE.patientId!==pid)return;
  if(r.status===201){delete REC.draft[id];delete REC.pick[id];toast(REC_DONE[decision]);await reconcileLoad();return}
  REC.err[id]=apiMsg(r);
  if(r.status===409)await reconcileLoad();else renderReconcile();
}
