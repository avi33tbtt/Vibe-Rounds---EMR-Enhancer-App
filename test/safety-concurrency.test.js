'use strict';
// Chunk 05, check 2: two writers at the same moment. The second one must get a clear conflict (409/429),
// never a 500, never two rows, never a state the rules forbid.
// Each scenario is repeated several times: a race that passes once proves little.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, client } = require('./helpers');

const ROUNDS = 6;
let env, prov, provCalls = 0;

function startProvider() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        provCalls++;
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '{"title":"x","fields":[]}' } }] })); }, 150);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.before(async () => {
  prov = await startProvider();
  env = await setup({ ai: { provider: 'openrouter', key: 'k-test', model: 'test/m', baseUrl: `http://127.0.0.1:${prov.address().port}`, timeoutMs: 5000 } });
});
test.after(async () => { await env.close(); await new Promise(r => prov.close(r)); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const count = async (sql, args = []) => Number((await env.pool.query(sql, args)).rows[0].n);
const statuses = rs => rs.map(r => r.status).sort((a, b) => a - b);
const reg = (c, mrn, name = 'Race ' + mrn, dob = '1970-01-01') => c.post('/api/patients', { name, mrn, dob, sex: 'U' });

test('two people register the same MRN at once: one 201, one 409, one row, never a 500', async () => {
  const [a, b] = [await as('nurse1'), await as('doctor1')];
  for (let i = 0; i < ROUNDS; i++) {
    const mrn = `RACE-MRN-${i}`;
    // different names and dates of birth so only the MRN rule is in play
    const rs = await Promise.all([reg(a, mrn, 'First ' + i, '1960-01-01'), reg(b, mrn.toLowerCase(), 'Second ' + i, '1961-02-02')]);
    assert.deepEqual(statuses(rs), [201, 409], `round ${i}: ${JSON.stringify(rs.map(r => [r.status, r.body && r.body.error]))}`);
    assert.equal(rs.find(r => r.status === 409).body.error, 'mrn_taken');
    assert.equal(await count('SELECT count(*) n FROM patients WHERE lower(mrn) = lower($1)', [mrn]), 1);
  }
});

test('two bed requests at once: the same bed for two patients, one wins, the other gets bed_occupied', async () => {
  const [a, b] = [await as('nurse1'), await as('doctor1')];
  for (let i = 0; i < ROUNDS; i++) {
    const p1 = (await reg(a, `BED-A-${i}`)).body.patient.id, p2 = (await reg(a, `BED-B-${i}`)).body.patient.id;
    const rs = await Promise.all([a.post(`/api/patients/${p1}/encounters`, { bed: `Bed ${i}` }), b.post(`/api/patients/${p2}/encounters`, { bed: `BED ${i}` })]);
    assert.deepEqual(statuses(rs), [201, 409], `round ${i}: ${JSON.stringify(rs.map(r => [r.status, r.body && r.body.error]))}`);
    assert.equal(rs.find(r => r.status === 409).body.error, 'bed_occupied');
    assert.equal(await count(`SELECT count(*) n FROM encounters WHERE status = 'open' AND lower(bed) = lower($1)`, [`Bed ${i}`]), 1);
  }
});

test('two opens for the same patient at once: one encounter, the other gets a conflict', async () => {
  const [a, b] = [await as('nurse1'), await as('doctor1')];
  for (let i = 0; i < ROUNDS; i++) {
    const pid = (await reg(a, `ONE-${i}`)).body.patient.id;
    const rs = await Promise.all([a.post(`/api/patients/${pid}/encounters`, { bed: `X-${i}-1` }), b.post(`/api/patients/${pid}/encounters`, { bed: `X-${i}-2` })]);
    assert.deepEqual(statuses(rs), [201, 409], `round ${i}: ${JSON.stringify(rs.map(r => [r.status, r.body && r.body.error]))}`);
    assert.equal(rs.find(r => r.status === 409).body.error, 'patient_has_open_encounter');
    assert.equal(await count(`SELECT count(*) n FROM encounters WHERE patient_id = $1 AND status = 'open'`, [pid]), 1);
  }
});

test('two people close the same encounter at once: one 200, one 409 already_closed, closed once', async () => {
  const [a, b] = [await as('nurse1'), await as('doctor1')];
  for (let i = 0; i < ROUNDS; i++) {
    const pid = (await reg(a, `CLOSE-${i}`)).body.patient.id;
    const eid = (await a.post(`/api/patients/${pid}/encounters`, { bed: `C-${i}` })).body.encounter.id;
    const rs = await Promise.all([a.post(`/api/encounters/${eid}/close`), b.post(`/api/encounters/${eid}/close`)]);
    assert.deepEqual(statuses(rs), [200, 409], `round ${i}: ${JSON.stringify(rs.map(r => [r.status, r.body && r.body.error]))}`);
    assert.equal(rs.find(r => r.status === 409).body.error, 'already_closed');
    assert.equal(await count(`SELECT count(*) n FROM audit_log WHERE action = 'encounter.close' AND entity_id = $1`, [String(eid)]), 1, 'closed (and audited) once');
  }
});

test('archive and open-encounter at once: never an archived patient with an open encounter', async () => {
  const [a, d] = [await as('nurse1'), await as('doctor1')];
  const seen = new Set();
  for (let i = 0; i < ROUNDS * 2; i++) {
    const pid = (await reg(a, `ARCH-${i}`)).body.patient.id;
    const rs = await Promise.all([d.patch(`/api/patients/${pid}/archive`, { archived: true }), a.post(`/api/patients/${pid}/encounters`, { bed: `AR-${i}` })]);
    assert.ok(rs.every(r => r.status < 500), `round ${i}: ${JSON.stringify(rs.map(r => [r.status, r.body && r.body.error]))}`);
    seen.add(rs.map(r => r.body && r.body.error || 'ok').join('+'));
    assert.equal(await count(`SELECT count(*) n FROM patients p JOIN encounters e ON e.patient_id = p.id AND e.status = 'open' WHERE p.id = $1 AND p.archived`, [pid]), 0,
      `round ${i}: archived patient has an open encounter`);
  }
});

test('AI limit: two quick sends from one user with one request left, exactly one reaches the provider', async () => {
  const admin = await as('admin1'), doc = await as('doctor1');
  assert.equal((await admin.raw('PUT', '/api/ai/settings', { enabled: true, model: 'test/m', hourlyLimitPerUser: 1, dailyLimitTotal: 200 })).status, 200);
  const GEN = { kind: 'gen', payload: { diagnosis: 'Sepsis', systems: ['snomed', 'loinc'] } };
  for (let i = 0; i < 3; i++) {
    const p1 = (await doc.post('/api/ai/preview', GEN)).body.previewId, p2 = (await doc.post('/api/ai/preview', GEN)).body.previewId;
    assert.ok(p1 && p2);
    provCalls = 0;
    const used = await count(`SELECT count(*) n FROM audit_log WHERE action = 'ai.request' AND at > now() - interval '1 hour'`);
    // raise the limit by exactly what is already used, leaving ONE call free
    assert.equal((await admin.raw('PUT', '/api/ai/settings', { hourlyLimitPerUser: Math.min(500, used + 1) })).status, 200);
    const rs = await Promise.all([doc.post('/api/ai/run', { previewId: p1 }), doc.post('/api/ai/run', { previewId: p2 })]);
    assert.deepEqual(statuses(rs), [200, 429], `round ${i}: ${JSON.stringify(rs.map(r => [r.status, r.body && r.body.error]))}`);
    assert.equal(rs.find(r => r.status === 429).body.error, 'rate_limited');
    assert.equal(provCalls, 1, `round ${i}: the provider was called ${provCalls} times`);
  }
});

// A conflict on a stale version (two people editing the same element set, case or note) cannot be tested yet:
// those records live in the browser until a later chunk stores them on the server. The test is written here so it
// shows up as TODO in every run until then.
test.todo('stale version: the second writer of an element set / case / note gets a conflict (needs server-side records)');
