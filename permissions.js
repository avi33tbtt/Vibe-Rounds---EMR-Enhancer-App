'use strict';
// Server-side permission table. The UI may hide buttons, but only this enforces access.
const PERMS = {
  'patients:read':     ['admin', 'doctor', 'nurse', 'viewer'],
  'patients:register': ['admin', 'doctor', 'nurse'],
  'patients:archive':  ['admin', 'doctor'],
  'encounters:write':  ['admin', 'doctor', 'nurse'],
  'audit:read':        ['admin'],
};
const can = (role, perm) => (PERMS[perm] || []).includes(role);
const permsFor = role => Object.keys(PERMS).filter(p => can(role, p));
module.exports = { PERMS, can, permsFor };
