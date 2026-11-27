'use strict';
// Starter local terms: a short in-house vocabulary so the Local terms screen, the order drug picker and the term picker are not empty.
//   npm run terms:starter         makes the terms and takes each through the real review rules (safe to run again)
//   npm run terms:starter:reset   retires the published starter terms (never deletes) and seeds fresh published versions
// SYNTHETIC. Plain words only: no licensed vocabulary, no doses, no thresholds. Drug terms are names only. Prototype, not for clinical use.
// Same route as scripts/seed-terms.js: it talks to the app over HTTP as doctor1, informatician1 and admin1, so every term passes the real
// review rules. Needs `npm run seed` and SEED_PASSWORD in .env. Edit the list below to suit your own wording, then run it again.
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { createApp } = require('../app');
const { seedTerms } = require('./seed-terms');

const T = (code, display, category, definition) => ({ code: 'starter.' + code, display, category, definition });
const STARTER = [
  T('fever', 'Fever', 'finding', 'Body temperature the clinician records as raised. Starter term.'),
  T('cough', 'Cough', 'finding', 'Cough reported or seen. Starter term.'),
  T('breathlessness', 'Breathlessness', 'finding', 'The patient feels short of breath. Starter term.'),
  T('chest-pain', 'Chest pain', 'finding', 'Pain felt in the chest. Starter term.'),
  T('abdominal-pain', 'Abdominal pain', 'finding', 'Pain felt in the belly. Starter term.'),
  T('headache', 'Headache', 'finding', 'Pain felt in the head. Starter term.'),
  T('vomiting', 'Vomiting', 'finding', 'The patient has vomited. Starter term.'),
  T('diarrhoea', 'Diarrhoea', 'finding', 'Loose or watery stools. Starter term.'),
  T('dehydration', 'Signs of dehydration', 'finding', 'Dry mouth, sunken eyes or similar signs recorded by the clinician. Starter term.'),
  T('jaundice', 'Yellow skin or eyes', 'finding', 'Yellowing of the skin or the whites of the eyes. Starter term.'),
  T('rash', 'Skin rash', 'finding', 'A rash seen on the skin. Starter term.'),
  T('oedema', 'Swelling of the legs', 'finding', 'Swelling seen in the legs or feet. Starter term.'),
  T('joint-pain', 'Joint pain', 'finding', 'Pain felt in one or more joints. Starter term.'),
  T('confusion', 'Confusion', 'finding', 'The patient is confused or not oriented. Starter term.'),
  T('wheeze', 'Wheeze', 'finding', 'A whistling sound heard when the patient breathes. Starter term.'),
  T('hypertension', 'Hypertension', 'condition', 'Long-term raised blood pressure, recorded by the clinician. Starter term.'),
  T('diabetes', 'Diabetes', 'condition', 'Diabetes, recorded by the clinician. Starter term.'),
  T('asthma', 'Asthma', 'condition', 'Asthma, recorded by the clinician. Starter term.'),
  T('pneumonia', 'Pneumonia', 'condition', 'Infection of the lungs, recorded by the clinician. Starter term.'),
  T('gastroenteritis', 'Gastroenteritis', 'condition', 'Infection of the stomach and bowel, recorded by the clinician. Starter term.'),
  T('uti', 'Urinary tract infection', 'condition', 'Infection of the urinary tract, recorded by the clinician. Starter term.'),
  T('ckd', 'Chronic kidney disease', 'condition', 'Long-term kidney disease, recorded by the clinician. Starter term.'),
  T('heart-failure', 'Heart failure', 'condition', 'Heart failure, recorded by the clinician. Starter term.'),
  T('anaemia', 'Anaemia', 'condition', 'Low red blood cells, recorded by the clinician. Starter term.'),
  T('snakebite', 'Snake bite', 'condition', 'A bite from a snake, recorded by the clinician. Starter term.'),
  T('blood-glucose-test', 'Blood glucose test', 'test', 'A test of the sugar level in the blood. Starter term.'),
  T('full-blood-count', 'Full blood count', 'test', 'A blood test that counts the blood cells. Starter term.'),
  T('urea-electrolytes', 'Kidney function and salts test', 'test', 'A blood test for kidney function and body salts. Starter term.'),
  T('liver-function-test', 'Liver function test', 'test', 'A blood test for the liver. Starter term.'),
  T('urine-dipstick', 'Urine dipstick test', 'test', 'A quick test of a urine sample. Starter term.'),
  T('chest-xray', 'Chest X-ray', 'test', 'An X-ray picture of the chest. Starter term.'),
  T('ecg', 'ECG', 'test', 'A recording of the electrical activity of the heart. Starter term.'),
  T('ultrasound-abdomen', 'Abdominal ultrasound', 'test', 'An ultrasound scan of the belly. Starter term.'),
  T('iv-cannula', 'Intravenous cannula placed', 'procedure', 'A small tube placed in a vein. Starter term.'),
  T('oxygen-given', 'Oxygen given', 'procedure', 'Oxygen has been started for the patient. Starter term.'),
  T('wound-dressing', 'Wound dressing', 'procedure', 'A wound has been cleaned and dressed. Starter term.'),
  T('nebulisation', 'Nebulisation given', 'procedure', 'Medicine given as a mist to breathe in. Starter term.'),
  T('temperature', 'Temperature', 'observation', 'Body temperature as recorded. Starter term.'),
  T('weight', 'Weight', 'observation', 'Body weight as recorded. Starter term.'),
  T('pain-score', 'Pain score', 'observation', 'How much pain the patient reports, as recorded. Starter term.'),
  T('paracetamol', 'Paracetamol', 'drug', 'Drug name only. Starter term.'),
  T('ibuprofen', 'Ibuprofen', 'drug', 'Drug name only. Starter term.'),
  T('amoxicillin', 'Amoxicillin', 'drug', 'Drug name only. Starter term.'),
  T('ceftriaxone', 'Ceftriaxone', 'drug', 'Drug name only. Starter term.'),
  T('metformin', 'Metformin', 'drug', 'Drug name only. Starter term.'),
  T('insulin', 'Insulin', 'drug', 'Drug name only. Starter term.'),
  T('amlodipine', 'Amlodipine', 'drug', 'Drug name only. Starter term.'),
  T('atorvastatin', 'Atorvastatin', 'drug', 'Drug name only. Starter term.'),
  T('aspirin', 'Aspirin', 'drug', 'Drug name only. Starter term.'),
  T('omeprazole', 'Omeprazole', 'drug', 'Drug name only. Starter term.'),
  T('salbutamol', 'Salbutamol', 'drug', 'Drug name only. Starter term.'),
  T('furosemide', 'Furosemide', 'drug', 'Drug name only. Starter term.'),
  T('ondansetron', 'Ondansetron', 'drug', 'Drug name only. Starter term.'),
  T('ors', 'Oral rehydration solution', 'drug', 'Drug name only. Starter term.'),
  T('normal-saline', 'Normal saline', 'drug', 'Fluid name only. Starter term.'),
];

module.exports = { STARTER };

if (require.main === module) {
  (async () => {
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('Set SEED_PASSWORD in .env (the password the demo users were created with by "npm run seed").');
    const mpool = makePool(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL);
    await migrate(mpool); await mpool.end();
    const pool = makePool();
    const server = createApp(pool, { quiet: true, limits: { write: { max: 100000 }, loginIp: { max: 100000 }, loginUser: { max: 100000 } } }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try { await seedTerms({ base: `http://127.0.0.1:${server.address().port}`, password, reset: process.argv.includes('--reset'), log: console.log, list: STARTER, label: 'Starter local terms' }); }
    finally { await new Promise(r => server.close(r)); await pool.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
