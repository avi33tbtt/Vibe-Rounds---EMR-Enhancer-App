'use strict';
// Row R9d-2: longitudinal demo seed, step 1. SYNTHETIC DATA ONLY. Prototype, not for clinical use.
// Makes (once) the synthetic patient "DEMO, Patient L" (own MRN, never the DM1 patient), publishes the R9d-1 sets and pathway
// through the real review rules (same helpers as seed-demo.js), and opens one case with the pathway pinned.
// It records no values yet (R9d-3 does that, with the reset and the npm scripts). Safe to run again: it changes nothing then.
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { createApp } = require('../app');
const { client, must, publishedSetVersion, publishedPathway } = require('./seed-demo');
const content = require('../longitudinal-demo-content');

const PATIENT = { name: 'DEMO, Patient L', mrn: 'DEMO-LONG-0001', dob: '1968-01-01', sex: 'U' };
const CASE_TITLE = 'DEMO longitudinal case (synthetic)';

async function seedLongitudinal({ base, password, log = () => {} }) {
  const U = { doctor: client(base), admin: client(base), inf1: client(base), inf2: client(base) };
  for (const [k, u] of [['doctor', 'doctor1'], ['admin', 'admin1'], ['inf1', 'informatician1'], ['inf2', 'informatician2']]) {
    const r = await U[k].post('/api/login', { username: u, password });
    if (r.status !== 200) throw new Error(`Login as ${u} failed. Run "npm run seed" first and set SEED_PASSWORD in .env to the same password.`);
  }
  const D = U.doctor;
  // 1. the synthetic patient, found by its MRN (never a second one)
  let pat = must(await D.get('/api/patients?archived=1&q=' + encodeURIComponent(PATIENT.mrn)), [200], 'search patient').patients.find(p => p.mrn === PATIENT.mrn);
  if (!pat) pat = must(await D.post('/api/patients', PATIENT), [201], 'register patient').patient;
  if (pat.archived) throw new Error('The longitudinal demo patient is archived. Restore it in the page, then run this again.');
  // 2. content: each set and the pathway go through draft, review, publish (existing ones are reused)
  const sets = [];
  for (const s of content.SETS) sets.push({ slug: s.slug, ...(await publishedSetVersion(U, s.definition, s.slug, s.kind)) });
  const members = content.PATHWAY.memberSlugs.map(slug => { const m = sets.find(s => s.slug === slug); if (!m) throw new Error('Pathway member set missing: ' + slug); return m; });
  const pw = await publishedPathway(U, members, content.PATHWAY);
  // 3. the case, if there is not already an active one
  const cases = must(await D.get(`/api/patients/${pat.id}/cases`), [200], 'list cases').cases.filter(c => c.title === CASE_TITLE && c.status === 'active');
  if (cases.length) { log(`Longitudinal demo case ${cases[0].id} already exists; nothing changed.`); return { created: false, patientId: pat.id, caseId: cases[0].id, pathwayId: pw.id }; }
  const cs = must(await D.post(`/api/patients/${pat.id}/cases`, { title: CASE_TITLE }), [201], 'create case').case;
  must(await D.post(`/api/cases/${cs.id}/applied-pathways`, { pathwayId: pw.id, version: pw.version }), [201], 'apply pathway');
  log(`Longitudinal demo ready: patient ${pat.id}, case ${cs.id}, ${sets.length} sets and pathway v${pw.version} published and pinned.`);
  return { created: true, patientId: pat.id, caseId: cs.id, pathwayId: pw.id, pathwayVersion: pw.version, sets };
}

module.exports = { seedLongitudinal, PATIENT, CASE_TITLE };

if (require.main === module) {
  (async () => {
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('Set SEED_PASSWORD in .env (the password the demo users were created with by "npm run seed").');
    const mpool = makePool(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL);
    await migrate(mpool); await mpool.end();
    const pool = makePool();
    const server = createApp(pool, { quiet: true, limits: { write: { max: 100000 }, loginIp: { max: 100000 }, loginUser: { max: 100000 } } }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try { await seedLongitudinal({ base: `http://127.0.0.1:${server.address().port}`, password, log: console.log }); }
    finally { await new Promise(r => server.close(r)); await pool.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
