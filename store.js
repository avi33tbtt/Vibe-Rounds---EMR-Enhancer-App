/* store.js (chunk 29): window.Store, the one place that reads and writes data.
 * The app stays synchronous: every read comes from an in-memory cache. Writes update the cache at once and are
 * sent to the API by an ordered background queue, each with the version last seen (409 = conflict, never overwrite).
 * Two modes: 'server' (default) and 'local' (Demo mode: synthetic data only, kept in this browser's localStorage).
 * Server mode finds what to send by comparing the cache with a snapshot of what the server last confirmed, so
 * repeated edits coalesce and a failed or retried send is always recomputed from current data. */
(function (g) {
  'use strict';
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const strip = (o) => { const r = {}; for (const k in o) if (!k.startsWith('__')) r[k] = o[k]; return r; };
  const uid = () => (g.crypto && g.crypto.randomUUID ? g.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const IDENT = /^[A-Za-z0-9_.-]{1,100}$/, VALKEY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.@-]{1,100}$/;
  const META = ['patient', 'narrative', 'applied', 'pathways', 'pinned', 'alertLog'];
  const LS = { cases: 'cases', sets: 'sets', usage: 'setUsage', codes: 'codes', binds: 'binds', rules: 'rules', protocols: 'protocols' };
  const PREF_LS = { pinned: 'pinned', mypts: 'mypts' };

  const Store = {
    mode: (function () { try { return g.localStorage.getItem('storeMode') === 'local' ? 'local' : 'server'; } catch (e) { return 'server'; } })(),
    base: '', ready: false, me: null,
    reasons: {},                                   // rowId -> reason typed when a reading is removed ("entered in error")
    hooks: { onStatus() {}, onConflict() {}, onUnauthorized() {}, onCaseReloaded() {}, toast() {}, rowTime() { return null; } },
  };
  const S = { cases: [], sets: [], usage: {}, codes: {}, binds: {}, rules: {}, protocols: {}, prefs: {} };
  const snap = {};                                  // entity key -> what the server last confirmed
  const Q = []; let running = false, timer = null, delay = 2000, savedAt = null, retrying = false;
  const failed = {}, conflicts = {};
  const warned = {};
  const grpOf = (key) => key.slice(key.indexOf(':') + 1).split('|')[0];

  // ---------------------------------------------------------------- API client
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(Store.base + '/api' + path, { method, credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) { const er = new Error('Cannot reach the server'); er.network = true; throw er; }
    let data = null;
    if (res.status !== 204) { try { data = await res.json(); } catch (e) { /* not JSON */ } }
    if (!res.ok) {
      const er = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status);
      er.status = res.status; er.code = data && data.error && data.error.code; er.current = data && data.current;
      if (res.status === 401) Store.hooks.onUnauthorized();
      throw er;
    }
    return data;
  }
  Store.api = api;

  // ---------------------------------------------------------------- status
  function status() {
    const nc = Object.keys(conflicts).length, nf = Object.keys(failed).length;
    const state = nc ? 'conflict' : retrying ? 'retry' : nf ? 'failed' : (Q.length || running) ? 'saving' : 'saved';
    return { state, pending: Q.length, savedAt, conflicts: Object.assign({}, conflicts), failed: Object.assign({}, failed),
      text: Store.mode === 'local' ? 'Demo mode: saved in this browser' :
        state === 'saving' ? 'Saving…' : state === 'saved' ? (savedAt ? 'Saved ' + savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Saved') :
        state === 'retry' ? 'NOT SAVED: will retry' : state === 'conflict' ? 'NOT SAVED: changed by someone else' : 'NOT SAVED: ' + Object.values(failed)[0] };
  }
  const notify = () => { try { Store.hooks.onStatus(status()); } catch (e) { /* UI problem must not stop saving */ } };
  Store.status = status;
  Store.pending = () => Q.length + (running ? 1 : 0) + Object.keys(failed).length + Object.keys(conflicts).length;

  // ---------------------------------------------------------------- write queue
  function enqueue(key, run) {
    if (Store.mode !== 'server') return;
    if (conflicts[grpOf(key)]) return;
    delete failed[key];
    if (Q.some((o) => o.key === key && !o.started)) return notify();
    Q.push({ key, run, started: false });
    notify(); pump();
  }
  async function pump() {
    if (running || retrying) return;
    running = true; notify();
    while (Q.length) {
      const op = Q[0]; op.started = true;
      try { await op.run(); Q.shift(); delay = 2000; savedAt = new Date(); }
      catch (e) {
        if (e.status === 409) {
          Q.shift(); const grp = grpOf(op.key);
          conflicts[grp] = { entity: op.key, current: e.current, message: e.message, code: e.code };
          for (let i = Q.length - 1; i >= 0; i--) if (grpOf(Q[i].key) === grp) Q.splice(i, 1);
          try { Store.hooks.onConflict(op.key, e.current, conflicts[grp]); } catch (x) { /* UI */ }
        } else if (e.network || !e.status || e.status >= 500) {     // server down or flaky: keep the op, retry in order
          op.started = false; running = false; retrying = true; notify();
          timer = setTimeout(() => { retrying = false; pump(); }, delay); delay = Math.min(delay * 2, 30000);
          return;
        } else { Q.shift(); failed[op.key] = e.message; }            // 400/403/404/422: will not succeed by retrying
      }
      notify();
    }
    running = false; notify();
  }
  Store.retry = () => { clearTimeout(timer); retrying = false; delay = 2000; pump(); };
  Store.flush = () => new Promise((res) => { const t = setInterval(() => { if (!Q.length && !running) { clearInterval(t); res(); } }, 25); });
  if (g.addEventListener) g.addEventListener('beforeunload', (e) => { if (Store.mode === 'server' && Store.pending()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------------------------------------------------------------- shapes
  function metaOf(c) {
    const p = c.patient || {}, s = (x) => String(x == null ? '' : x);
    return {
      patient: { name: s(p.name), ageSex: s(p.ageSex), bed: s(p.bed), mrn: s(p.mrn) },
      narrative: s(c.narrative),
      applied: (c.applied || []).filter((a) => a && IDENT.test(a.setId || '')).map((a) => ({ setId: a.setId, addedAt: s(a.addedAt) })),
      pathways: (c.pathways || []).filter((x) => x && IDENT.test(x.pathwayId || '')).map((x) => Object.assign({ pathwayId: x.pathwayId }, Number.isInteger(x.version) && x.version > 0 ? { version: x.version } : {}, { startedAt: s(x.startedAt) })),
      pinned: Array.isArray(c.pinned) ? c.pinned.filter((x) => IDENT.test(x)) : null,
      alertLog: (c.alertLog || []).filter((x) => x && IDENT.test(x.ruleId || '') && typeof x.ackedAt === 'string'),
    };
  }
  const noteData = (n) => ({ type: n.type, setId: n.setId || null, text: n.text || '', status: n.status === 'signed' ? 'signed' : 'draft', amends: n.amends || null, reason: n.reason || '' });
  const timeOf = (setId, groupId, row) => { try { const t = Store.hooks.rowTime(setId, groupId, row); return t ? new Date(t).toISOString() : null; } catch (e) { return null; } };
  const findRow = (c, rid) => { for (const k of Object.keys(c.values || {})) { const i = k.indexOf('/@'); if (i > 0 && Array.isArray(c.values[k])) { const r = c.values[k].find((x) => x && x.__id === rid); if (r) return { setId: k.slice(0, i), groupId: k.slice(i + 2), row: r }; } } return null; };
  const caseById = (id) => S.cases.find((x) => x.id === id);

  function fromServerCase(sc) {
    const id = sc.id, c = { id, patient: sc.patient || { name: '', ageSex: '', bed: '', mrn: '' }, narrative: sc.narrative || '', applied: sc.applied || [],
      pathways: sc.pathways || [], alertLog: sc.alertLog || [], values: {}, notes: [], ns: true, rp: true, updatedAt: sc.updatedAt, saved: sc.updatedAt };
    if (Array.isArray(sc.pinned)) c.pinned = sc.pinned;
    for (const k of Object.keys(snap)) if (grpOf(k) === id) delete snap[k];
    snap['case:' + id] = { ver: sc.version, data: metaOf(c) };
    for (const k of Object.keys(sc.values || {})) {
      const v = sc.values[k], i = k.indexOf('/@');
      if (i > 0 && Array.isArray(v)) {
        c.values[k] = v.map((r) => {
          const row = strip(r); row.__id = r.__id; row.__by = r.__by; row.__at = r.__at;
          snap['row:' + id + '|' + r.__id] = { ver: r.__v, data: strip(r), time: r.__time || null, setId: k.slice(0, i), groupId: k.slice(i + 2) };
          return row;
        });
      } else {
        snap['val:' + id + '|' + k] = { ver: (sc.valueVersions || {})[k] || 1, data: v };
        if (v !== null) c.values[k] = v;
      }
    }
    c.notes = (sc.notes || []).map((n) => {
      snap['note:' + id + '|' + n.id] = { ver: n.version, data: noteData({ type: n.type, setId: n.setId, text: n.text, status: n.status, amends: n.amends, reason: n.reason }) };
      const o = { id: n.id, type: n.type, text: n.text || '', status: n.status, signedBy: n.signedByName || n.signedBy || '', signedAt: n.signedAt || '', createdAt: n.createdAt };
      if (n.setId) o.setId = n.setId;
      if (n.amends) { o.amends = n.amends; o.reason = n.reason || ''; }
      return o;
    });
    return c;
  }

  // ---------------------------------------------------------------- case sync (diff cache against server snapshot)
  function reconcile(c) {
    if (Store.mode !== 'server' || c.syn) return;
    const id = c.id;
    for (const k of Object.keys(c.values || {})) { const i = k.indexOf('/@'); if (i > 0 && Array.isArray(c.values[k])) c.values[k].forEach((r) => { if (r && typeof r === 'object' && !r.__id) r.__id = uid(); }); }
    (c.notes || []).forEach((n) => { if (n && !n.id) n.id = uid(); });
    const sm = snap['case:' + id];
    if (!sm || !eq(sm.data, metaOf(c))) enqueue('case:' + id, () => syncCase(id));
    const seenVals = new Set(), seenRows = new Set(), seenNotes = new Set();
    for (const k of Object.keys(c.values || {})) {
      const v = c.values[k], i = k.indexOf('/@');
      if (i > 0 && Array.isArray(v)) {
        const setId = k.slice(0, i), groupId = k.slice(i + 2);
        if (!IDENT.test(setId) || !IDENT.test(groupId)) { if (!warned[k]) { warned[k] = 1; Store.hooks.toast('Not saved to the server (invalid group key): ' + k); } continue; }
        v.forEach((r) => {
          seenRows.add(r.__id); const sn = snap['row:' + id + '|' + r.__id];
          if (!sn || !eq(sn.data, strip(r)) || sn.time !== timeOf(setId, groupId, r)) enqueue('row:' + id + '|' + r.__id, () => syncRow(id, r.__id));
        });
      } else {
        if (!VALKEY.test(k)) { if (!warned[k]) { warned[k] = 1; Store.hooks.toast('Not saved to the server (unsupported value key): ' + k); } continue; }
        seenVals.add(k); const sn = snap['val:' + id + '|' + k];
        if (!sn ? v !== undefined : !eq(sn.data, v === undefined ? null : v)) enqueue('val:' + id + '|' + k, () => syncVal(id, k));
      }
    }
    for (const key of Object.keys(snap)) {
      if (grpOf(key) !== id) continue;
      const rest = key.slice(key.indexOf('|') + 1);
      if (key.startsWith('val:') && !seenVals.has(rest) && snap[key].data !== null) enqueue(key, () => syncVal(id, rest));
      if (key.startsWith('row:') && !seenRows.has(rest)) enqueue('rowerr:' + id + '|' + rest, () => syncRowError(id, rest));
    }
    (c.notes || []).forEach((n) => {
      seenNotes.add(n.id); const sn = snap['note:' + id + '|' + n.id];
      if (!sn || !eq(sn.data, noteData(n))) enqueue('note:' + id + '|' + n.id, () => syncNote(id, n.id));
    });
    for (const key of Object.keys(snap)) if (key.startsWith('note:') && grpOf(key) === id && !seenNotes.has(key.slice(key.indexOf('|') + 1))) enqueue('notedel:' + id + '|' + key.slice(key.indexOf('|') + 1), () => syncNoteDel(id, key.slice(key.indexOf('|') + 1)));
  }

  async function syncCase(id) {
    const c = caseById(id); if (!c) return;
    const m = metaOf(c); let sn = snap['case:' + id];
    if (!sn) {
      const body = { id, patient: m.patient, narrative: m.narrative, applied: m.applied, pathways: m.pathways }; if (m.pinned) body.pinned = m.pinned;
      try {
        const r = await api('POST', '/cases', body);
        snap['case:' + id] = { ver: r.version, data: { patient: m.patient, narrative: m.narrative, applied: m.applied, pathways: m.pathways, pinned: m.pinned || null, alertLog: [] } };
      } catch (e) {
        if (e.status === 409 && e.current && e.current.id === id) snap['case:' + id] = { ver: e.current.version, data: metaOf({ patient: e.current.patient, narrative: e.current.narrative, applied: e.current.applied, pathways: e.current.pathways, pinned: e.current.pinned, alertLog: e.current.alertLog }) };  // earlier attempt succeeded, reply was lost
        else throw e;
      }
      sn = snap['case:' + id];
    }
    const patch = {}; META.forEach((k) => { if (!eq(sn.data[k], m[k])) patch[k] = m[k]; });
    if (!Object.keys(patch).length) return;
    const r = await api('PATCH', '/cases/' + id, Object.assign({ expectedVersion: sn.ver }, patch));
    sn.ver = r.version; Object.keys(patch).forEach((k) => { sn.data[k] = patch[k]; });
  }
  async function syncVal(id, key) {
    const c = caseById(id); if (!c) return;
    const v = c.values[key], val = v === undefined ? null : v, k = 'val:' + id + '|' + key, sn = snap[k];
    if (sn ? eq(sn.data, val) : val === null) return;
    const r = await api('PUT', '/cases/' + id + '/values', { key, value: val, expectedVersion: sn ? sn.ver : 0 });
    snap[k] = { ver: r.version, data: val };
  }
  async function syncRow(id, rid) {
    const c = caseById(id); if (!c) return; const f = findRow(c, rid); if (!f) return;
    const k = 'row:' + id + '|' + rid; let sn = snap[k];
    const data = strip(f.row), time = timeOf(f.setId, f.groupId, f.row);
    if (!sn) {
      const r = await api('POST', '/cases/' + id + '/rows', { id: rid, setId: f.setId, groupId: f.groupId, row: data, rowTime: time });
      sn = snap[k] = { ver: r.version, data: r.row, time: r.rowTime || null, setId: f.setId, groupId: f.groupId };   // a replayed POST returns the stored row
    }
    if (eq(sn.data, data) && sn.time === time) return;
    const r = await api('PATCH', '/cases/' + id + '/rows/' + rid, { expectedVersion: sn.ver, row: data, rowTime: time });
    snap[k] = { ver: r.version, data, time, setId: f.setId, groupId: f.groupId };
  }
  async function syncRowError(id, rid) {
    const k = 'row:' + id + '|' + rid, sn = snap[k]; if (!sn) return;
    await api('POST', '/cases/' + id + '/rows/' + rid + '/error', { expectedVersion: sn.ver, reason: Store.reasons[rid] || 'Removed from the chart by the user' });
    delete snap[k]; delete Store.reasons[rid];
  }
  async function syncNote(id, nid) {
    const c = caseById(id); if (!c) return; const n = (c.notes || []).find((x) => x.id === nid); if (!n) return;
    const k = 'note:' + id + '|' + nid; let sn = snap[k]; const d = noteData(n);
    if (!sn) {
      const parent = n.amends && snap['note:' + id + '|' + n.amends];
      try {
        const r = parent && parent.data.status === 'signed'
          ? await api('POST', '/cases/' + id + '/notes/' + n.amends + '/amend', { id: nid, reason: n.reason || 'Amendment', text: d.text })
          : await api('POST', '/cases/' + id + '/notes', Object.assign({ id: nid, type: d.type, text: d.text }, d.setId && IDENT.test(d.setId) ? { setId: d.setId } : {}));
        sn = snap[k] = { ver: r.version, data: Object.assign({}, d, { text: d.text, status: 'draft' }) };
      } catch (e) {
        if (e.status === 409 && !e.current) {                       // already created by an earlier attempt: adopt the server copy
          const sc = await api('GET', '/cases/' + id); const sv = (sc.notes || []).find((x) => x.id === nid);
          if (!sv) throw e;
          sn = snap[k] = { ver: sv.version, data: noteData({ type: sv.type, setId: sv.setId, text: sv.text, status: sv.status, amends: sv.amends, reason: sv.reason }) };
        } else throw e;
      }
    }
    if (sn.data.status !== 'signed' && d.text !== sn.data.text) {
      const r = await api('PATCH', '/cases/' + id + '/notes/' + nid, { expectedVersion: sn.ver, text: d.text }); sn.ver = r.version; sn.data.text = d.text;
    }
    if (d.status === 'signed' && sn.data.status !== 'signed') {
      const r = await api('POST', '/cases/' + id + '/notes/' + nid + '/sign', { expectedVersion: sn.ver }); sn.ver = r.version; sn.data.status = 'signed';
    }
  }
  async function syncNoteDel(id, nid) {
    const k = 'note:' + id + '|' + nid, sn = snap[k]; if (!sn) return;
    await api('DELETE', '/cases/' + id + '/notes/' + nid + '?expectedVersion=' + sn.ver); delete snap[k];
  }

  // ---------------------------------------------------------------- cases (same synchronous shape the app used)
  Store.getCases = () => clone(S.cases);
  Store.setCases = function (arr) {
    if (!Store.ready) return false;
    if (Store.mode === 'local') {
      try { g.localStorage.setItem(LS.cases, JSON.stringify(arr)); } catch (e) { Store.hooks.toast('Storage full or blocked: changes are NOT saved. Use Settings > Export all data now.'); return false; }
      S.cases = clone(arr); notify(); return true;
    }
    const next = clone(arr);
    S.cases = next;                                        // before reconcile: the queue starts sending at once and reads the cache
    next.forEach(reconcile);
    notify(); return true;
  };
  Store.reloadCase = async function (id) {              // explicit "Reload theirs": drops this person's unsent edits for that case
    for (let i = Q.length - 1; i >= 0; i--) if (grpOf(Q[i].key) === id && !Q[i].started) Q.splice(i, 1);
    delete conflicts[id];
    const c = fromServerCase(await api('GET', '/cases/' + id));
    const i = S.cases.findIndex((x) => x.id === id); if (i >= 0) S.cases[i] = c; else S.cases.push(c);
    notify(); Store.hooks.onCaseReloaded(id, clone(c)); return clone(c);
  };

  // ---------------------------------------------------------------- reference data (sync reads, queued writes)
  Store.userSets = () => clone(S.sets);
  Store.saveSet = function (s) {
    const i = S.sets.findIndex((x) => x.setId === s.setId); const c = clone(s);
    if (i >= 0) S.sets[i] = c; else S.sets.push(c);
    if (Store.mode === 'local') return lsSet(LS.sets, S.sets);
    enqueue('set:' + s.setId, async () => {
      const cur = S.sets.find((x) => x.setId === s.setId); if (!cur) return;
      const sn = snap['set:' + s.setId];
      const r = await api('POST', '/element-sets', Object.assign({ setId: cur.setId, kind: cur.kind, body: cur }, sn ? { expectedVersion: sn.ver } : {}));
      snap['set:' + s.setId] = { ver: r.version }; cur.version = r.version;
    });
    return true;
  };
  Store.usage = () => clone(S.usage);
  Store.bumpUsage = function (id, dxs) {
    const x = S.usage[id] || { count: 0 }; x.count++; x.lastUsed = new Date().toISOString();
    (dxs || []).forEach((k) => { x.withDx = x.withDx || {}; x.withDx[k] = (x.withDx[k] || 0) + 1; });
    S.usage[id] = x;
    if (Store.mode === 'local') return lsSet(LS.usage, S.usage);
    if (IDENT.test(id)) enqueue('use:' + id + ':' + uid(), () => api('POST', '/usage/' + id, { dxs: (dxs || []).filter((k) => typeof k === 'string' && k.length <= 100).slice(0, 20) }));
  };
  Store.mergeUsage = function (u) {
    if (Store.mode !== 'local') return false;           // server counts only grow by use; the browser importer (chunk 31) handles old data
    const cur = S.usage;
    Object.keys(u || {}).forEach((id) => {
      const x = u[id]; if (!x || typeof x.count !== 'number') return; const o = cur[id] || { count: 0, lastUsed: '' };
      const w = Object.assign({}, o.withDx || {}); Object.keys(x.withDx || {}).forEach((k) => { if (typeof x.withDx[k] === 'number') w[k] = Math.max(w[k] || 0, x.withDx[k]); });
      cur[id] = { count: Math.max(o.count || 0, x.count), lastUsed: String(x.lastUsed || '') > String(o.lastUsed || '') ? String(x.lastUsed || '') : o.lastUsed || '', withDx: w };
    });
    return lsSet(LS.usage, cur);
  };
  Store.resetUsage = function () {
    S.usage = {};
    if (Store.mode === 'local') { try { g.localStorage.removeItem(LS.usage); } catch (e) { /* ignore */ } return; }
    enqueue('usereset:' + uid(), () => api('DELETE', '/usage'));
  };

  Store.codes = () => clone(S.codes);                   // {'system|code': display}
  Store.saveCodes = function (t) {
    S.codes = clone(t);
    if (Store.mode === 'local') return lsSet(LS.codes, S.codes);
    Object.keys(t).forEach((k) => {
      const i = k.indexOf('|'), system = k.slice(0, i), code = k.slice(i + 1), sn = snap['code:' + k];
      if (i < 1 || !code || sn === t[k]) return;
      enqueue('code:' + k, async () => { const d = S.codes[k]; if (d === undefined) return; await api('PUT', '/codes', { system, code, display: String(d) }); snap['code:' + k] = d; });
    });
    return true;
  };
  Store.binds = () => clone(S.binds);                   // {'setId|fieldId': {system,code,display}}
  Store.saveBinds = function (b) {
    const old = S.binds; S.binds = clone(b);
    if (Store.mode === 'local') return lsSet(LS.binds, S.binds);
    Object.keys(b).forEach((k) => { if (!eq(old[k], b[k]) && /^[^|]+\|[^|]+$/.test(k)) enqueue('bind:' + k, async () => {
      const x = S.binds[k]; const [setId, fieldId] = k.split('|');
      if (x) await api('PUT', '/bindings', { setId, fieldId, system: x.system, code: x.code, display: x.display });
      else await api('DELETE', '/bindings/' + setId + '/' + fieldId); }); });
    Object.keys(old).forEach((k) => { if (!(k in b) && /^[^|]+\|[^|]+$/.test(k)) enqueue('bind:' + k, async () => { if (S.binds[k]) return; const [s, f] = k.split('|'); await api('DELETE', '/bindings/' + s + '/' + f); }); });
    return true;
  };

  Store.rules = () => clone(S.rules);                   // {ownerSetId: [rule]} in the app's shape
  Store.saveRules = function (o) {
    const old = S.rules; S.rules = clone(o);
    if (Store.mode === 'local') return lsSet(LS.rules, S.rules);
    const owners = new Set([...Object.keys(old), ...Object.keys(o)]);
    owners.forEach((ow) => {
      const ids = new Set([...(old[ow] || []), ...(o[ow] || [])].map((r) => r && r.ruleId).filter(Boolean));
      ids.forEach((rid) => { if (IDENT.test(ow) && IDENT.test(rid)) enqueue('rule:' + ow + '|' + rid, () => syncRule(ow, rid)); });
    });
    return true;
  };
  const ruleBody = (r) => { const b = clone(r); delete b.enabled; return b; };
  async function syncRule(ow, rid) {
    const k = 'rule:' + ow + '|' + rid, cur = (S.rules[ow] || []).find((r) => r && r.ruleId === rid); let sn = snap[k];
    if (!cur) { if (sn) { await api('DELETE', '/rules/' + ow + '/' + rid + '?expectedVersion=' + sn.ver); delete snap[k]; } return; }
    const body = ruleBody(cur);
    if (!sn || !eq(sn.data, body)) {                    // saving a rule always lands unapproved; approval is a separate server action
      const r = await api('PUT', '/rules/' + ow + '/' + rid, { body, expectedVersion: sn ? sn.ver : 0 }); sn = snap[k] = { ver: r.version, data: body, enabled: false };
    }
    const wants = !!cur.enabled && !!((cur.provenance || {}).verifiedBy || '').trim();
    if (wants && !sn.enabled) { const r = await api('POST', '/rules/' + ow + '/' + rid + '/approve', { expectedVersion: sn.ver }); sn.ver = r.version; sn.enabled = true; }
    else if (!wants && sn.enabled) { const r = await api('POST', '/rules/' + ow + '/' + rid + '/disable', { expectedVersion: sn.ver }); sn.ver = r.version; sn.enabled = false; }
  }

  Store.protocols = () => clone(S.protocols);
  Store.protocol = (sid) => clone(S.protocols[sid]);
  Store.saveProtocol = function (sid, p) {
    S.protocols[sid] = clone(p);
    if (Store.mode === 'local') return lsSet(LS.protocols, S.protocols);
    if (!IDENT.test(sid)) return false;
    enqueue('proto:' + sid, async () => {
      const cur = S.protocols[sid]; if (!cur) return; const sn = snap['proto:' + sid];
      if (sn && eq(sn.data, cur)) return;
      const r = await api('PUT', '/protocols/' + sid, { body: cur, expectedVersion: sn ? sn.ver : 0 }); snap['proto:' + sid] = { ver: r.version, data: clone(cur) };
    });
    return true;
  };

  Store.pref = (key, dflt) => (key in S.prefs ? clone(S.prefs[key]) : dflt);
  Store.setPref = function (key, val) {
    S.prefs[key] = clone(val);
    if (Store.mode === 'local') { if (PREF_LS[key]) return lsSet(PREF_LS[key], val); return true; }
    if (IDENT.test(key)) enqueue('pref:' + key, () => api('PUT', '/prefs/' + key, { value: S.prefs[key] === undefined ? null : S.prefs[key] }));
    return true;
  };

  function lsSet(k, v) { try { g.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { Store.hooks.toast('Storage full or blocked: changes are NOT saved.'); return false; } }
  const lsGet = (k, d) => { try { const v = JSON.parse(g.localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

  // ---------------------------------------------------------------- init
  async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } })); return out; }

  Store.init = async function () {
    Store.ready = false;
    if (Store.mode === 'local') {
      const raw = g.localStorage.getItem(LS.cases) || '[]'; let cs = [];
      try { cs = JSON.parse(raw); if (!Array.isArray(cs)) throw 0; } catch (e) {
        try { if (!g.localStorage.getItem('cases_corrupt')) g.localStorage.setItem('cases_corrupt', raw); } catch (x) { /* ignore */ }
        Store.hooks.toast('Saved cases could not be read; a raw copy was kept under localStorage key cases_corrupt. Do not clear browser data until you have inspected it.'); cs = [];
      }
      S.cases = cs; const a = lsGet(LS.sets, []); S.sets = Array.isArray(a) ? a : [];
      S.usage = isObj(lsGet(LS.usage, {})) ? lsGet(LS.usage, {}) : {}; S.codes = isObj(lsGet(LS.codes, {})) ? lsGet(LS.codes, {}) : {};
      S.binds = isObj(lsGet(LS.binds, {})) ? lsGet(LS.binds, {}) : {}; S.rules = isObj(lsGet(LS.rules, {})) ? lsGet(LS.rules, {}) : {};
      S.protocols = isObj(lsGet(LS.protocols, {})) ? lsGet(LS.protocols, {}) : {};
      S.prefs = {}; Object.keys(PREF_LS).forEach((k) => { const v = lsGet(PREF_LS[k], undefined); if (v !== undefined) S.prefs[k] = v; });
      Store.me = { id: 'demo', name: 'Demo user', role: 'admin' }; Store.ready = true; notify(); return;
    }
    const [me, list, sets, usage, codes, binds, rules, protos, prefs] = await Promise.all([api('GET', '/me'), api('GET', '/cases'), api('GET', '/element-sets'), api('GET', '/usage'),
      api('GET', '/codes'), api('GET', '/bindings'), api('GET', '/rules'), api('GET', '/protocols'), api('GET', '/prefs')]);
    Store.me = me;
    const full = await pool(list, 6, (x) => api('GET', '/cases/' + x.id));
    Object.keys(snap).forEach((k) => delete snap[k]);
    S.cases = full.map(fromServerCase);
    S.sets = sets.filter((s) => s.source === 'user').map((s) => { snap['set:' + s.setId] = { ver: s.version }; return Object.assign({}, s.body, { version: s.version }); });
    S.usage = usage;
    S.codes = {}; codes.forEach((c) => { S.codes[c.system + '|' + c.code] = c.display; snap['code:' + c.system + '|' + c.code] = c.display; });
    S.binds = {}; binds.forEach((b) => { S.binds[b.setId + '|' + b.fieldId] = { system: b.system, code: b.code, display: b.display }; });
    S.rules = {};
    Object.keys(rules).forEach((ow) => { S.rules[ow] = rules[ow].map((r) => {
      const rule = Object.assign({}, r.body, { enabled: !!r.enabled }); snap['rule:' + ow + '|' + r.ruleId] = { ver: r.version, data: ruleBody(rule), enabled: !!r.enabled }; return rule; }); });
    S.protocols = {}; Object.keys(protos).forEach((sid) => { S.protocols[sid] = protos[sid].body; snap['proto:' + sid] = { ver: protos[sid].version, data: clone(protos[sid].body) }; });
    S.prefs = prefs; Store.ready = true; notify();
  };

  Store.setMode = function (m) { try { g.localStorage.setItem('storeMode', m === 'local' ? 'local' : 'server'); } catch (e) { /* ignore */ } g.location && g.location.reload(); };
  Store._test = { S, snap, Q, conflicts, failed, metaOf, fromServerCase };
  g.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
