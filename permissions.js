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
