'use strict';
// Server-side permission table. The UI may hide buttons, but only this enforces access.
const PERMS = {
  'patients:read':     ['admin', 'doctor', 'nurse', 'viewer'],
  'patients:register': ['admin', 'doctor', 'nurse'],
  'patients:archive':  ['admin', 'doctor'],
  'encounters:write':  ['admin', 'doctor', 'nurse'],
  'cases:read':        ['admin', 'doctor', 'nurse', 'viewer'],
  'cases:write':       ['admin', 'doctor', 'nurse'],   // create, edit title/status, archive/restore, link encounters, add narrative
  'sets:read':         ['admin', 'doctor', 'nurse', 'viewer', 'informatician'],   // element-set library and versions
  'sets:write':        ['admin', 'doctor'],                      // create a set, add a draft version (D5: create/edit = admin and doctor)
  'sets:submit':       ['admin', 'doctor'],                      // submit a draft version for review (8b)
  'sets:review':       ['informatician'],                        // approve or reject a version in review (8c); not the author or submitter (checked per version)
  'sets:publish':      ['admin'],                                // publish an APPROVED version and retire a version; reviewers (informatician) cannot publish (8c-2 decision)
  'terms:read':        ['admin', 'doctor', 'nurse', 'viewer', 'informatician'],   // local terms (R2f): free in-house vocabulary, read
  'terms:write':       ['admin', 'doctor'],                      // add a draft local term or a new version of one (R2f-1)
  'terms:submit':      ['admin', 'doctor'],                      // submit a draft local term for review (R2f-2)
  'terms:review':      ['informatician'],                        // approve or reject a local term in review; never its author or submitter (R2f-2)
  'terms:publish':     ['admin'],                                // publish an approved local term and retire one (R2f-2)
  'problems:read':     ['admin', 'doctor', 'nurse', 'viewer'],   // patient problem list (R3a)
  'problems:write':    ['admin', 'doctor', 'nurse'],              // add a problem; resolve or mark entered in error (R3a-2)
  'allergies:read':    ['admin', 'doctor', 'nurse', 'viewer'],   // patient allergy list (R3c)
  'allergies:write':   ['admin', 'doctor', 'nurse'],              // add an allergy; resolve or mark entered in error (R3c)
  'medications:read':  ['admin', 'doctor', 'nurse', 'viewer'],   // patient medication history, recorded list only (R3e)
  'medications:write': ['admin', 'doctor', 'nurse'],              // add; stop or mark entered in error (R3e)
  'orders:read':       ['admin', 'doctor', 'nurse', 'viewer'],   // orders and results: medication orders (R4b)
  'orders:write':      ['admin', 'doctor'],                       // order, change with reason, stop, mark entered in error (R4b)
  'results:read':      ['admin', 'doctor', 'nurse', 'viewer'],   // specimens and results of investigation orders (R4f)
  'results:write':     ['admin', 'doctor', 'nurse'],              // record a specimen or a result; correct a result with a reason (R4f)
  'results:ack':       ['admin', 'doctor'],                       // acknowledge a result flagged abnormal (R4g-1)
  'audit:read':        ['admin'],
  'context:read':      ['admin', 'doctor'],   // the de-identified context envelope for CCIS (B5); no nurse, viewer or informatician
  'ccis:import':       ['admin', 'doctor'],   // import a CCIS run record made from an envelope exported for the same case (DM2a)
  'ccis:read':         ['admin', 'doctor', 'nurse', 'viewer'],   // see imported run records and who acknowledged them
  'ccis:ack':          ['admin', 'doctor'],   // acknowledge that a run was seen; not an approval of its result
  'ai:use':            ['admin', 'doctor'],   // draft / rank element sets with the server-side AI
  'ai:admin':          ['admin'],             // the AI on/off switch, model and request limits
};
const can = (role, perm) => (PERMS[perm] || []).includes(role);
const permsFor = role => Object.keys(PERMS).filter(p => can(role, p));
module.exports = { PERMS, can, permsFor };
