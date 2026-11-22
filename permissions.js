'use strict';
// Server-side permission table. The UI may hide buttons, but only this enforces access.
const PERMS = {
  'patients:read':     ['admin', 'doctor', 'nurse', 'viewer'],
  'patients:register': ['admin', 'doctor', 'nurse'],
  'patients:archive':  ['admin', 'doctor'],
  'encounters:write':  ['admin', 'doctor', 'nurse'],
  'cases:read':        ['admin', 'doctor', 'nurse', 'viewer'],
  'cases:write':       ['admin', 'doctor', 'nurse'],   // create, edit title/status, archive/restore, link encounters, add narrative
  'sets:read':         ['admin', 'doctor', 'nurse', 'viewer'],   // element-set library and versions
  'sets:write':        ['admin', 'doctor'],                      // create a set, add a draft version (D5: create/edit = admin and doctor)
  'sets:submit':       ['admin', 'doctor'],                      // submit a draft version for review (8b)
  'sets:publish':      ['admin'],                                // publish and retire a version (no separate informatician role exists yet)
  'audit:read':        ['admin'],
  'ai:use':            ['admin', 'doctor'],   // draft / rank element sets with the server-side AI
  'ai:admin':          ['admin'],             // the AI on/off switch, model and request limits
};
const can = (role, perm) => (PERMS[perm] || []).includes(role);
const permsFor = role => Object.keys(PERMS).filter(p => can(role, p));
module.exports = { PERMS, can, permsFor };
