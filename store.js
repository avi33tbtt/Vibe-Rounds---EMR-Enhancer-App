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
  const LS = { cases: 'cases', sets: 'sets', usage: 'setUsage', codes: 'codes', codeMeta: 'codeMeta', binds: 'binds', rules: 'rules', protocols: 'protocols', setHist: 'setHist' };
  const PREF_LS = { pinned: 'pinned', mypts: 'mypts' };

  const Store = {
    mode: (function () { try { return g.localStorage.getItem('storeMode') === 'local' ? 'local' : 'server'; } catch (e) { return 'server'; } })(),
    base: '', ready: false, me: null,
    reasons: {},                                   // rowId -> reason typed when a reading is removed ("entered in error")
    hooks: { onStatus() {}, onConflict() {}, onUnauthorized() {}, onCaseReloaded() {}, onChanges() {}, onSetVersion() {}, toast() {}, rowTime() { return null; } },
  };
  const S = { cases: [], sets: [], usage: {}, codes: {}, codeMeta: {}, binds: {}, rules: {}, protocols: {}, prefs: {}, setHist: {} };
  const snap = {};                                  // entity key -> what the server last confirmed
  const Q = []; let running = false, timer = null, delay = 2000, savedAt = null, retrying = false;
  const failed = {}, conflicts = {};
  const warned = {};
  const ASOF = {};                                  // caseId -> the server time that case was last read at (chunk 37a: where /changes starts)
  const grpOf = (key) => key.slice(key.indexOf(':') + 1).split('|')[0];

  // ---------------------------------------------------------------- API client (chunk 32d1: session, CSRF, 401)
  // One CSRF token per login session (GET /api/csrf), sent as X-CSRF-Token on POST, PUT, PATCH and DELETE except login and logout.
  // A 403 "csrf" fetches a fresh token and retries that request once. A 401 (not from the login call itself) calls the login hook.
  const WRITES = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 }, NO_CSRF = { '/login': 1, '/logout': 1 };
  let csrf = null, csrfBusy = null, needLogin = false, wrongUser = false;
  async function send(method, path, body, token) {
    let res; const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-CSRF-Token'] = token;
    try {
      res = await fetch(Store.base + '/api' + path, { method, credentials: 'same-origin', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) { const er = new Error('Cannot reach the server'); er.network = true; throw er; }
    let data = null;
    if (res.status !== 204) { try { data = await res.json(); } catch (e) { /* not JSON */ } }
    if (!res.ok) {
      const er = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status);
      er.status = res.status; er.code = data && data.error && data.error.code; er.current = data && data.current; er.body = data;
      throw er;
    }
    return data;
  }
  function getCsrf(force) {
    if (csrf && !force) return Promise.resolve(csrf);
    if (!csrfBusy) csrfBusy = send('GET', '/csrf').then((r) => { csrf = r && r.token; return csrf; }).finally(() => { csrfBusy = null; });
    return csrfBusy;
  }
  async function api(method, path, body, retried) {
    const needs = !!WRITES[method] && !NO_CSRF[path];
    try {
      return await send(method, path, body, needs ? await getCsrf(false) : null);
    } catch (er) {
      if (er.status === 403 && er.code === 'csrf' && needs && !retried) { csrf = null; return api(method, path, body, true); }
      if (er.status === 401 && path !== '/login') { csrf = null; needLogin = true; try { Store.hooks.onUnauthorized(er); } catch (x) { /* UI */ } }
      throw er;
    }
  }
  Store.api = api;

  // ---------------------------------------------------------------- session user and role (chunk 32d2)
  // The server stamps who approved, verified or signed; the screen only shows the session user. Demo mode has no session, so it keeps typed names.
  // Store.can() is for hiding controls only. The server checks every request, and a refused one still shows a plain message (see the 403 handling below).
  Store.who = () => (Store.mode === 'server' && Store.me && Store.me.name) || null;
  Store.can = (action) => { if (Store.mode !== 'server' || !Store.me || !Array.isArray(Store.me.allowed)) return true; return Store.me.allowed.includes(action); };

  // ---------------------------------------------------------------- status
  function status() {
    const nc = Object.keys(conflicts).length, nf = Object.keys(failed).length;
    const state = needLogin && Store.mode === 'server' ? 'login' : nc ? 'conflict' : retrying ? 'retry' : nf ? 'failed' : (Q.length || running) ? 'saving' : 'saved';
    return { state, pending: Q.length, savedAt, conflicts: Object.assign({}, conflicts), failed: Object.assign({}, failed),
      text: Store.mode === 'local' ? 'Demo mode: saved in this browser' :
        state === 'saving' ? 'Saving…' : state === 'saved' ? (savedAt ? 'Saved ' + savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Saved') :
        state === 'login' ? (Q.length || Object.keys(failed).length ? 'NOT SAVED: sign in to send your changes' : 'Signed out') : state === 'retry' ? 'NOT SAVED: will retry' : state === 'conflict' ? 'NOT SAVED: changed by someone else' : 'NOT SAVED: ' + Object.values(failed)[0] };
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
    if (running || retrying || needLogin) return;
    running = true; notify();
    while (Q.length) {
      const op = Q[0]; op.started = true;
      try { await op.run(); Q.shift(); delay = 2000; savedAt = new Date(); }
      catch (e) {
        if (e.status === 401) { op.started = false; running = false; needLogin = true; notify(); return; }   // signed out: keep every unsent change, resume after login
        if (e.status === 409) {
          Q.shift(); const grp = grpOf(op.key);
          conflicts[grp] = { entity: op.key, current: e.current, message: e.message, code: e.code };
          for (let i = Q.length - 1; i >= 0; i--) if (grpOf(Q[i].key) === grp) Q.splice(i, 1);
          try { Store.hooks.onConflict(op.key, e.current, conflicts[grp]); } catch (x) { /* UI */ }
        } else if (e.network || !e.status || e.status >= 500) {     // server down or flaky: keep the op, retry in order
          op.started = false; running = false; retrying = true; notify();
          timer = setTimeout(() => { retrying = false; pump(); }, delay); delay = Math.min(delay * 2, 30000);
          return;
        } else {                                                    // 400/403/404/422: will not succeed by retrying
          Q.shift(); failed[op.key] = e.message;
          if (e.status === 403 && e.code === 'forbidden') { try { Store.hooks.toast(e.message); } catch (x) { /* UI */ } }   // one plain sentence naming the action, never silent (32d2)
        }
      }
      notify();
    }
    running = false; notify();
  }
  Store.retry = () => { if (needLogin) { try { Store.hooks.onUnauthorized(); } catch (x) { /* UI */ } return; } clearTimeout(timer); retrying = false; delay = 2000; pump(); };
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

  function fromServerCase(sc, dry) {
    const SN = dry ? {} : snap;                       // dry: build the case shape only, leave the confirmed-by-server snapshot alone
    const id = sc.id, c = { id, patient: sc.patient || { name: '', ageSex: '', bed: '', mrn: '' }, narrative: sc.narrative || '', applied: sc.applied || [],
      pathways: sc.pathways || [], alertLog: sc.alertLog || [], values: {}, notes: [], ns: true, rp: true, updatedAt: sc.updatedAt, saved: sc.updatedAt };
    if (Array.isArray(sc.pinned)) c.pinned = sc.pinned;
    c.patientId = sc.patientId || null; c.encounterId = sc.encounterId || null;     // chunk 34b1: set by the server's link route, never typed
    c.patientRecord = sc.patientRecord || null; c.encounterRecord = sc.encounterRecord || null;   // chunk 34c: read-only display copies of the real patient and encounter; never diffed or sent back
    if (!dry) { ASOF[id] = sc.asOf || null; for (const k of Object.keys(snap)) if (grpOf(k) === id) delete snap[k]; }
    SN['case:' + id] = { ver: sc.version, data: metaOf(c) };
    for (const k of Object.keys(sc.values || {})) {
      const v = sc.values[k], i = k.indexOf('/@');
      if (i > 0 && Array.isArray(v)) {
        c.values[k] = v.map((r) => {
          const row = strip(r); row.__id = r.__id; row.__by = r.__by; row.__at = r.__at;
          SN['row:' + id + '|' + r.__id] = { ver: r.__v, data: strip(r), time: r.__time || null, setId: k.slice(0, i), groupId: k.slice(i + 2) };
          return row;
        });
      } else {
        SN['val:' + id + '|' + k] = { ver: (sc.valueVersions || {})[k] || 1, data: v };
        if (v !== null) c.values[k] = v;
      }
    }
    c.notes = (sc.notes || []).map((n) => {
      SN['note:' + id + '|' + n.id] = { ver: n.version, data: noteData({ type: n.type, setId: n.setId, text: n.text, status: n.status, amends: n.amends, reason: n.reason }) };
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
    const patch = {}; META.forEach((k) => { if (k !== 'alertLog' && !eq(sn.data[k], m[k])) patch[k] = m[k]; });   // 35b: acknowledgements are their own server records (Store.ackAlert), never part of a case PATCH
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
    delete conflicts[id]; delete REVIEW[id]; if (LIVE && LIVE.id === id) LIVE.since = null;
    const c = fromServerCase(await api('GET', '/cases/' + id));
    const i = S.cases.findIndex((x) => x.id === id); if (i >= 0) S.cases[i] = c; else S.cases.push(c);
    notify(); Store.hooks.onCaseReloaded(id, clone(c)); return clone(c);
  };

  // ---------------------------------------------------------------- conflict review (chunk 31c)
  // Three-way compare per item: base = what the server last confirmed to this browser, mine = the cache, theirs = the server now.
  // Only a true conflict (both sides changed the same item differently) needs a choice. Whatever only I changed is kept and re-sent,
  // whatever only they changed is taken. Nothing is sent until the person resolves; then only items kept as "mine" go out, against
  // the server's current version numbers. Never last-write-wins.
  const REVIEW = {};
  const CASE_KEY = /^(case|row|val|note|rowerr|notedel):/;
  Store.conflictInfo = (id) => (conflicts[id] ? { entity: conflicts[id].entity, message: conflicts[id].message, isCase: CASE_KEY.test(conflicts[id].entity) } : null);
  const decide = (it, b, m, t) => {
    it.base = b; it.mine = m; it.theirs = t;
    it.state = eq(m, t) ? 'same' : eq(m, b) ? 'theirs' : eq(t, b) ? 'mine' : 'conflict';
    return it;
  };
  const rowsIn = (c) => { const o = {}; for (const k of Object.keys(c.values || {})) { const i = k.indexOf('/@'); if (i > 0 && Array.isArray(c.values[k])) c.values[k].forEach((r) => { if (r && r.__id) o[r.__id] = { setId: k.slice(0, i), groupId: k.slice(i + 2), data: strip(r) }; }); } return o; };
  function diffCase(id, mine, theirs) {
    const items = [], bs = (k) => (snap[k] ? snap[k].data : undefined);
    const bm = bs('case:' + id) || {}, mm = metaOf(mine), tm = metaOf(theirs);
    META.forEach((f) => items.push(decide({ kind: 'field', ref: f, key: 'f:' + f }, bm[f], mm[f], tm[f])));
    const vk = new Set();                                              // single values (not repeat groups)
    const addV = (o) => Object.keys(o || {}).forEach((k) => { if (k.indexOf('/@') < 0) vk.add(k); });
    addV(mine.values); addV(theirs.values); Object.keys(snap).forEach((k) => { if (k.startsWith('val:' + id + '|')) vk.add(k.slice(k.indexOf('|') + 1)); });
    const nz = (v) => (v === undefined ? null : v);
    vk.forEach((k) => items.push(decide({ kind: 'value', ref: k, key: 'v:' + k }, nz(bs('val:' + id + '|' + k)), nz((mine.values || {})[k]), nz((theirs.values || {})[k]))));
    const mr = rowsIn(mine), tr = rowsIn(theirs), ids = new Set(Object.keys(mr).concat(Object.keys(tr)));
    Object.keys(snap).forEach((k) => { if (k.startsWith('row:' + id + '|')) ids.add(k.slice(k.indexOf('|') + 1)); });
    ids.forEach((rid) => {
      const sn = snap['row:' + id + '|' + rid], m = mr[rid], t = tr[rid], where = m || t || sn;
      const it = { kind: 'row', setId: where.setId, groupId: where.groupId, ref: rid, key: 'r:' + rid };
      const b = sn ? sn.data : undefined, md = m ? m.data : null, td = t ? t.data : null;
      if (sn && !t) { if (m && !eq(md, b)) items.push(Object.assign(decide(it, b, md, null), { state: 'theirs', why: 'Someone marked this reading entered in error. Your edit to it is not kept.' })); return; }
      if (!sn && !m) return;                                           // new from someone else: it simply arrives
      items.push(decide(it, sn ? b : null, md, sn ? td : null));       // new reading of mine (no base): kept and sent
    });
    const nd = (n) => noteData(n), mn = {}, tn = {};
    (mine.notes || []).forEach((n) => { mn[n.id] = n; }); (theirs.notes || []).forEach((n) => { tn[n.id] = n; });
    new Set(Object.keys(mn).concat(Object.keys(tn), Object.keys(snap).filter((k) => k.startsWith('note:' + id + '|')).map((k) => k.slice(k.indexOf('|') + 1)))).forEach((nid) => {
      const sn = snap['note:' + id + '|' + nid], m = mn[nid], t = tn[nid], it = { kind: 'note', ref: nid, key: 'n:' + nid };
      if (sn && !t) { if (m && !eq(nd(m), sn.data)) items.push(Object.assign(decide(it, sn.data, nd(m), null), { state: 'theirs', why: 'Someone removed this note. Your edit to it is not kept.' })); return; }
      if (!sn && !m) return;
      decide(it, sn ? sn.data : null, m ? nd(m) : null, sn ? nd(t) : null);
      if (it.state === 'conflict' && t && t.status === 'signed') { it.state = 'theirs'; it.why = 'This note was signed by someone else and is read-only. Your edit is not kept.'; }
      items.push(it);
    });
    return items.filter((i) => i.state === 'conflict' || i.state === 'mine' || (i.state === 'theirs' && i.why));
  }
  Store.conflictReview = async function (id) {                         // fetches the server copy now; changes nothing
    const info = conflicts[id]; if (!info || !CASE_KEY.test(info.entity)) throw new Error('There is no patient conflict to review');
    const mine = caseById(id); if (!mine) throw new Error('This patient is no longer open here');
    const sc = await api('GET', '/cases/' + id);
    const items = diffCase(id, mine, fromServerCase(sc, true));
    REVIEW[id] = { sc, items };
    return clone({ message: info.message, theirsVersion: sc.version, items });
  };
  function takeMine(merged, mine, it) {
    if (it.kind === 'field') { if (it.ref === 'pinned') { if (Array.isArray(mine.pinned)) merged.pinned = clone(mine.pinned); else delete merged.pinned; } else merged[it.ref] = clone(mine[it.ref]); }
    else if (it.kind === 'value') { const v = (mine.values || {})[it.ref]; if (v === undefined) delete merged.values[it.ref]; else merged.values[it.ref] = clone(v); }
    else if (it.kind === 'row') {
      const key = it.setId + '/@' + it.groupId, arr = (merged.values[key] = merged.values[key] || []), i = arr.findIndex((r) => r.__id === it.ref);
      const mr = ((mine.values || {})[key] || []).find((r) => r.__id === it.ref);
      if (!mr) { if (i >= 0) arr.splice(i, 1); }                       // I removed it: the queue sends "entered in error" with the reason typed earlier
      else { const c = clone(mr); if (i >= 0) { c.__by = arr[i].__by; c.__at = arr[i].__at; arr[i] = c; } else arr.push(c); }
    } else if (it.kind === 'note') {
      const mn = (mine.notes || []).find((n) => n.id === it.ref), i = merged.notes.findIndex((n) => n.id === it.ref);
      if (!mn) { if (i >= 0) merged.notes.splice(i, 1); } else if (i >= 0) Object.assign(merged.notes[i], { text: mn.text, status: mn.status, signedBy: mn.signedBy, signedAt: mn.signedAt }); else merged.notes.push(clone(mn));
    }
  }
  Store.resolveConflict = function (id, picks) {                       // picks: {item key: 'mine' | 'theirs'}; every true conflict needs one
    const rv = REVIEW[id], mine = caseById(id); picks = picks || {};
    if (!rv || !mine || !conflicts[id]) throw new Error('Review the differences first');
    if (rv.items.some((i) => i.state === 'conflict' && picks[i.key] !== 'mine' && picks[i.key] !== 'theirs')) throw new Error('Choose mine or theirs for every item that differs');
    const merged = fromServerCase(rv.sc);                              // the snapshot now holds the server's versions
    rv.items.forEach((it) => { if (it.state === 'mine' || (it.state === 'conflict' && picks[it.key] === 'mine')) takeMine(merged, mine, it); });
    const i = S.cases.findIndex((x) => x.id === id); if (i >= 0) S.cases[i] = merged; else S.cases.push(merged);
    delete conflicts[id]; delete REVIEW[id]; Object.keys(failed).forEach((k) => { if (grpOf(k) === id) delete failed[k]; });
    reconcile(merged); notify(); Store.hooks.onCaseReloaded(id, clone(merged)); return clone(merged);
  };

  // ---------------------------------------------------------------- reference data (sync reads, queued writes)
  Store.userSets = () => clone(S.sets);
  // Older versions stay readable: a case resolves a set by the version recorded when it was applied.
  // setVersion is a synchronous read; in server mode a miss starts one fetch and calls hooks.onSetVersion when it lands.
  const hk = (id, n) => id + '@' + n, histLoading = {};
  Store.setVersion = function (id, n) {
    n = +n; if (!IDENT.test(id) || !Number.isInteger(n) || n < 1) return null;
    const cur = S.sets.find((x) => x.setId === id); if (cur && (+cur.version || 1) === n) return clone(cur);
    const h = S.setHist[hk(id, n)]; if (h) return clone(h);
    if (Store.mode === 'server' && Store.ready && !histLoading[hk(id, n)]) {
      histLoading[hk(id, n)] = 1;
      api('GET', '/element-sets/' + id + '/versions/' + n).then((r) => {
        S.setHist[hk(id, n)] = Object.assign({}, r.body, { setId: id, version: r.version });
        try { Store.hooks.onSetVersion(id, n, true); } catch (e) { /* UI */ }
      }).catch(() => { setTimeout(() => { delete histLoading[hk(id, n)]; }, 30000); try { Store.hooks.onSetVersion(id, n, false); } catch (e) { /* UI */ } });
    }
    return null;
  };
  Store.saveSet = function (s) {
    const i = S.sets.findIndex((x) => x.setId === s.setId); const c = clone(s);
    if (i >= 0 && (+S.sets[i].version || 1) !== (+c.version || 1)) {      // keep the version being replaced
      S.setHist[hk(s.setId, +S.sets[i].version || 1)] = clone(S.sets[i]);
      if (Store.mode === 'local') lsSet(LS.setHist, S.setHist);
    }
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
  Store.codeMeta = () => clone(S.codeMeta);             // {'system|code': {addedBy, addedAt, verifiedLive:{ok,checkedAt,display?}|null}} (server mode; Demo mode keeps live results only)
  const splitKey = (k) => { const i = k.indexOf('|'); return i < 1 ? null : [k.slice(0, i), k.slice(i + 1)]; };
  // A new key is POSTed. If the server already has that code (409) the server's entry wins: nothing is overwritten, the person is told.
  Store.saveCodes = function (t) {
    S.codes = clone(t);
    if (Store.mode === 'local') return lsSet(LS.codes, S.codes);
    Object.keys(t).forEach((k) => {
      const sp = splitKey(k); if (!sp || !sp[1] || snap['code:' + k] !== undefined) return;   // already on the server
      enqueue('code:' + k, async () => {
        const d = S.codes[k]; if (d === undefined) return;
        try { const c = (await api('POST', '/codes', { system: sp[0], code: sp[1], display: String(d) })) || {}; snap['code:' + k] = c.display || String(d); S.codeMeta[k] = { addedBy: c.addedBy, addedAt: c.addedAt, verifiedLive: c.verifiedLive || null }; }
        catch (e) {
          if (e.status !== 409 || !e.current) throw e;
          snap['code:' + k] = e.current.display; S.codes[k] = e.current.display; S.codeMeta[k] = { addedBy: e.current.addedBy, addedAt: e.current.addedAt, verifiedLive: e.current.verifiedLive || null };
          Store.hooks.toast('That code was already in the verified table: the existing entry was kept' + (e.current.display !== d ? ' (its display differs from what you typed).' : '.'));
        }
      });
    });
    return true;
  };
  // Result of "Verify live" for a code that is in the table. Server mode: the server stamps who and when. Demo mode: kept in this browser.
  Store.saveLiveResult = function (system, code, ok, display) {
    const k = system + '|' + code, live = { ok: !!ok, checkedAt: new Date().toISOString() }; if (display) live.display = String(display);
    S.codeMeta[k] = Object.assign({}, S.codeMeta[k], { verifiedLive: live });
    if (Store.mode === 'local') return lsSet(LS.codeMeta, S.codeMeta);
    enqueue('codelive:' + k, async () => { const c = await api('POST', '/codes/' + encodeURIComponent(system) + '/' + encodeURIComponent(code) + '/live', { ok: !!ok, display: display ? String(display) : undefined });
      S.codeMeta[k] = { addedBy: c.addedBy, addedAt: c.addedAt, verifiedLive: c.verifiedLive || null }; });
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
  const ruleBody = (r) => { const b = clone(r); delete b.enabled; if (b.provenance) { delete b.provenance.verifiedBy; delete b.provenance.verifiedAt; } return b; };   // no typed name in a request body: the server stamps the approver (32d2)
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

  // chunk 35b: acknowledge one alert. Server mode only (Demo mode keeps its own list). The server stamps the user and time; the entry is shown at once
  // and is filled in with the server's values when the write lands. Returns the entry (so the screen can add it to its own copy of the case) or false.
  Store.ackAlert = function (caseId, a) {
    if (Store.mode !== 'server') return false;
    const c = caseById(caseId); if (!c || !a || !IDENT.test(a.ruleId || '') || !IDENT.test(a.setId || '') || typeof a.sig !== 'string' || !a.sig || a.sig.length > 500) return false;
    const e = { ruleId: a.ruleId, setId: a.setId, sig: a.sig, ackedAt: new Date().toISOString(), by: null, byName: Store.who(), source: 'user' };
    c.alertLog = (c.alertLog || []).concat([e]).slice(-2000);
    enqueue('ack:' + caseId + '|' + uid(), async () => {
      const r = await api('POST', '/cases/' + caseId + '/alert-acks', { ruleId: a.ruleId, setId: a.setId, sig: a.sig });
      e.ackedAt = r.ackedAt; e.by = r.by; e.byName = r.byName; e.id = r.id;
    });
    return e;
  };
  Store.protocols = () => clone(S.protocols);
  Store.protocol = (sid) => clone(S.protocols[sid]);
  const protoBody = (p) => { const b = clone(p); delete b.verifiedBy; delete b.verifiedAt; return b; };   // no typed name in a request body (32d2)
  Store.saveProtocol = function (sid, p) {
    S.protocols[sid] = clone(p);
    if (Store.mode === 'local') return lsSet(LS.protocols, S.protocols);
    if (!IDENT.test(sid)) return false;
    enqueue('proto:' + sid, async () => {
      const cur = S.protocols[sid]; if (!cur) return; const sn = snap['proto:' + sid] || {}, body = protoBody(cur), wants = !!String(cur.verifiedBy || '').trim();
      if (sn.data && eq(sn.data, body) && !!sn.approved === wants) return;
      let ver = sn.ver;
      // Saving a changed body always lands unverified. A verified mark with nothing else changed only needs the approve call; clearing it needs a save.
      if (!sn.data || !eq(sn.data, body) || (!wants && sn.approved)) ver = (await api('PUT', '/protocols/' + sid, { body, expectedVersion: sn.data ? sn.ver : 0 })).version;
      if (wants) ver = (await api('POST', '/protocols/' + sid + '/approve', { expectedVersion: ver })).version;   // the server stamps the signed-in user
      snap['proto:' + sid] = { ver, data: body, approved: wants };
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
      S.usage = isObj(lsGet(LS.usage, {})) ? lsGet(LS.usage, {}) : {}; S.codes = isObj(lsGet(LS.codes, {})) ? lsGet(LS.codes, {}) : {}; S.codeMeta = isObj(lsGet(LS.codeMeta, {})) ? lsGet(LS.codeMeta, {}) : {};
      S.binds = isObj(lsGet(LS.binds, {})) ? lsGet(LS.binds, {}) : {}; S.rules = isObj(lsGet(LS.rules, {})) ? lsGet(LS.rules, {}) : {};
      S.protocols = isObj(lsGet(LS.protocols, {})) ? lsGet(LS.protocols, {}) : {}; S.setHist = isObj(lsGet(LS.setHist, {})) ? lsGet(LS.setHist, {}) : {};
      S.prefs = {}; Object.keys(PREF_LS).forEach((k) => { const v = lsGet(PREF_LS[k], undefined); if (v !== undefined) S.prefs[k] = v; });
      Store.me = { id: 'demo', name: 'Demo user', role: 'admin' }; Store.ready = true; notify(); return;
    }
    const sess = await api('GET', '/session');        // 401 = not signed in: the login hook runs and init stops here
    needLogin = false;
    if (sess && sess.mustChangePassword) {            // chunk 32e2: a temporary password must be changed first; nothing else is loaded until then
      Store.me = Object.assign({}, sess); const er = new Error('You must change your temporary password before continuing.'); er.code = 'must_change'; throw er;
    }
    const [me, list, sets, usage, codes, binds, rules, protos, prefs] = await Promise.all([api('GET', '/me'), api('GET', '/cases'), api('GET', '/element-sets'), api('GET', '/usage'),
      api('GET', '/codes'), api('GET', '/bindings'), api('GET', '/rules'), api('GET', '/protocols'), api('GET', '/prefs')]);
    Store.me = me;
    const full = await pool(list, 6, (x) => api('GET', '/cases/' + x.id));
    Object.keys(snap).forEach((k) => delete snap[k]);
    S.cases = full.map(fromServerCase);
    S.sets = sets.filter((s) => s.source === 'user').map((s) => { snap['set:' + s.setId] = { ver: s.version }; return Object.assign({}, s.body, { version: s.version }); });
    S.usage = usage;
    S.codes = {}; S.codeMeta = {}; codes.forEach((c) => { const k = c.system + '|' + c.code; S.codes[k] = c.display; snap['code:' + k] = c.display; S.codeMeta[k] = { addedBy: c.addedBy, addedAt: c.addedAt, verifiedLive: c.verifiedLive || null }; });
    S.binds = {}; binds.forEach((b) => { S.binds[b.setId + '|' + b.fieldId] = { system: b.system, code: b.code, display: b.display }; });
    S.rules = {};
    Object.keys(rules).forEach((ow) => { S.rules[ow] = rules[ow].map((r) => {
      const rule = Object.assign({}, r.body, { enabled: !!r.enabled }); if (r.enabled && r.verifiedBy) rule.provenance = Object.assign({}, rule.provenance, { verifiedBy: r.verifiedByName || 'a user', verifiedAt: r.verifiedAt || '' });
      snap['rule:' + ow + '|' + r.ruleId] = { ver: r.version, data: ruleBody(rule), enabled: !!r.enabled }; return rule; }); });
    S.protocols = {}; Object.keys(protos).forEach((sid) => { const x = protos[sid], b = protoBody(x.body), ok = !!x.verifiedBy; S.protocols[sid] = Object.assign(clone(b), ok ? { verifiedBy: x.verifiedByName || 'a user', verifiedAt: x.verifiedAt || '' } : { verifiedBy: '' }); snap['proto:' + sid] = { ver: x.version, data: b, approved: ok }; });
    S.prefs = prefs; Store.ready = true; notify();
  };

  // ---------------------------------------------------------------- session (chunk 32d1)
  /** Sign in. The password is only passed through here, never stored. Unsent changes made by another user are never sent as this one. */
  Store.login = async function (username, password) {
    const me = await api('POST', '/login', { username, password });
    csrf = null;
    if (Store.me && Store.ready && Q.length && Store.me.id !== me.id) {
      try { await api('POST', '/logout'); } catch (e) { /* ignore */ }
      csrf = null; wrongUser = true;
      const er = new Error('There are unsent changes made by ' + (Store.me.name || 'another user') + '. Sign in as that user to send them.'); er.code = 'other_user'; throw er;
    }
    try { await getCsrf(true); } catch (e) { /* fetched again on the first write */ }
    Store.me = Object.assign({}, Store.me || {}, me); needLogin = false; wrongUser = false; notify();
    return me;
  };
  /** Continue sending the kept queue after a successful login. */
  Store.resume = function () { if (wrongUser || needLogin) return; notify(); pump(); };
  Store.needsLogin = () => needLogin;
  /** Sign out. Refuses while changes are unsent unless force is true. Clears every cached record. */
  Store.logout = async function (force) {
    if (!force && Store.pending()) { const er = new Error('Some changes have not been saved yet.'); er.code = 'unsent'; throw er; }
    try { await api('POST', '/logout'); } catch (e) { if (!e.network && e.status !== 401) throw e; }
    csrf = null; needLogin = true; Q.length = 0; clearTimeout(timer); retrying = false; running = false;
    for (const k of Object.keys(failed)) delete failed[k]; for (const k of Object.keys(conflicts)) delete conflicts[k];
    Object.keys(snap).forEach((k) => delete snap[k]);
    Object.assign(S, { cases: [], sets: [], usage: {}, codes: {}, codeMeta: {}, binds: {}, rules: {}, protocols: {}, prefs: {}, setHist: {} });
    Store.me = null; Store.ready = false; notify();
  };

  // ---------------------------------------------------------------- users and own password (chunk 32e2)
  // Passwords pass through here and are never stored. A temporary password the server generated is returned to the caller once; Store keeps no copy.
  Store.mustChange = () => Store.mode === 'server' && !!Store.me && Store.me.mustChangePassword === true;
  Store.changePassword = async function (currentPassword, newPassword) {
    await api('POST', '/password', { currentPassword, newPassword });
    if (Store.me) Store.me.mustChangePassword = false; notify();
  };
  Store.users = {
    list: () => api('GET', '/users'),
    create: (b) => api('POST', '/users', b),
    deactivate: (id) => api('POST', '/users/' + encodeURIComponent(id) + '/deactivate', {}),
    reactivate: (id) => api('POST', '/users/' + encodeURIComponent(id) + '/reactivate', {}),
    resetPassword: (id, password) => api('POST', '/users/' + encodeURIComponent(id) + '/reset-password', password ? { password } : {}),
    setRole: (id, role) => api('POST', '/users/' + encodeURIComponent(id) + '/role', { role }),
  };

  // ---------------------------------------------------------------- patients and encounters (chunk 34b1)
  // Browser side of the 34a routes (API.md: 'Patients, encounters and linking a case'). Server mode only. Nothing here is cached in the
  // cache, in the write queue or in localStorage: every call goes straight to the server and the caller shows the answer. Demo mode keeps the
  // typed demo fields, so every method rejects with code 'demo_mode'. The server decides what a role may see or do (a 403 is shown as written).
  const pfail = (code, msg) => { const er = new Error(msg); er.code = code; return er; };
  const pid = (id, what) => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw pfail('bad_id', 'A valid ' + what + ' id is required'); return encodeURIComponent(id); };
  const pick = (o, keys) => { const r = {}; keys.forEach((k) => { if (o && o[k] !== undefined) r[k] = o[k]; }); return r; };
  const PAT_FIELDS = ['name', 'sex', 'dateOfBirth', 'ageYears', 'phone', 'nationalId'];
  const serverOnly = (fn) => async (...a) => {
    if (Store.mode !== 'server') throw pfail('demo_mode', 'Patient records are not available in demo mode');
    try { return await fn(...a); } catch (er) { if (er && er.body && er.body.candidates) er.candidates = er.body.candidates; throw er; }   // a 409 possible_duplicate carries the matches
  };
  const needVer = (b, what) => { if (!b || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 1) throw pfail('version_required', 'The version you last saw of this ' + what + ' is required'); return b.expectedVersion; };
  const needReason = (b) => { const r = b && typeof b.reason === 'string' ? b.reason.trim() : ''; if (!r) throw pfail('reason_required', 'A reason is required'); return r; };
  const busyCase = (id) => Q.some((o) => grpOf(o.key) === id);

  // ---------------------------------------------------------------- AI through the server (chunk 36b)
  // The browser never talks to a model. preview() asks the server for the EXACT text it would send (identifiers already removed) and sends nothing;
  // run() is the real call and must only follow a click on Send. Nothing here is cached or saved: the caller shows the answer and a clinician saves it.
  // Store.me.ai (from /me) is true only when an admin switched AI on and a model is configured; the buttons mirror it, the server still checks every call.
  const AI_ROUTES = { schema: '/llm/schema', suggest: '/llm/suggest', ruleDraft: '/llm/rule-draft' };
  const aiRoute = (kind) => { if (Store.mode !== 'server') throw pfail('demo_mode', 'AI needs the server and is not available in demo mode'); if (!AI_ROUTES[kind]) throw pfail('bad_kind', 'Unknown AI request'); return AI_ROUTES[kind]; };
  const aiFail = (er) => { if (er && er.status === 403 && er.code === 'ai_disabled' && Store.me) { Store.me.ai = false; notify(); } throw er; };   // an admin switched it off meanwhile: hide the buttons
  Store.ai = {
    /** True when the AI buttons should be shown: server mode, switched on by an admin, a model configured, and this role may use `kind` (optional). */
    available: (kind) => Store.mode === 'server' && !!Store.me && Store.me.ai === true && (!kind || Store.can({ schema: 'ai.schema', suggest: 'ai.suggest', ruleDraft: 'ai.rule_draft' }[kind])),
    /** -> { sent, removed, removedCount, bytes, note }. Nothing is sent to the model, nothing is audited. */
    preview: async (kind, body) => { const p = aiRoute(kind); try { return await api('POST', p, Object.assign({}, body, { preview: true })); } catch (er) { return aiFail(er); } },
    /** The real call. Answers the validated draft (schema: {schema, warnings}; suggest: {suggestions, pathways}; ruleDraft: {draft}). Never saves anything. */
    run: async (kind, body) => { const p = aiRoute(kind); const b = Object.assign({}, body); delete b.preview; try { return await api('POST', p, b); } catch (er) { return aiFail(er); } },
    /** Admin only. */
    status: async () => { if (Store.mode !== 'server') throw pfail('demo_mode', 'AI needs the server and is not available in demo mode'); return api('GET', '/admin/ai'); },
    setEnabled: async (on) => { if (Store.mode !== 'server') throw pfail('demo_mode', 'AI needs the server and is not available in demo mode'); const r = await api('PUT', '/admin/ai', { enabled: on === true }); if (Store.me) { Store.me.ai = r.enabled === true; notify(); } return r; },
  };

  Store.patients = {
    /** Name, MRN or phone. Under 2 characters nothing is asked and [] is returned (the server needs at least 2). */
    search: serverOnly(async (q, limit) => {
      q = String(q == null ? '' : q).trim(); if (q.length < 2) return [];
      if (q.length > 100) throw pfail('query_too_long', 'Search text can be at most 100 characters');
      const n = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : null;
      return api('GET', '/patients?q=' + encodeURIComponent(q) + (n ? '&limit=' + n : ''));
    }),
    get: serverOnly((id) => api('GET', '/patients/' + pid(id, 'patient'))),
    /** Register. A 409 possible_duplicate has error.candidates. Send the same body again with confirmDifferent:true, but only after the person confirms. */
    create: serverOnly((b) => api('POST', '/patients', Object.assign(pick(b, PAT_FIELDS), b && b.confirmDifferent === true ? { confirmDifferent: true } : {}))),
    /** A correction: expectedVersion and a reason are always required. A null phone or nationalId clears it. */
    update: serverOnly((id, b) => { const body = Object.assign({ expectedVersion: needVer(b, 'patient'), reason: needReason(b) }, pick(b, PAT_FIELDS)); return api('PATCH', '/patients/' + pid(id, 'patient'), body); }),
    encounters: serverOnly((patientId) => api('GET', '/patients/' + pid(patientId, 'patient') + '/encounters')),
    createEncounter: serverOnly((patientId, b) => api('POST', '/patients/' + pid(patientId, 'patient') + '/encounters', pick(b, ['type', 'startAt', 'ward', 'bed', 'attendingId']))),
    updateEncounter: serverOnly((id, b) => api('PATCH', '/encounters/' + pid(id, 'encounter'), Object.assign({ expectedVersion: needVer(b, 'encounter') }, pick(b, ['ward', 'bed', 'attendingId'])))),
    closeEncounter: serverOnly((id, b) => api('POST', '/encounters/' + pid(id, 'encounter') + '/close', Object.assign({ expectedVersion: needVer(b, 'encounter') }, pick(b, ['endAt'])))),
    cancelEncounter: serverOnly((id, b) => api('POST', '/encounters/' + pid(id, 'encounter') + '/cancel', { expectedVersion: needVer(b, 'encounter'), reason: needReason(b) })),
    /** Chunk 34d: the audited export. Answers {exportedAt, case, patientFullUrl, encounterFullUrl, bundle} with the REAL FHIR Patient (and Encounter). Every call writes an audit row on the server,
     *  so nothing is cached: ask again for each export. 409 case_not_linked when the chart has no patient yet. */
    exportCase: serverOnly((caseId) => api('GET', '/cases/' + pid(caseId, 'case') + '/export')),
    /** Attach an open chart to a patient (and one of that patient's open encounters). expectedVersion is optional: it defaults to the version this
     *  browser last confirmed. The server moves the case version by one; Store records it so the next save of the chart does not conflict. */
    link: serverOnly(async (caseId, b) => {
      const cid = pid(caseId, 'case'); b = b || {};
      const sn = snap['case:' + caseId];
      if (!sn || !caseById(caseId)) throw pfail('case_not_saved', 'This chart has not been saved to the server yet. Wait for "Saved", then try again.');
      if (conflicts[caseId]) throw pfail('case_conflict', 'This chart has a conflict to resolve first.');
      if (busyCase(caseId)) throw pfail('case_unsent', 'This chart still has unsent changes. Wait for "Saved", then try again.');   // a queued save and the link would otherwise race on the version
      const ver = b.expectedVersion !== undefined ? b.expectedVersion : sn.ver;
      if (!Number.isInteger(ver) || ver < 1) throw pfail('version_required', 'The version you last saw of this chart is required');
      const r = await api('POST', '/cases/' + cid + '/link', Object.assign({ expectedVersion: ver, patientId: b.patientId }, b.encounterId ? { encounterId: b.encounterId } : {}));
      const s2 = snap['case:' + caseId]; if (s2) s2.ver = r.version;
      const c = caseById(caseId);
      if (c) {
        c.patientId = r.patientId || null; c.encounterId = r.encounterId || null;
        // chunk 34c: the caller may hand over the patient and encounter it just chose, so the banner shows real data at once; anything else is dropped, never kept stale
        const pr = b.patient && b.patient.id === c.patientId ? pick(b.patient, ['id', 'mrn', 'name', 'sex', 'dateOfBirth', 'ageEstimated']) : null;
        const er = b.encounter && b.encounter.id === c.encounterId ? pick(b.encounter, ['id', 'type', 'status', 'ward', 'bed', 'startAt', 'endAt']) : null;
        c.patientRecord = pr || (c.patientRecord && c.patientRecord.id === c.patientId ? c.patientRecord : null);
        c.encounterRecord = er || (c.encounterRecord && c.encounterRecord.id === c.encounterId ? c.encounterRecord : null);
      }
      notify(); return r;
    }),
  };


  // ---------------------------------------------------------------- live refresh (chunk 37a)
  // While a case is open, GET /cases/:id/changes?since= is polled every 10 to 15 seconds (not while the tab is hidden) and what others changed is merged in.
  // The rule that matters: NOTHING the person has typed is overwritten. Per item, "mine" is the screen's working copy (`live`, else the cache) compared with
  // the server-confirmed snapshot. If they differ (an unsent edit, a reading still being sent) or opts.editing(kind, ref) says the person has that field
  // open, the item is skipped and their later save meets the usual 409 and the conflict screen; the version in the snapshot is NOT advanced past what they saw.
  // An item whose snapshot version is already the same or newer is skipped (own writes echo back, and the cursor overlaps by a few seconds).
  // Both the cache and the working copy are changed: the screen's persist() writes its copy over the cache, and a row missing there would be sent as "entered in error".
  let LIVE = null;
  const fieldsOfCase = ['patient', 'narrative', 'applied', 'pathways', 'pinned'];
  function applyChanges(id, ch, live, opts) {
    const cache = caseById(id); if (!cache || !ch) return null;
    const cur = live || cache, targets = live && live !== cache ? [cache, live] : [cache], editing = (opts && opts.editing) || (() => false);
    const sum = { rows: 0, values: 0, notes: 0, acks: 0, case: false, skipped: 0, changed: false, latest: ch.latest || null };
    const skip = () => { sum.skipped++; };
    for (const r of ch.rows || []) {
      const key = 'row:' + id + '|' + r.id, sn = snap[key], gk = r.setId + '/@' + r.groupId;
      if (sn && sn.ver >= r.version) continue;
      const local = findRow(cur, r.id);
      if (local && (!sn || !eq(sn.data, strip(local.row)) || sn.time !== timeOf(local.setId, local.groupId, local.row)) || (local && editing('row', r.id))) { skip(); continue; }
      if (r.status !== 'active') {                                   // entered in error: drop it from the screen, and from the snapshot so no write is made for it
        let gone = !!sn;
        for (const t of targets) if (Array.isArray(t.values[gk])) { const n0 = t.values[gk].length; t.values[gk] = t.values[gk].filter((x) => x && x.__id !== r.id); if (t.values[gk].length < n0) gone = true; }
        delete snap[key]; if (gone) sum.rows++; continue;                  // the same answer comes again inside the overlap: nothing left to remove, nothing to report
      }
      const o = Object.assign({}, r.row, { __id: r.id, __by: r.enteredBy, __at: r.enteredAt });
      for (const t of targets) { const a = t.values[gk] || (t.values[gk] = []), i = a.findIndex((x) => x && x.__id === r.id); if (i >= 0) a[i] = clone(o); else a.push(clone(o)); }
      snap[key] = { ver: r.version, data: clone(r.row), time: r.rowTime || null, setId: r.setId, groupId: r.groupId }; sum.rows++;
    }
    for (const v of ch.values || []) {
      const key = 'val:' + id + '|' + v.key, sn = snap[key], mine = cur.values[v.key];
      if (sn && sn.ver >= v.version) continue;
      if (sn ? !eq(sn.data, mine === undefined ? null : mine) : mine !== undefined) { skip(); continue; }
      if (editing('value', v.key)) { skip(); continue; }
      for (const t of targets) { if (v.value === null) delete t.values[v.key]; else t.values[v.key] = clone(v.value); }
      snap[key] = { ver: v.version, data: clone(v.value) }; sum.values++;
    }
    for (const n of ch.notes || []) {
      const key = 'note:' + id + '|' + n.id, sn = snap[key], local = (cur.notes || []).find((x) => x.id === n.id);
      if (sn && sn.ver >= n.version) continue;
      if (local && (!sn || !eq(sn.data, noteData(local)) || editing('note', n.id))) { skip(); continue; }
      const o = { id: n.id, type: n.type, text: n.text || '', status: n.status, signedBy: n.signedByName || n.signedBy || '', signedAt: n.signedAt || '', createdAt: n.createdAt };
      if (n.setId) o.setId = n.setId;
      if (n.amends) { o.amends = n.amends; o.reason = n.reason || ''; }
      for (const t of targets) { t.notes = t.notes || []; const i = t.notes.findIndex((x) => x.id === n.id); if (i >= 0) t.notes[i] = clone(o); else t.notes.push(clone(o)); }
      snap[key] = { ver: n.version, data: noteData({ type: n.type, setId: n.setId, text: n.text, status: n.status, amends: n.amends, reason: n.reason }) }; sum.notes++;
    }
    for (const a of ch.acks || []) {
      let added = false;
      for (const t of targets) {
        t.alertLog = t.alertLog || [];
        if (t.alertLog.some((x) => (a.id !== undefined && x.id === a.id) || (x.ruleId === a.ruleId && x.setId === a.setId && x.sig === a.sig))) continue;
        t.alertLog = t.alertLog.concat([clone(a)]).slice(-2000); added = true;
      }
      if (added) sum.acks++;
    }
    const cs = ch.case, sc = snap['case:' + id];
    if (cs && sc && sc.ver < cs.version) {
      const mc = metaOf(cur);
      if (!fieldsOfCase.every((f) => eq(sc.data[f], mc[f])) || fieldsOfCase.some((f) => editing('case', f))) skip();
      else {
        for (const t of targets) {
          if (cs.patient) t.patient = clone(cs.patient);
          t.narrative = cs.narrative || ''; t.applied = clone(cs.applied || []); t.pathways = clone(cs.pathways || []);
          if (Array.isArray(cs.pinned)) t.pinned = clone(cs.pinned); else delete t.pinned;
          t.patientId = cs.patientId || null; t.encounterId = cs.encounterId || null;
          t.patientRecord = cs.patientRecord || null; t.encounterRecord = cs.encounterRecord || null; t.updatedAt = cs.updatedAt;
        }
        snap['case:' + id] = { ver: cs.version, data: metaOf(cache) }; sum.case = true;
      }
    }
    if (sum.acks && snap['case:' + id]) snap['case:' + id].data.alertLog = metaOf(cache).alertLog;      // acknowledgements are not part of a case PATCH: keep the snapshot level with them
    sum.changed = !!(sum.rows || sum.values || sum.notes || sum.acks || sum.case);
    return sum;
  }
  // A full case read, put in the shape of a /changes answer (first read of a case that has no cursor yet, or an answer that was cut off).
  function fullAsChanges(sc) {
    const out = { cursor: sc.asOf, truncated: false, rows: [], values: [], notes: sc.notes || [], acks: sc.alertLog || [], latest: null,
      case: { version: sc.version, narrative: sc.narrative, applied: sc.applied, pathways: sc.pathways, pinned: sc.pinned, patient: sc.patient, patientId: sc.patientId, encounterId: sc.encounterId,
        patientRecord: sc.patientRecord, encounterRecord: sc.encounterRecord, updatedAt: sc.updatedAt } };
    for (const k of Object.keys(sc.values || {})) {
      const i = k.indexOf('/@'), v = sc.values[k];
      if (i > 0 && Array.isArray(v)) v.forEach((r) => out.rows.push({ id: r.__id, setId: k.slice(0, i), groupId: k.slice(i + 2), row: strip(r), rowTime: r.__time || null, version: r.__v, status: 'active', enteredBy: r.__by, enteredAt: r.__at }));
      else out.values.push({ key: k, value: v, version: (sc.valueVersions || {})[k] || 1 });
    }
    return out;
  }
  // One poll now. Resolves to the merge summary, or null when nothing was asked (not server mode, signed out, conflict screen open, case not yet on the server).
  async function pollOnce(id) {
    if (Store.mode !== 'server' || needLogin || wrongUser || conflicts[id] || REVIEW[id] || !snap['case:' + id] || !caseById(id)) return null;
    const since = (LIVE && LIVE.id === id && LIVE.since) || ASOF[id];
    let ch;
    if (!since) { const sc = await api('GET', '/cases/' + id); ch = fullAsChanges(sc); }
    else {
      ch = await api('GET', '/cases/' + id + '/changes?since=' + encodeURIComponent(since) + '&caseVersion=' + snap['case:' + id].ver);
      if (ch.truncated) { const sc = await api('GET', '/cases/' + id); ch = fullAsChanges(sc); }
    }
    if (conflicts[id] || REVIEW[id]) return null;                    // a conflict appeared while the request was out: leave the case to the conflict screen
    const o = (LIVE && LIVE.id === id && LIVE.opts) || {}, sum = applyChanges(id, ch, o.live ? o.live() : null, o);
    ASOF[id] = ch.cursor; if (LIVE && LIVE.id === id) LIVE.since = ch.cursor;
    if (sum && (sum.changed || sum.skipped)) { try { (o.onMerged || Store.hooks.onChanges)(id, sum); } catch (e) { /* UI */ } }
    return sum;
  }
  const hiddenTab = () => !!(g.document && g.document.hidden);
  function liveSchedule() {
    if (!LIVE || LIVE.stopped) return;
    clearTimeout(LIVE.timer);
    LIVE.timer = setTimeout(liveTick, (LIVE.opts.interval || 10000) + (LIVE.opts.interval ? 0 : Math.random() * 5000));
  }
  async function liveTick() {
    const L = LIVE; if (!L || L.stopped || L.busy) return;
    if (hiddenTab()) { L.paused = true; return; }                    // no polling while hidden; the visibilitychange listener below starts it again at once
    L.busy = true;
    try { await pollOnce(L.id); } catch (e) { if (e.status === 404) { Store.live.stop(); return; } /* network or server trouble: try again next time */ }
    finally { if (LIVE === L) { L.busy = false; liveSchedule(); } }
  }
  if (g.document && g.document.addEventListener) g.document.addEventListener('visibilitychange', () => { if (LIVE && LIVE.paused && !hiddenTab()) { LIVE.paused = false; liveTick(); } });
  Store.live = {
    // opts: live() -> the screen's working copy of the case; editing(kind, ref) -> true while the person has that item open; onMerged(id, summary); interval (ms, tests only)
    start(id, opts) { Store.live.stop(); if (Store.mode !== 'server') return false; LIVE = { id, opts: opts || {}, since: null, timer: null, busy: false, paused: false, stopped: false }; if (hiddenTab()) LIVE.paused = true; else liveSchedule(); return true; },
    stop() { if (LIVE) { LIVE.stopped = true; clearTimeout(LIVE.timer); } LIVE = null; },
    now: (id) => pollOnce(id),                                       // one poll right now (the screen's Refresh, and the tests)
    active: () => (LIVE ? LIVE.id : null),
  };
  Store.applyChanges = applyChanges;

  Store.setMode = function (m) { try { g.localStorage.setItem('storeMode', m === 'local' ? 'local' : 'server'); } catch (e) { /* ignore */ } g.location && g.location.reload(); };
  Store._test = { S, snap, Q, conflicts, failed, metaOf, fromServerCase, ASOF, csrf: () => csrf };
  g.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
