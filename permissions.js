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
  // defined now, routes arrive later (admin screen chunk 32e, Phase 6)
  'user.manage': ['admin'], 'content.review': ['admin', 'informatician'], 'package.install': ['admin', 'informatician'],
};
// PATCH /cases/:id changes several things; the route needs any of them, and api.js then checks each field the body touches.
const CASE_FIELD_ACTION = { patient: 'case.patient', narrative: 'case.narrative', applied: 'case.apply', pathways: 'case.apply', pinned: 'case.pin', alertLog: 'alert.ack' };
ACTIONS['case.patch'] = ROLES.filter((r) => Object.values(CASE_FIELD_ACTION).some((a) => ACTIONS[a].includes(r)));

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
};

function can(user, action) {
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) throw new Error('Unknown permission action: ' + action);   // a typo must fail loudly, never silently allow or deny
  return !!user && ACTIONS[action].includes(user.role);
}
const denied = (res, user, what) => res.status(403).json({ error: { code: 'forbidden', message: `Your role (${user && user.role}) may not ${what}` } });

/** Express guard for one action. Needs req.actor ({id, role}); no actor is a 401. */
function requireAction(action) {
  if (!ACTIONS[action]) throw new Error('Unknown permission action: ' + action);
  return (req, res, next) => {
    if (!req.actor) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required' } });
    return can(req.actor, action) ? next() : denied(res, req.actor, 'do this (' + action + ')');
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

module.exports = { ROLES, ACTIONS, ROUTE_ACTIONS, CASE_FIELD_ACTION, can, requireAction, guardRouter, caseFieldActions, canAddRow, canAmendRow, denied };
