'use strict';
// Task DM2a: import and acknowledge CCIS run records.
// CCIS (a separate app) turns an exported context envelope into a run record. This file only STORES that record against the case it came from.
// It never writes to observations, notes, sets or any other clinical table, and it never changes a stored record (the database refuses it).
// Importer and acknowledger come from the session only. A record must name an envelope this app exported for THIS case, and carry this case's reference.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Ajv2020 = require('ajv/dist/2020');
const { audit } = require('./audit');
const A = require('./auth');
const { caseRef } = require('./envelope');

const RUN_BODY_LIMIT = '2mb';        // a run record carries a whole case snapshot, so this one route may exceed the 50 kb default
const MAX_LIST = 50;
const NOTE_MAX = 500;
const HASH_KEY = 'x-envelopeSha256'; // CCIS records hold no envelope hash yet (CCIS gap G-05), so the hand-off adds this extension (see DECISIONS.md)
const isRunImportPath = p => /^\/api\/cases\/\d+\/ccis-runs$/.test(p);

let validator;
function runRecordValidator() {
  if (validator) return validator;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const f of ['manifest', 'context-envelope', 'analytics', 'validation-record', 'import-report', 'run-result']) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(__dirname, 'contracts', f + '.schema.json'), 'utf8')));
  }
  validator = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, 'contracts', 'run-record.schema.json'), 'utf8')));
  return validator;
}

// Same value, same bytes: keys sorted, so the hash does not depend on key order.
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// One run row as the API shows it. `record` is the stored record, exactly as imported.
const summary = (r, acks = []) => ({
  id: Number(r.id), case_id: r.case_id, imported_by: r.imported_by, imported_at: r.imported_at,
  envelope_sha256: r.envelope_sha256, run_record_sha256: r.run_record_sha256,
  record_id: r.run_record.id, status: r.run_record.status,
  demo_placeholders: !!(r.run_record['x-demo'] && r.run_record['x-demo'].placeholders === true),   // CCIS marks test-only parameter values this way
  run_record: r.run_record, acks,
});
const ackOut = a => ({ id: Number(a.id), run_id: Number(a.run_id), acknowledged_by: a.acknowledged_by, acknowledged_at: a.acknowledged_at, note: a.note });

function mountCcisRuns(app, pool, opts = {}) {
  const secret = () => opts.contextSecret ?? process.env.CONTEXT_REF_SECRET ?? '';
  const RUN = 'r.id, r.case_id, r.run_record, r.run_record_sha256, r.envelope_sha256, r.imported_at, u.username AS imported_by';
  const ACK = 'k.id, k.run_id, k.acknowledged_at, k.note, u.username AS acknowledged_by';

  app.post('/api/cases/:id/ccis-runs', A.requirePerm(pool, 'ccis:import'), express.json({ limit: RUN_BODY_LIMIT }), async (req, res) => {
    const caseId = /^\d{1,9}$/.test(String(req.params.id)) && +req.params.id >= 1 ? +req.params.id : null;
    if (!caseId) return res.status(404).json({ error: 'not_found' });
    const cs = (await pool.query('SELECT status FROM clinical_cases WHERE id = $1', [caseId])).rows[0];
    if (!cs) return res.status(404).json({ error: 'not_found' });
    if (cs.status === 'archived') return res.status(409).json({ error: 'case_archived', message: 'Restore the case before changing it.' });
    if (String(secret()).length < 32) return res.status(503).json({ error: 'context_not_configured', message: 'Set CONTEXT_REF_SECRET (at least 32 characters) on the server.' });

    const rec = req.body;
    const validate = runRecordValidator();
    if (!isPlain(rec) || validate(rec) !== true) {
      // Paths and rule names only: the message never repeats what was sent.
      const errors = (isPlain(rec) ? validate.errors : [{ instancePath: '', message: 'must be a run record object' }]).slice(0, 10)
        .map(e => ({ path: e.instancePath || '/', message: e.message + (e.params && e.params.additionalProperty ? ': ' + String(e.params.additionalProperty).slice(0, 60) : '') }));
      return res.status(422).json({ error: 'run_record_invalid', message: 'The file is not a valid CCIS run record.', errors });
    }
    const envHash = rec[HASH_KEY];
    if (typeof envHash !== 'string' || !/^[0-9a-f]{64}$/.test(envHash)) {
      return res.status(422).json({ error: 'envelope_hash_missing', message: `The record must carry ${HASH_KEY}: the SHA-256 of the exported envelope file it was made from.` });
    }
    if (rec.snapshot.case.ref !== caseRef(secret(), caseId)) {
      return res.status(422).json({ error: 'record_not_for_case', message: 'This run record was not made from an envelope of this case.' });
    }
    const exported = await pool.query('SELECT 1 FROM context_exports WHERE case_id = $1 AND envelope_sha256 = $2 LIMIT 1', [caseId, envHash]);
    if (!exported.rows.length) {
      return res.status(422).json({ error: 'envelope_not_exported', message: 'No envelope with this hash was exported from this case.' });
    }

    const recSha = sha256(canonicalJson(rec));
    const c = await pool.connect();
    let row;
    try {
      await c.query('BEGIN');
      const ins = await c.query(`INSERT INTO ccis_runs(case_id, run_record, run_record_sha256, envelope_sha256, imported_by) VALUES ($1,$2,$3,$4,$5)
                                 ON CONFLICT (case_id, run_record_sha256) DO NOTHING RETURNING id`, [caseId, JSON.stringify(rec), recSha, envHash, req.user.id]);
      if (ins.rows.length) {
        await audit(c, req, 'ccis.import', 'case', caseId, { runId: Number(ins.rows[0].id), recordId: rec.id, status: rec.status, packageId: rec.package.id, packageVersion: rec.package.version,
          results: rec.results.length, envelopeSha256: envHash, runRecordSha256: recSha });   // ids, counts and hashes only, never values
      }
      await c.query('COMMIT');
      row = (await pool.query(`SELECT ${RUN} FROM ccis_runs r JOIN users u ON u.id = r.imported_by WHERE r.case_id = $1 AND r.run_record_sha256 = $2`, [caseId, recSha])).rows[0];
      return res.status(ins.rows.length ? 201 : 200).json({ run: summary(row), alreadyImported: !ins.rows.length });
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally { c.release(); }
  });

  app.get('/api/cases/:id/ccis-runs', A.requirePerm(pool, 'ccis:read'), async (req, res) => {
    const caseId = /^\d{1,9}$/.test(String(req.params.id)) && +req.params.id >= 1 ? +req.params.id : null;
    if (!caseId || !(await pool.query('SELECT 1 FROM clinical_cases WHERE id = $1', [caseId])).rows.length) return res.status(404).json({ error: 'not_found' });
    const runs = (await pool.query(`SELECT ${RUN} FROM ccis_runs r JOIN users u ON u.id = r.imported_by WHERE r.case_id = $1 ORDER BY r.id DESC LIMIT $2`, [caseId, MAX_LIST])).rows;
    const acks = runs.length ? (await pool.query(`SELECT ${ACK} FROM ccis_run_acks k JOIN users u ON u.id = k.acknowledged_by WHERE k.run_id = ANY($1::bigint[]) ORDER BY k.id`, [runs.map(r => r.id)])).rows : [];
    res.json({ runs: runs.map(r => summary(r, acks.filter(a => a.run_id === r.id).map(ackOut))) });
  });

  app.post('/api/ccis-runs/:id/ack', A.requirePerm(pool, 'ccis:ack'), async (req, res) => {
    const runId = /^\d{1,15}$/.test(String(req.params.id)) && +req.params.id >= 1 ? String(+req.params.id) : null;
    if (!runId) return res.status(404).json({ error: 'not_found' });
    const body = isPlain(req.body) ? req.body : {};
    const extra = Object.keys(body).filter(k => k !== 'note');
    if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'Only "note" can be sent: ' + extra.slice(0, 5).join(', ') });
    let note = null;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== 'string') return res.status(400).json({ error: 'bad_note', message: 'The note must be text.' });
      note = body.note.trim() || null;
      if (note && note.length > NOTE_MAX) return res.status(400).json({ error: 'bad_note', message: `The note can be at most ${NOTE_MAX} characters.` });
    }
    const run = (await pool.query('SELECT r.id, r.case_id, c.status FROM ccis_runs r JOIN clinical_cases c ON c.id = r.case_id WHERE r.id = $1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'not_found' });
    if (run.status === 'archived') return res.status(409).json({ error: 'case_archived', message: 'Restore the case before changing it.' });

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const ins = await c.query('INSERT INTO ccis_run_acks(run_id, acknowledged_by, note) VALUES ($1,$2,$3) ON CONFLICT (run_id, acknowledged_by) DO NOTHING RETURNING id', [runId, req.user.id, note]);
      if (!ins.rows.length) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'already_acknowledged', message: 'You have already acknowledged this run.' }); }
      await audit(c, req, 'ccis.ack', 'ccis_run', runId, { caseId: run.case_id, hasNote: note !== null });   // the note text stays out of the audit log
      await c.query('COMMIT');
      const ack = (await pool.query(`SELECT ${ACK} FROM ccis_run_acks k JOIN users u ON u.id = k.acknowledged_by WHERE k.id = $1`, [ins.rows[0].id])).rows[0];
      return res.status(201).json({ ack: ackOut(ack) });
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally { c.release(); }
  });
}

module.exports = { mountCcisRuns, isRunImportPath, canonicalJson, HASH_KEY };
