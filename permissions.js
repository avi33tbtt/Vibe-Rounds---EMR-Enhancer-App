'use strict';
/**
 * Permissions (chunk 32b). ONE table: action -> roles. Every API route is mapped to exactly one action in ROUTE_ACTIONS, and api.js refuses to start if a
 * route is registered without one, so a new route cannot be forgotten. Roles are checked here only; nothing else in the code compares role names,
 * except the two row rules below (a nurse charts in care sets only, and amends only her own rows).
 *
 * Decisions to confirm (clinical governance, not technical):
 *  - admin holds every action (manages users and sets, and can chart/approve). Remove admin from an action here if your policy separates them.
 *  - nurses add readings and amend their own readings in care sets, acknowledge alerts, pin the quick bar and type patient banner details; they do NOT
 *    apply sets or pathways, write notes, save non-repeating values, or create/approve rules and protocols.
 *  - informatician reviews content and installs packages (Phase 6 actions below have no routes yet) and may author sets, pathways and codes; no charting.
 *  - viewer reads everything clinical and keeps its own display preferences (usage, prefs), nothing else.
 */
const ROLES = ['admin', 'doctor', 'nurse', 'informatician', 'viewer'];
const ALL = ROLES;
const CLIN = ['admin', 'doctor'];

const ACTIONS = {
  // reading
  'session.read': ALL, 'case.read': ALL, 'ref.read': ALL,
  // charting
  'case.create': ['admin', 'doctor', 'nurse'],
  'case.patient': ['admin', 'doctor', 'nurse'],      // patient banner details (demo fields until chunk 34)
  'case.pin': ['admin', 'doctor', 'nurse'],          // quick bar
  'alert.ack': ['admin', 'doctor', 'nurse'],         // acknowledge an alert (alertLog)
  'case.read_errors': CLIN,                          // GET /cases/:id?include_errors=true: see rows marked entered in error (chunk 33b)
  'case.narrative': CLIN,
  'case.apply': CLIN,                                // applied sets and pathways
  'row.add': ['admin', 'doctor', 'nurse'],           // a nurse: care sets only (see canAddRow)
  'row.amend_own': ['admin', 'doctor', 'nurse'],     // edit or mark entered in error; a nurse: own rows in care sets only (see canAmendRow)
  'row.amend_any': CLIN,
  'value.write': CLIN,
  'note.write': CLIN, 'note.sign': CLIN,
  // content and reference data
  'set.write': ['admin', 'doctor', 'informatician'],
  'code.write': ['admin', 'doctor', 'informatician'],
  'binding.write': ['admin', 'doctor', 'informatician'],
  'rule.write': CLIN, 'rule.approve': CLIN,          // only a doctor or an admin can approve; editing resets approval (api.js)
  'protocol.write': CLIN, 'protocol.approve': CLIN,
  'usage.write': ALL, 'pref.write': ALL,             // the caller's own ranking and display settings only
  'import.run': ['admin'],
  'audit.read': ['admin'],                           // GET /audit and /audit.csv: the log itself is admin only (chunk 33d)
  // user.manage and password.change have routes since chunk 32e1; content.review and package.install arrive with Phase 6
  'user.manage': ['admin'],                          // admin users routes (chunk 32e1)
  'password.change': ALL,                            // your own password only (chunk 32e1); the first-login change uses this too
  'content.review': ['admin', 'informatician'], 'package.install': ['admin', 'informatician'],
};
// PATCH /cases/:id changes several things; the route needs any of them, and api.js then checks each field the body touches.
const CASE_FIELD_ACTION = { patient: 'case.patient', narrative: 'case.narrative', applied: 'case.apply', pathways: 'case.apply', pinned: 'case.pin', alertLog: 'alert.ack' };
ACTIONS['case.patch'] = ROLES.filter((r) => Object.values(CASE_FIELD_ACTION).some((a) => ACTIONS[a].includes(r)));

// Plain-words label for each action, used in the 403 sentence the screen shows (chunk 32d2). A missing label falls back to the action code.
const ACTION_LABELS = {
  'case.create': 'create cases', 'case.patient': 'edit patient banner details', 'case.pin': 'change the quick bar', 'alert.ack': 'acknowledge alerts',
  'case.read_errors': 'see rows entered in error', 'case.narrative': 'edit the narrative', 'case.apply': 'apply sets or pathways', 'case.patch': 'change this case',
  'row.add': 'add readings', 'row.amend_own': 'amend readings', 'row.amend_any': 'amend other people\'s readings', 'value.write': 'save these values',
  'note.write': 'write notes', 'note.sign': 'sign notes', 'set.write': 'edit element sets and pathways', 'code.write': 'edit verified codes', 'binding.write': 'edit code bindings',
  'rule.write': 'edit alert rules', 'rule.approve': 'approve alert rules', 'protocol.write': 'edit protocols', 'protocol.approve': 'verify protocols',
  'usage.write': 'save usage', 'pref.write': 'save preferences', 'import.run': 'import data', 'audit.read': 'read the audit log', 'user.manage': 'manage users', 'password.change': 'change this password',
  'content.review': 'review content', 'package.install': 'install packages',
};
/** The actions a user may take, in the order of ACTIONS. Sent with GET /me so the screen can hide controls; the server stays the control. */
const allowedActions = (user) => Object.keys(ACTIONS).filter((a) => can(user, a));

const CARE_ONLY_ROLES = ['nurse'];

/** Every route, keyed 'METHOD /path' exactly as registered in api.js. */
const ROUTE_ACTIONS = {
  'GET /me': 'session.read',
  'GET /cases': 'case.read', 'GET /cases/:id': 'case.read', 'POST /cases': 'case.create', 'PATCH /cases/:id': 'case.patch',
  'POST /cases/:id/rows': 'row.add', 'PATCH /cases/:id/rows/:rowId': 'row.amend_own', 'POST /cases/:id/rows/:rowId/error': 'row.amend_own',
  'PUT /cases/:id/values': 'value.write',
  'POST /cases/:id/notes': 'note.write', 'PATCH /cases/:id/notes/:nid': 'note.write', 'POST /cases/:id/notes/:nid/sign': 'note.sign', 'POST /cases/:id/notes/:nid/amend': 'note.write',
  'GET /element-sets': 'ref.read', 'GET /element-sets/:setId': 'ref.read', 'GET /element-sets/:setId/versions': 'ref.read', 'GET /element-sets/:setId/versions/:n': 'ref.read',
  'POST /element-sets': 'set.write', 'PATCH /element-sets/:setId': 'set.write', 'DELETE /element-sets/:setId': 'set.write',
  'GET /usage': 'ref.read', 'POST /usage/:setId': 'usage.write', 'DELETE /usage': 'usage.write',
  'GET /codes': 'ref.read', 'POST /codes': 'code.write', 'POST /codes/:system/:code/live': 'code.write',
  'GET /bindings': 'ref.read', 'PUT /bindings': 'binding.write', 'DELETE /bindings/:setId/:fieldId': 'binding.write',
  'GET /rules': 'ref.read', 'PUT /rules/:owner/:ruleId': 'rule.write', 'POST /rules/:owner/:ruleId/approve': 'rule.approve',
  'POST /rules/:owner/:ruleId/disable': 'rule.write', 'DELETE /rules/:owner/:ruleId': 'rule.write',
  'GET /protocols': 'ref.read', 'PUT /protocols/:setId': 'protocol.write', 'POST /protocols/:setId/approve': 'protocol.approve',
  'GET /prefs': 'ref.read', 'PUT /prefs/:key': 'pref.write',
  'POST /import/dry-run': 'import.run', 'POST /import': 'import.run',
  'GET /audit': 'audit.read', 'GET /audit.csv': 'audit.read',
  'GET /users': 'user.manage', 'POST /users': 'user.manage', 'POST /users/:id/deactivate': 'user.manage', 'POST /users/:id/reactivate': 'user.manage',
  'POST /users/:id/reset-password': 'user.manage', 'POST /users/:id/role': 'user.manage',
  'POST /password': 'password.change',
};

function can(user, action) {
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) throw new Error('Unknown permission action: ' + action);   // a typo must fail loudly, never silently allow or deny
  return !!user && ACTIONS[action].includes(user.role);
}
const denied = (res, user, what, action) => res.status(403).json({ error: Object.assign({ code: 'forbidden', message: `Your role (${user && user.role}) may not ${what}.` }, action ? { action } : {}) });

/** Express guard for one action. Needs req.actor ({id, role}); no actor is a 401. */
function requireAction(action) {
  if (!ACTIONS[action]) throw new Error('Unknown permission action: ' + action);
  return (req, res, next) => {
    if (!req.actor) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required' } });
    return can(req.actor, action) ? next() : denied(res, req.actor, ACTION_LABELS[action] || 'do this (' + action + ')', action);
  };
}

/** Make every router.get/post/put/patch/delete demand an entry in ROUTE_ACTIONS and apply its guard first. Throws at startup for an unlisted route. */
function guardRouter(router) {
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    const orig = router[m].bind(router);
    router[m] = (path, ...handlers) => {
      const key = m.toUpperCase() + ' ' + path, action = ROUTE_ACTIONS[key];
      if (!action) throw new Error('No permission action for route ' + key + ' (add it to ROUTE_ACTIONS in permissions.js)');
      return orig(path, requireAction(action), ...handlers);
    };
  }
  return router;
}

/** Actions a PATCH /cases/:id body needs, one per field it contains. */
const caseFieldActions = (body) => [...new Set(Object.keys(body).filter((k) => CASE_FIELD_ACTION[k]).map((k) => CASE_FIELD_ACTION[k]))];

/** Rows: a nurse charts in CARE sets only; she amends only rows she entered herself. Doctors and admins amend any row. */
function canAddRow(user, setKind) {
  if (!can(user, 'row.add')) return false;
  return CARE_ONLY_ROLES.includes(user.role) ? setKind === 'care' : true;
}
function canAmendRow(user, row, setKind) {
  if (can(user, 'row.amend_any')) return true;
  return can(user, 'row.amend_own') && row.entered_by === user.id && (!CARE_ONLY_ROLES.includes(user.role) || setKind === 'care');
}

module.exports = { ROLES, ACTIONS, ACTION_LABELS, allowedActions, ROUTE_ACTIONS, CASE_FIELD_ACTION, can, requireAction, guardRouter, caseFieldActions, canAddRow, canAmendRow, denied };
