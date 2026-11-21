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
  'patient.read': ['admin', 'doctor', 'nurse', 'viewer'],   // search and open patient records (chunk 34a); an informatician reviews content and does not need identities
  'case.history': ALL,                               // GET /cases/:id/history: old versions per row and value (chunk 33c1); rows entered in error need case.read_errors too
  // charting
  'case.create': ['admin', 'doctor', 'nurse'],
  'case.patient': ['admin', 'doctor', 'nurse'],      // patient banner details (demo fields until chunk 34)
  'case.pin': ['admin', 'doctor', 'nurse'],          // quick bar
  'alert.ack': ['admin', 'doctor', 'nurse'],         // acknowledge an alert: POST /cases/:id/alert-acks (chunk 35b)
  'patient.write': ['admin', 'doctor', 'nurse'],     // register and correct patients (a correction needs a reason)
  'patient.merge': ['admin'],                        // merge and unmerge duplicate records
  'encounter.write': ['admin', 'doctor', 'nurse'],   // start, move, close or cancel an encounter
  'case.link': ['admin', 'doctor', 'nurse'],         // attach a case to a patient and an encounter
  'case.export': ['admin', 'doctor'],                // GET /cases/:id/export: identified FHIR Patient and Encounter, audited (chunk 34d). An informatician never sees identities.
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
  'codesystem.write': ['admin', 'informatician'],    // P4a: create a local code system and add codes to it (verifying a local code uses code.write, like a standard one)
  'binding.write': ['admin', 'doctor', 'informatician'],
  'rule.write': CLIN, 'rule.approve': CLIN,          // only a doctor or an admin can approve; editing resets approval (api.js)
  'protocol.write': CLIN, 'protocol.approve': CLIN,
  'usage.write': ALL, 'pref.write': ALL,             // the caller's own ranking and display settings only
  'import.run': ['admin'],
  'migrate.run': ['admin'],                          // one-time turn of typed demo patients into real patient and encounter records (chunk 34c)
  'rules.inforce': CLIN,                             // GET /rules-in-force and its CSV: read-only list of approved rules and verified protocols (chunk 35c)
  'views.admin': ['admin'],                          // PUT /emr-views: which EMR view pathways (ward board columns, Handover tab) are switched on (V7a2, decision 11)
  'ai.admin': ['admin'],                             // GET/PUT /admin/ai: the AI switch (chunk 36a). AI is off until an admin turns it on.
  'ai.schema': ['admin', 'doctor', 'informatician'], // POST /llm/schema: draft an element set (same people who author sets)
  'ai.suggest': CLIN,                                // POST /llm/suggest: suggest sets for a case narrative (same people who apply sets)
  'ai.feature_request': ['admin', 'doctor', 'nurse', 'informatician'], // POST /llm/feature-request (43a2): one sentence -> a DRAFT set, pathway or rule; saves nothing, a draft is never approved. Not viewer.
  'ai.rule_draft': CLIN,                             // POST /llm/rule-draft: draft an alert rule (same people who write rules); a draft is never approved
  'audit.read': ['admin'],                           // GET /audit and /audit.csv: the log itself is admin only (chunk 33d)
  // user.manage and password.change have routes since chunk 32e1; content.submit has a route since 43b3; content.review (the queue, reading a request, approve, request changes, reject: one action, 44a1 to 44a2) and package.install (46a2) arrive with their routes
  'user.manage': ['admin'],                          // admin users routes (chunk 32e1)
  'password.change': ALL,                            // your own password only (chunk 32e1); the first-login change uses this too
  'content.review': ['admin', 'informatician'], /* 44a1a: informatician and admin review AND approve content; doctor, nurse and viewer never. Not charting: an informatician has no clinical action. The author of a request can never review it (CHECK reviewer_id <> author_id in 001_core.sql, and 44a2). */ 'package.install': ['admin', 'informatician'],
  'content.submit': ['admin', 'doctor', 'informatician'], // 43b3: POST /review-requests, submit your own saved version for review (the people who may save sets: set.write). Reviewing is content.review and is separate.
  'handover.mark': ['admin', 'doctor', 'nurse'],     // 37d4: POST /cases/:id/handover, "my last handover on this case is now" (the server's clock). Reading it (GET) is case.read.
  'access.configure': ['admin'],                     // R7: change the access block of an existing element (decision 19 default: admin only). Checked inside POST /element-sets; it has no route of its own.
  'analytics.export': ['admin', 'informatician'],    // R3: de-identified bundle export (Phase F): GET /analytics/export (F7c). An element's export list can only narrow this.
};
// PATCH /cases/:id changes several things; the route needs any of them, and api.js then checks each field the body touches.
const CASE_FIELD_ACTION = { patient: 'case.patient', narrative: 'case.narrative', applied: 'case.apply', pathways: 'case.apply', pinned: 'case.pin' };
ACTIONS['case.patch'] = ROLES.filter((r) => Object.values(CASE_FIELD_ACTION).some((a) => ACTIONS[a].includes(r)));

// Plain-words label for each action, used in the 403 sentence the screen shows (chunk 32d2). A missing label falls back to the action code.
const ACTION_LABELS = {
  'case.create': 'create cases', 'case.patient': 'edit patient banner details', 'case.pin': 'change the quick bar', 'alert.ack': 'acknowledge alerts',
  'case.read_errors': 'see rows entered in error', 'case.history': 'see case history', 'case.narrative': 'edit the narrative', 'case.apply': 'apply sets or pathways', 'case.patch': 'change this case',
  'row.add': 'add readings', 'row.amend_own': 'amend readings', 'row.amend_any': 'amend other people\'s readings', 'value.write': 'save these values',
  'note.write': 'write notes', 'note.sign': 'sign notes', 'set.write': 'edit element sets and pathways', 'code.write': 'edit verified codes', 'codesystem.write': 'create local code systems or add local codes', 'binding.write': 'edit code bindings',
  'rule.write': 'edit alert rules', 'rule.approve': 'approve alert rules', 'protocol.write': 'edit protocols', 'protocol.approve': 'verify protocols',
  'usage.write': 'save usage', 'pref.write': 'save preferences', 'import.run': 'import data', 'migrate.run': 'migrate demo patients', 'audit.read': 'read the audit log', 'rules.inforce': 'see the rules in force', 'ai.admin': 'change the AI setting', 'views.admin': 'choose which view pathways are on', 'ai.schema': 'draft an element set with AI', 'ai.suggest': 'get AI suggestions', 'ai.rule_draft': 'draft a rule with AI', 'ai.feature_request': 'request a feature with AI', 'user.manage': 'manage users', 'password.change': 'change this password',
  'content.review': 'review content', 'content.submit': 'submit content for review', 'package.install': 'install packages', 'analytics.export': 'export de-identified data', 'access.configure': 'change who may use an element', 'handover.mark': 'mark a handover done',
  'patient.read': 'see patient records', 'patient.write': 'register or correct patients', 'patient.merge': 'merge patients', 'encounter.write': 'change encounters', 'case.link': 'link a case to a patient', 'case.export': 'export a patient record',
};
/** The actions a user may take, in the order of ACTIONS. Sent with GET /me so the screen can hide controls; the server stays the control. */
const allowedActions = (user) => Object.keys(ACTIONS).filter((a) => can(user, a));

const CARE_ONLY_ROLES = ['nurse'];

/** Every route, keyed 'METHOD /path' exactly as registered in api.js. */
const ROUTE_ACTIONS = {
  'GET /me': 'session.read', 'GET /emr-views': 'ref.read', 'PUT /emr-views': 'views.admin', 'GET /elements/index': 'ref.read', 'GET /cases/:id/elements': 'case.read', 'GET /analytics/export': 'analytics.export',
  'GET /cases': 'case.read', 'GET /cases/:id': 'case.read', 'GET /cases/:id/history': 'case.history', 'GET /cases/:id/changes': 'case.read', 'POST /cases': 'case.create', 'PATCH /cases/:id': 'case.patch',
  'POST /cases/:id/rows': 'row.add', 'PATCH /cases/:id/rows/:rowId': 'row.amend_own', 'POST /cases/:id/rows/:rowId/error': 'row.amend_own',
  'PUT /cases/:id/values': 'value.write',
  'POST /cases/:id/notes': 'note.write', 'PATCH /cases/:id/notes/:nid': 'note.write', 'POST /cases/:id/notes/:nid/sign': 'note.sign', 'POST /cases/:id/notes/:nid/amend': 'note.write',
  'GET /element-sets': 'ref.read', 'GET /element-sets/:setId': 'ref.read', 'GET /element-sets/:setId/versions': 'ref.read', 'GET /element-sets/:setId/versions/:n': 'ref.read',
  'POST /review-requests': 'content.submit', 'POST /element-sets': 'set.write', 'PATCH /element-sets/:setId': 'set.write', 'DELETE /element-sets/:setId': 'set.write',
  'GET /usage': 'ref.read', 'POST /usage/:setId': 'usage.write', 'DELETE /usage': 'usage.write',
  'GET /codes': 'ref.read', 'POST /codes': 'code.write', 'POST /codes/:system/:code/live': 'code.write',
  'GET /code-systems': 'ref.read', 'POST /code-systems': 'codesystem.write',
  'GET /code-systems/:id/codes': 'ref.read', 'POST /code-systems/:id/codes': 'codesystem.write', 'POST /code-systems/:id/codes/:code/verify': 'code.write',
  'GET /bindings': 'ref.read', 'PUT /bindings': 'binding.write', 'DELETE /bindings/:setId/:fieldId': 'binding.write',
  'GET /rules': 'ref.read', 'PUT /rules/:owner/:ruleId': 'rule.write', 'POST /rules/:owner/:ruleId/approve': 'rule.approve',
  'POST /rules/:owner/:ruleId/disable': 'rule.write', 'DELETE /rules/:owner/:ruleId': 'rule.write',
  'GET /protocols': 'ref.read', 'PUT /protocols/:setId': 'protocol.write', 'POST /protocols/:setId/approve': 'protocol.approve',
  'GET /prefs': 'ref.read', 'PUT /prefs/:key': 'pref.write',
  'POST /import/dry-run': 'import.run', 'POST /import': 'import.run',
  'GET /rules-in-force': 'rules.inforce', 'GET /rules-in-force.csv': 'rules.inforce',
  'GET /audit': 'audit.read', 'GET /audit.csv': 'audit.read',
  'GET /users': 'user.manage', 'POST /users': 'user.manage', 'POST /users/:id/deactivate': 'user.manage', 'POST /users/:id/reactivate': 'user.manage',
  'POST /users/:id/reset-password': 'user.manage', 'POST /users/:id/role': 'user.manage',
  'POST /password': 'password.change',
  'GET /patients': 'patient.read', 'GET /patients/:id': 'patient.read', 'GET /patients/:id/encounters': 'patient.read',
  'POST /patients': 'patient.write', 'PATCH /patients/:id': 'patient.write', 'POST /patients/:id/merge': 'patient.merge', 'POST /patients/:id/unmerge': 'patient.merge',
  'POST /patients/:id/encounters': 'encounter.write', 'PATCH /encounters/:id': 'encounter.write', 'POST /encounters/:id/close': 'encounter.write', 'POST /encounters/:id/cancel': 'encounter.write',
  'GET /cases/:id/handover': 'case.read', 'POST /cases/:id/handover': 'handover.mark',
  'POST /cases/:id/link': 'case.link', 'GET /cases/:id/alert-acks': 'case.read', 'POST /cases/:id/alert-acks': 'alert.ack', 'GET /cases/:id/export': 'case.export',
  'POST /admin/migrate-demo-patients': 'migrate.run',
  'GET /admin/ai': 'ai.admin', 'PUT /admin/ai': 'ai.admin', 'POST /llm/schema': 'ai.schema', 'POST /llm/suggest': 'ai.suggest', 'POST /llm/rule-draft': 'ai.rule_draft', 'POST /llm/feature-request': 'ai.feature_request',
};

function can(user, action) {
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) throw new Error('Unknown permission action: ' + action);   // a typo must fail loudly, never silently allow or deny
  return !!user && ACTIONS[action].includes(user.role);
}
/** R3: element access (VIEWS.md "Access block"). The six element actions each map to ONE base action in the table above.
 *  An element can only narrow: true only if the element lists the user's role for the action AND the base action allows that role.
 *  No access block, a missing action, or no user means deny. An unknown element action throws, like can(). */
const ELEMENT_BASE_ACTION = { view: 'case.read', enter: 'row.add', amend: 'row.amend_own', approve: 'rule.approve', configure: 'set.write', export: 'analytics.export' };
function canElement(user, el, action) {
  if (!Object.prototype.hasOwnProperty.call(ELEMENT_BASE_ACTION, action)) throw new Error('Unknown element action: ' + action);
  const a = el && el.access;
  if (!user || !a || typeof a !== 'object' || Array.isArray(a)) return false;
  const roles = a[action];
  if (!Array.isArray(roles) || !roles.includes(user.role)) return false;
  return can(user, ELEMENT_BASE_ACTION[action]);
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

module.exports = { ROLES, ACTIONS, ACTION_LABELS, allowedActions, ROUTE_ACTIONS, CASE_FIELD_ACTION, can, canElement, ELEMENT_BASE_ACTION, requireAction, guardRouter, caseFieldActions, canAddRow, canAmendRow, denied };
