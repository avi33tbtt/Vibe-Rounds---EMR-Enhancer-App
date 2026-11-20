'use strict';
/**
 * Seed the ten synthetic demo patients through the running server's own routes (D3a2). Run by hand:
 *   BASE_URL=http://127.0.0.1:3000 node seed-demo.js [--dry]
 * Needs DATABASE_URL (a throwaway database; used only to make the demo user and to set patients.synthetic_key) and a running server on BASE_URL.
 * The guards (ALLOW_DEMO_SEED, production refused, skip existing) come in D3b. Nothing here names a clinical set or field: it passes generateDemo output through.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createDb, migrate } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { generateDemo } = require('./demo-data.js');

const DEMO_USER = 'demo-seeder', ANCHOR = process.env.DEMO_ANCHOR || '2026-11-01T08:00:00Z', SEED = Number(process.env.DEMO_SEED || 1);

/** Minimal cookie-keeping client for the /api routes (login, CSRF token, JSON). */
function client(base) {
  let cookie = '', csrf = '';
  const call = async (method, path, body, okStatuses = [200, 201]) => {
    const res = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((x) => x.split(';')[0]).join('; ');
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
    if (!okStatuses.includes(res.status)) { const e = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`); e.status = res.status; e.body = json; throw e; }
    return json;
  };
  return { call, async login(username, password) { await call('POST', '/login', { username, password }); csrf = (await call('GET', '/csrf')).token; } };
}

/** Make (or reset) the demo user with a random password that is never printed or stored. Role admin, so the one user can register, chart and merge. */
async function demoUser(db) {
  const password = crypto.randomBytes(18).toString('base64url'), hash = await hashPassword(password);
  await db.query(`INSERT INTO users (username,name,role,password_hash,active,must_change_password) VALUES ($1,'Demo seeder (synthetic)','admin',$2,true,false)
    ON CONFLICT (username) DO UPDATE SET password_hash=$2, active=true, must_change_password=false`, [DEMO_USER, hash]);
  return password;
}

async function seed({ db, api, data }) {
  const sum = { patients: 0, encounters: 0, cases: 0, rows: 0, errors: 0, merges: 0 };
  const pid = {}, eid = {}, cver = {};
  for (const p of data.patients) {                                    // 1. patients; a duplicate warning (D-08) is confirmed on purpose
    const body = { name: p.name, sex: p.sex, ageYears: p.ageYears };
    let r;
    try { r = await api.call('POST', '/patients', body); } catch (e) { if (e.status !== 409) throw e; r = await api.call('POST', '/patients', { ...body, confirmDifferent: true }); }
    pid[p.key] = r.id; sum.patients++;
    await db.query('UPDATE patients SET synthetic_key=$2 WHERE id=$1', [r.id, p.syntheticKey]);   // direct SQL: no route accepts the marker
  }
  for (const e of data.encounters) {                                  // 2. encounters (closed after the rows, so one open encounter per bed holds)
    const r = await api.call('POST', `/patients/${pid[e.patientKey]}/encounters`, { type: e.type, startAt: e.startAt, ward: e.ward, bed: e.bed });
    eid[e.key] = { id: r.id, version: r.version }; sum.encounters++;
  }
  for (const c of data.cases) {                                       // 3. cases, linked to patient and encounter
    const made = await api.call('POST', '/cases', { id: c.id, applied: c.applied, narrative: c.narrative, pathways: c.pathways });
    const link = await api.call('POST', `/cases/${c.id}/link`, { expectedVersion: made.version, patientId: pid[c.patientKey], ...(c.encounterKey ? { encounterId: eid[c.encounterKey].id } : {}) });
    cver[c.id] = link.version; sum.cases++;
  }
  for (const w of data.rows) {                                        // 4. rows with their time, then entered-in-error where the persona says so
    const r = await api.call('POST', `/cases/${w.caseId}/rows`, { id: w.id, setId: w.setId, groupId: w.groupId, row: w.row, ...(w.rowTime ? { rowTime: w.rowTime } : {}) });
    sum.rows++;
    if (w.errorReason) { await api.call('POST', `/cases/${w.caseId}/rows/${w.id}/error`, { reason: w.errorReason, expectedVersion: r.version }); sum.errors++; }
  }
  for (const e of data.encounters.filter((x) => x.endAt)) {           // 5. close finished stays
    const cur = eid[e.key];
    await api.call('POST', `/encounters/${cur.id}/close`, { expectedVersion: cur.version, endAt: e.endAt });
  }
  for (const m of data.merges || []) {                                // 6. merges (D-08)
    await api.call('POST', `/patients/${pid[m.fromKey]}/merge`, { intoPatientId: pid[m.intoKey], reason: 'Synthetic demo: duplicate registration' }); sum.merges++;
  }
  return sum;
}

async function main() {
  try { process.loadEnvFile && fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) { /* optional */ }
  const dry = process.argv.includes('--dry');
  const p = require('./demo-personas.json');
  const data = generateDemo({ seed: SEED, anchor: ANCHOR, personas: Array.isArray(p) ? p : (p.personas || p) });
  if (dry) { for (const k of Object.keys(data)) console.log(k, Array.isArray(data[k]) ? data[k].length : typeof data[k], JSON.stringify(Array.isArray(data[k]) ? data[k][0] : data[k]).slice(0, 400)); return; }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');
  const db = createDb(process.env.DATABASE_URL);
  try {
    await migrate(db, __dirname);
    const api = client(process.env.BASE_URL || 'http://127.0.0.1:3000');
    await api.login(DEMO_USER, await demoUser(db));
    console.log('Seeded:', JSON.stringify(await seed({ db, api, data })));
  } finally { await db.close(); }
}

module.exports = { seed, client, demoUser };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
