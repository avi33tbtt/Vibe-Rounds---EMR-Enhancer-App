# EMR Enhancer API (chunks 28 to 32c)

Base path `/api`. JSON in, JSON out. Synthetic data only; not for clinical use.

**Auth (chunk 32b):** every route below needs a login session (cookie from `POST /api/login`, chunk 32a). No cookie or an ended session is `401 unauthorized`. A logged-in user whose role may not do the action gets `403 forbidden`. `entered_by`, `created_by`, `signedBy`, `addedBy` and approver ids always come from the session user, never from a request body (author fields in a body are rejected as unknown fields). The development user is gone; tests use a test-only `getActor` that `createApp` refuses when `NODE_ENV=production`. The browser has no login screen until chunk 32d (Demo mode still works).

**CSRF (chunk 32c):** after login, `GET /api/csrf` returns `{token}` (tied to the session). Every `POST`, `PUT`, `PATCH` and `DELETE` under `/api` except `/login` and `/logout` must send it in the `X-CSRF-Token` header, otherwise `403 csrf`. `GET` needs no token. The token is an HMAC of the session id with `SESSION_SECRET` (16+ characters; required when `NODE_ENV=production`; a random per-process value is used otherwise). The check runs before the role check.

**First administrator:** `npm run create-admin` (or `node create-admin.js`) asks for username, name and a password typed twice (12+ characters). There is no default password. It refuses when an active admin with a password already exists unless `--allow-more` is passed.

**Errors:** `{ "error": { "code": "...", "message": "..." } }`. Codes: `validation` 400, `bad_json` 400, `not_found` 404, `conflict` 409, `signed` 409, `entered_in_error` 422, `too_many_rows` 422, `constraint` 422, `read_only` 403, `method_not_allowed` 405, `too_large` 413, `unauthorized` 401, `password_change_required` 403, `auth_not_configured` 503.

**Concurrency:** every versioned write sends `expectedVersion`. A mismatch returns `409` with `{ "error": {...}, "current": <what the server holds> }`. Nothing is last-write-wins. `expectedVersion: 0` means "create, must not exist yet".

**Validation:** bodies are validated strictly; unknown fields are rejected with 400. Limits: narrative 200,000 chars, a row 20,000 chars, a value 100,000 chars, 500 rows per (case, set, group).

**No hard deletes** of clinical data: there is no DELETE for cases, rows, values or notes.

## Health
`GET /api/health` → `200 {status:"ok",db:"ok"}` or `503`.

## Me
`GET /api/me` → `200 {id, name, role, mode}`. The acting user; `mode` is `"dev"` until chunk 32 replaces the placeholder with login sessions. The client Store calls this first when it starts (`Store.init`).

## Cases
| Route | Body | Result |
|---|---|---|
| `GET /cases` | | summary list `[{id,patient,preview,appliedCount,pathways,version,updatedAt}]` |
| `GET /cases/:id[?include_errors=true]` | | the case in the prototype shape (below). `include_errors=true` (older spelling `includeErrors=1`) also returns rows marked entered in error; doctor and admin only, other roles get 403 |
| `POST /cases` | `{id?, patient?, narrative?, applied?, pathways?, pinned?}` | 201 case; an existing `id` gives 409 (idempotent import) |
| `PATCH /cases/:id` | `{expectedVersion, patient?, narrative?, applied?, pathways?, pinned?, alertLog?}` | updated case |

Case shape: `{id, patient, patientId, encounterId, narrative, applied[{setId,addedAt}], pathways[], pinned, alertLog[], values, valueVersions, notes[], version, createdAt, updatedAt}`.
`values` holds scalar keys (`setId/fieldId`, `setId/__ref`, `setId/__protocol`) and, for repeat groups, `values["setId/@group"] = [row objects]`, sorted by time. Each row object also carries metadata keys `__id`, `__v` (version), `__by`, `__at`, `__status`, `__time`, which the client uses to patch a row and strips before display or export. Rows entered in error are hidden unless `include_errors=true` (doctor and admin).

## Rows (append-only)
| Route | Body |
|---|---|
| `POST /cases/:id/rows` | `{setId, groupId, row:{...}, rowTime?}` → 201. No version needed; parallel appends all succeed. |
| `PATCH /cases/:id/rows/:rowId` | `{expectedVersion, row?, rowTime?, reason?}` (`reason` optional, 3 to 1000 characters); 422 if the row is entered in error; the replaced version is kept (see Versions) |
| `POST /cases/:id/rows/:rowId/error` | `{expectedVersion, reason}` (reason required); the row is hidden, kept, and cannot be edited |

A row with an invalid or missing time is stored with `rowTime: null` and still shown.

## Values
`PUT /cases/:id/values` `{key, value, expectedVersion, reason?}` (0 to create; `reason` optional; the replaced value is kept, see Versions). Key pattern `setId/fieldId`, `setId/@group` or `setId/__ref`.

## Notes
`POST /cases/:id/notes` `{id?, type:"narrative|template|disease", setId?, text?}` · `PATCH .../notes/:nid` `{expectedVersion,text}` (drafts only) · `POST .../notes/:nid/sign` `{expectedVersion}` (signer = session user; signed notes are read-only, 409 `signed`) · `POST .../notes/:nid/amend` `{reason,text}` creates a new draft linked by `amends`.

## Element sets
`GET /element-sets` (latest version of each), `GET /element-sets/:setId`, `GET /element-sets/:setId/versions` (list of versions, no bodies), `GET /element-sets/:setId/versions/:n` (one stored version; 404 if missing; older versions stay readable for ever), `POST /element-sets` `{setId, kind, body, expectedVersion?}` creates v1 or version n+1 (`expectedVersion` must equal the latest).
Seed sets (loaded by `node seed.js`) and any set with `readOnly: true` (marketplace) cannot be changed: `PATCH`/`DELETE` → 403 `read_only`, and `POST` of a new version → 403. For user sets `PATCH`/`DELETE` → 405 (save a new version instead). Seed sets contain no rules, thresholds or protocol bands; that is asserted in chunk 39.

## Reference data (per user or shared)
| Route | Notes |
|---|---|
| `GET /usage`, `POST /usage/:setId {dx?, dxs?}` (`dxs`: up to 20 diagnosis keys, each counted once), `DELETE /usage` | per user; DELETE resets only the caller's ranking |
| `GET /codes` | verified-code table: `{system,code,display,verifiedLive,addedBy,addedAt}` |
| `POST /codes {system,code,display}` | `201`. The server stamps `addedBy` and `addedAt`. A code already in the table returns `409` with `current` and is **never overwritten**. There is no PUT. |
| `POST /codes/:system/:code/live {ok,display?}` | result of "Verify live". The server stamps `checkedAt` and `checkedBy` into `verifiedLive`; the table display is not replaced. `404` if the code is not in the table. |
| `GET /bindings`, `PUT /bindings {setId,fieldId,system,code,display}`, `DELETE /bindings/:setId/:fieldId` | one binding per (set, field): PUT replaces it; DELETE is idempotent (`204`) |

**Code validation (codes and bindings):** `system` is `snomed` or `loinc`. SNOMED CT code: 6 to 18 digits, no leading zero. LOINC code: 1 to 7 digits, a hyphen, one check digit. `display` 1 to 300 characters. These are format checks only. They cannot tell whether a code is the right concept, so compare the display with a SNOMED or LOINC browser.
| `GET /rules`, `PUT /rules/:owner/:ruleId {body,expectedVersion}` | saving or editing leaves the rule **unapproved and disabled** |
| `POST /rules/:owner/:ruleId/approve {expectedVersion}` | server stamps approver and time; only then `enabled: true` |
| `POST /rules/:owner/:ruleId/disable {expectedVersion}`, `DELETE ...?expectedVersion=n` | |
| `GET /protocols`, `PUT /protocols/:setId {body,expectedVersion}`, `POST /protocols/:setId/approve {expectedVersion}` | bands ship empty; editing clears approval |
| `GET /prefs`, `PUT /prefs/:key {value}` | per user |

## Import of browser data (chunk 31a)
`POST /import/dry-run` and `POST /import`. Body (all keys optional, unknown keys rejected, 10 MB limit on these two routes only): `{v?, utcOffsetMinutes?, cases?, sets?, setUsage?, pinned?, codes?, rules?, protocols?}` in the shape the prototype exports (`cases` up to 500, `sets` up to 500).

- **Dry-run** → `200 {dryRun:true, ok, counts, invalid[{kind,ref,reason}], invalidCounts, collisions[{kind,ref,reason}], collisionCounts, orphanedSets[{setId,usedBy}], warnings[{kind,message}]}`. Writes nothing.
- **Import** runs the same checks, then writes everything in one transaction or nothing. Valid → `201 {status:"committed", importId, cases:[{legacyId,id}], ...report}`. Any `invalid` item → `422 import_invalid` with `report`, nothing inserted except an `imports` row with status `failed`.
- **Idempotent:** a case is identified by its browser id (`legacy_id`); a case already imported, or whose id is already a server case id, is skipped and listed under `collisions`. Sets, codes, rules, protocols, usage and the default quick bar that already exist are skipped, never overwritten. Items listed twice in one file are invalid.
- **Cases:** repeat groups (`setId/@group`) become one row record each (`entered_by` = the importing user, `entered_at` = now); more than 500 rows in a group is invalid. Row time = `__time` if present, else the group's first date/datetime column read from the set definition (this file's `sets` or the server's), with zone-less times read at `utcOffsetMinutes` (browser offset in minutes east of UTC, `-new Date().getTimezoneOffset()`; default 0 = UTC). Unreadable times are kept as no time and counted in a warning. Keys starting `__` in a row (server metadata) are ignored; rows marked `__status: "entered_in_error"` stay hidden. Notes keep status, text, times and `amends` links (an amendment needs a reason, a signed note needs `signedAt`). A signed note's signer becomes the importing user; the typed `signedBy` is kept in the `imports` report.
- **Approvals are never imported:** rules are saved disabled and unapproved (a doctor or admin must approve), protocols unverified, `verifiedBy` inside a case's `setId/__protocol` value is cleared. Rules stored inside a set body are dropped.
- **Sets:** user sets keep their `version` (later `POST /element-sets` continues from it); an id already on the server is never replaced. **Codes** use the same format checks as `POST /codes`; imported codes join the verified table, so check them against SNOMED or LOINC.

Roles and per-route permission checks: chunk 32 (see below). Audit rows: chunk 33a (next section); versions and entered in error: 33b; the admin Audit screen and export: 33d (see "Audit screen and export").

## Audit trail (chunk 33a)
Every route that changes data writes **one** `audit_log` row on the same database transaction as the change, so both are saved or neither is: if the audit insert fails, the request fails (500) and nothing changes. Who (`user_id`, `role`) and from where (`ip`) come from the login session, never from a request body. `before` and `after` hold only what that request changed; `case_id` routes also record the case's `patient_id` when it has one. A request that is refused (401, 403, 400), conflicts (409) or only reads writes no audit row.

| Route | Audit `action` |
|---|---|
| `POST /cases` / `PATCH /cases/:id` | `case.create` / `case.update` |
| `POST /cases/:id/rows` / `PATCH …/rows/:rowId` / `POST …/rows/:rowId/error` | `row.add` / `row.amend` / `row.entered_in_error` (with `reason`) |
| `PUT /cases/:id/values` | `value.set` |
| `POST /cases/:id/notes` / `PATCH …/notes/:nid` / `POST …/sign` / `POST …/amend` | `note.create` / `note.edit` / `note.sign` / `note.amend` (with `reason`) |
| `POST /element-sets` | `set.save` |
| `POST /usage/:setId` / `DELETE /usage` | `usage.count` / `usage.clear` |
| `POST /codes` / `POST /codes/:system/:code/live` | `code.add` / `code.verify_live` |
| `PUT /bindings` / `DELETE /bindings/:setId/:fieldId` | `binding.set` / `binding.delete` |
| `PUT /rules/:owner/:ruleId` / `POST …/approve` / `POST …/disable` / `DELETE …` | `rule.save` / `rule.approve` / `rule.disable` / `rule.delete` |
| `PUT /protocols/:setId` / `POST …/approve` | `protocol.save` / `protocol.approve` |
| `PUT /prefs/:key` | `pref.set` |
| `POST /import` | `import.commit` (or `import.failed`, for the 422 attempt record) |
| `POST /users` / `…/deactivate` / `…/reactivate` / `…/reset-password` / `…/role` | `user.create` / `user.deactivate` / `user.reactivate` / `user.reset_password` / `user.role` |
| `POST /password` | `password.change` |

`POST /import/dry-run` and the refused `PATCH`/`DELETE /element-sets/:setId` write nothing, so they write no audit row. `audit.test.js` fails if a new write route is added without an audit test. Sign-in events are audited (chunk 33e), on the same transaction as the change they describe: `auth.login` (with the session), `auth.logout` (only when a real session ended), `auth.login_failed` (`after.reason` is `unknown_user`, `inactive` or `bad_password`; `user_id` is null when the name does not exist) and `auth.account_locked` (written with the failure that locks the account). The attempted username is stored in `after.username` only if it uses letters, digits and `. _ @ -` (otherwise `after.username_rejected: true`); a password or hash is never stored. If the audit insert fails, the sign-in fails and no session is created. Attempts refused by the per-address limiter (429 `too_many_attempts`) and attempts on an already locked account (429 `account_locked`) write no row, so an attacker cannot grow the table without limit. Filter them on the Audit screen with `action=auth.login_failed` and so on.

**Database role.** The server serves requests as `emr_app` (created by `003_audit_grants.sql`), which has `INSERT` and `SELECT` only on `audit_log` and `review_events` (no `UPDATE`, `DELETE`, `TRUNCATE`; the append-only trigger is a second guard) and no access to `schema_migrations`. Migrations still run as the owner in `DATABASE_URL`. One-time setup by a database admin: `ALTER ROLE emr_app LOGIN PASSWORD '<long random value>';`, then set `APP_DATABASE_URL=postgres://emr_app:<password>@host:5432/dbname` for the server. Without `APP_DATABASE_URL` the server uses the owner role and warns (development only). A later migration that adds a table must also grant `emr_app` its rights on it.

## Versions and entered in error (chunk 33b)
Nothing a clinician saved is overwritten or removed.
- **Edits keep the old version.** `PATCH …/rows/:rowId` and `PUT …/values` (with `expectedVersion` above 0) copy the version they replace into `row_versions` / `value_versions` in the same transaction as the change, with the old content, who wrote it and when (`written_by`, `written_at`), and who replaced it, when and why (`replaced_by`, `replaced_at`, `reason`). If saving the old version fails the edit fails. Creating a row or a value keeps nothing because nothing was replaced. Both tables are append-only (no UPDATE, DELETE or TRUNCATE for anyone). Reading them is `GET /cases/:id/history` (chunk 33c1, below); the History drawer in the browser is chunk 33c2.
- **Entered in error needs a reason** (`POST …/rows/:rowId/error`, 3 to 1000 characters; also enforced by a database CHECK). The row is hidden from `GET /cases/:id`, kept in `case_rows` with its reason, its last active content is kept in `row_versions`, and it cannot be edited or marked again. Doctors and admins can see hidden rows with `include_errors=true` (permission `case.read_errors`); every other role gets 403 for that parameter.
- **Never DELETE.** There is no route that deletes a case, row, value or note. The database refuses DELETE and TRUNCATE on `cases`, `case_rows`, `case_values`, `case_notes`, `row_versions` and `value_versions` by trigger (even for the owner), and `emr_app` is not granted them. Migration `004_versions.sql` also adds `case_rows.updated_by` and `updated_at` (who wrote the current version).

## Record views and case history (chunk 33c1)
**Opening a case is logged.** `GET /cases/:id` writes one audit row: `action` `view`, `entity` `case`, the user, role, case id, patient id and IP; `before`, `after` and `reason` are empty, so **no clinical content** is in it. At most one row per user per case per 10 minutes, decided with the database clock; simultaneous requests by one user write one row (an advisory lock held for the transaction). A request that is refused (403), for a missing or malformed case (404), or otherwise fails writes nothing. It is the only clinical read that writes (the admin export in 33d writes its own `audit_export` row).
**Decision: a view row that cannot be written fails the read.** The answer is `500 server_error` and no case data is sent. For a medical record an unlogged read is treated as worse than an unavailable one. To reverse that, catch the error around `auditOnce` in `api.js` and log it instead.

| Route | Action | Roles | Answer |
|---|---|---|---|
| `GET /cases/:id/history` | `case.history` | all | `{caseId, rows, values}`. Reading it writes no audit row. 404 for an unknown or malformed id. |

- `rows`: one entry per row that was ever changed (version above 1): `{rowId, setId, groupId, status, versions}`. `values`: `{key, versions}` for each saved value changed at least once. A row or value nobody changed is not listed (its author and time are already on it).
- `versions`, **newest first**: `{version, current, row | value, status (rows), writtenBy, writtenByName, writtenAt, replacedBy, replacedByName, replacedAt, reason}`. The first entry is the current version (`current: true`, nothing replaced it yet; for a row entered in error its `reason` is the error reason). Older entries come from `row_versions` / `value_versions`: who wrote that version and when, who replaced it, when, and why.
- **Entered in error:** a row marked entered in error, every version of it and its reason are returned only to roles with `case.read_errors` (doctor, admin). Other roles get no trace of that row.
- Only the requested case's rows and values are ever read.

## Login, logout and session (chunk 32a)
Mounted before the data routes. The data routes still use the development user until chunk 32b, so they do not require a login yet.
| Route | Body | Answer |
|---|---|---|
| `POST /login` | `{username, password}` (strict) | 200 `{id, name, role, mustChangePassword}` and an `emr_sid` cookie. Wrong user or password: 401 `invalid_credentials` (same text for both). Locked account: 429 `account_locked` with `Retry-After`. Too many failures from one address: 429 `too_many_attempts`. |
| `POST /logout` | none | 204; deletes the session on the server and clears the cookie (also 204 with no session). |
| `GET /session` | none | 200 `{id, name, role, mustChangePassword, allowed}` for the logged-in user (`mustChangePassword` is read from the database on every call); 401 `unauthorized` or `session_expired` otherwise. |

- **Cookie:** `emr_sid`, random 256-bit token, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production`. Only the SHA-256 of the token is stored (`sessions.id`).
- **Timeouts:** idle 30 min (`SESSION_IDLE_MINUTES`, slides forward on use, written at most every 30 s) and absolute 12 h (`SESSION_ABSOLUTE_HOURS`, never extended). Both use the database clock. An ended session is deleted and the cookie cleared.
- **Lockout:** 5 wrong passwords lock that account for 15 minutes; no password check happens while locked and the count does not grow. A success resets the count. A limiter of 20 failures per address per 10 minutes (in memory, per server process) also covers usernames that do not exist.
- **Passwords:** scrypt (N=32768, r=8, p=1) with a random salt, stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later. Minimum 12 characters (`passwordProblem`, used when users are created in chunks 32c and 32e).
- `requireAuth` (in `auth.js`) sets `req.user = {id, name, role, sessionId}`. Deactivating a user now also deletes their sessions at once (chunk 32e1); `requireAuth` still refuses an inactive user as a second guard.

## Temporary password gate (chunk 32e3)
A user whose password is a temporary one (`users.must_change_password`, set when an admin creates the account or resets the password) can call **nothing** under `/api` except `GET /me`, `POST /password`, and the three login routes in `auth.js` (`GET /session`, `GET /csrf`, `POST /logout`). Every other request, including unknown paths, is refused with `403 password_change_required` and the sentence `Change your temporary password before continuing.` The check runs after the session user is known and before the role check, so a screen that is bypassed or never loaded changes nothing.
- The flag is read from the database on **every** request (never cached in the session). An admin reset also ends the user's old sessions (`401` on the next request); a user who signs in with the new temporary password is blocked until `POST /password` succeeds, and the same session works at once after it. Setting the flag by any other means blocks an already signed-in session on its very next request.
- A failed change (`422 wrong_password`, `400 validation`) leaves the block in place. `GET /me` and `GET /session` report `mustChangePassword` so the screen can show the change form (chunk 32e2).

## Routes and permissions (chunk 32b)
One table, `permissions.js`: action -> roles. Each route maps to exactly one action in `ROUTE_ACTIONS`, and the server refuses to start if a route has none. Paths are under `/api`. `POST /login`, `POST /logout` and `GET /session` are the login itself and `GET /health` is public.

| Route | Action | Roles |
|---|---|---|
| `GET /me` | `session.read` | all |
| `GET /cases` | `case.read` | all |
| `GET /cases/:id` | `case.read` | all |
| `GET /cases/:id/history` | `case.history` | all (rows entered in error: doctor, admin only) |
| `POST /cases` | `case.create` | admin, doctor, nurse |
| `PATCH /cases/:id` | `case.patch` | admin, doctor, nurse |
| `POST /cases/:id/rows` | `row.add` | admin, doctor, nurse |
| `PATCH /cases/:id/rows/:rowId` | `row.amend_own` | admin, doctor, nurse |
| `POST /cases/:id/rows/:rowId/error` | `row.amend_own` | admin, doctor, nurse |
| `PUT /cases/:id/values` | `value.write` | admin, doctor |
| `POST /cases/:id/notes` | `note.write` | admin, doctor |
| `PATCH /cases/:id/notes/:nid` | `note.write` | admin, doctor |
| `POST /cases/:id/notes/:nid/sign` | `note.sign` | admin, doctor |
| `POST /cases/:id/notes/:nid/amend` | `note.write` | admin, doctor |
| `GET /element-sets` | `ref.read` | all |
| `GET /element-sets/:setId` | `ref.read` | all |
| `GET /element-sets/:setId/versions` | `ref.read` | all |
| `GET /element-sets/:setId/versions/:n` | `ref.read` | all |
| `POST /element-sets` | `set.write` | admin, doctor, informatician |
| `PATCH /element-sets/:setId` | `set.write` | admin, doctor, informatician |
| `DELETE /element-sets/:setId` | `set.write` | admin, doctor, informatician |
| `GET /usage` | `ref.read` | all |
| `POST /usage/:setId` | `usage.write` | all |
| `DELETE /usage` | `usage.write` | all |
| `GET /codes` | `ref.read` | all |
| `POST /codes` | `code.write` | admin, doctor, informatician |
| `POST /codes/:system/:code/live` | `code.write` | admin, doctor, informatician |
| `GET /bindings` | `ref.read` | all |
| `PUT /bindings` | `binding.write` | admin, doctor, informatician |
| `DELETE /bindings/:setId/:fieldId` | `binding.write` | admin, doctor, informatician |
| `GET /rules` | `ref.read` | all |
| `PUT /rules/:owner/:ruleId` | `rule.write` | admin, doctor |
| `POST /rules/:owner/:ruleId/approve` | `rule.approve` | admin, doctor |
| `POST /rules/:owner/:ruleId/disable` | `rule.write` | admin, doctor |
| `DELETE /rules/:owner/:ruleId` | `rule.write` | admin, doctor |
| `GET /protocols` | `ref.read` | all |
| `PUT /protocols/:setId` | `protocol.write` | admin, doctor |
| `POST /protocols/:setId/approve` | `protocol.approve` | admin, doctor |
| `GET /prefs` | `ref.read` | all |
| `PUT /prefs/:key` | `pref.write` | all |
| `POST /import/dry-run` | `import.run` | admin |
| `POST /import` | `import.run` | admin |
| `GET /audit`, `GET /audit.csv` | `audit.read` | admin |
| `GET /users` | `user.manage` | admin |
| `POST /users` | `user.manage` | admin |
| `POST /users/:id/deactivate` | `user.manage` | admin |
| `POST /users/:id/reactivate` | `user.manage` | admin |
| `POST /users/:id/reset-password` | `user.manage` | admin |
| `POST /users/:id/role` | `user.manage` | admin |
| `POST /password` | `password.change` | all |

**Finer rules inside a route**
- `PATCH /cases/:id` needs the right for *every* field in the body (`narrative` -> `case.narrative`, `applied` and `pathways` -> `case.apply`, `patient` -> `case.patient`, `pinned` -> `case.pin`, `alertLog` -> `alert.ack`). One forbidden field refuses the whole change.
- A **nurse** adds readings, and amends or marks "entered in error" only **her own** readings, and only in sets of kind `care`. A set the server cannot find counts as not care. Doctors and admins amend any row.
- Only a **doctor or admin** can approve a rule or protocol. Editing an approved rule or protocol resets approval (unchanged from 30c). The approver is the session user.
- `usage` and `prefs` are the caller's own display data, so every role (including viewer) may write them.
- `user.manage` (admin) and `password.change` (every role) have routes since chunk 32e1. Defined for Phase 6, no routes yet: `content.review` and `package.install` (informatician, admin).

**Decisions to confirm:** admin holds every action; a nurse cannot apply sets or pathways, write notes or save non-repeating values (so a nurse cannot start a new flowsheet; a doctor applies it first); informatician may author sets, pathways and codes but not chart.

## Audit screen and export (chunk 33d)
Admin only (action `audit.read`; every other role gets 403, logged out gets 401). Both routes read `audit_log` as the app role (SELECT only).

| Route | What it does |
|---|---|
| `GET /audit` | One page of entries, newest first: `{ items, nextBefore }`. Each item: `id, at, userId, username, role, action, entity, entityId, patientId, before, after, reason, ip`. Query (all optional, anything else is 400): `user` (user id or username, case-insensitive), `patient` (id), `from` (inclusive), `to` (exclusive; a bare `YYYY-MM-DD` means that whole UTC day), `action` (exact, or a prefix ending in `*`, such as `row.*`), `limit` (1 to 200, default 50), `before` (the `nextBefore` of the previous page). Paging is by id, so rows arriving meanwhile never cause gaps or repeats. Viewing writes no audit row. |
| `GET /audit.csv` | The same filters (no `limit`/`before`) as a CSV download, up to 50,000 rows; `X-Audit-Rows` and `X-Audit-Truncated` say what was sent. Columns: `id, at, user_id, username, role, action, entity, entity_id, patient_id, reason, ip`. Record contents (`before`/`after`) are **not** exported. Cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'` so a spreadsheet cannot run them as formulas. The export writes its own `audit_export` row (the filter, the row count, whether it was cut off) in the same transaction as the read: if that row cannot be written, nothing is exported (500). The export is not in its own file, but is in the next one. |

Decisions to confirm: viewing the screen is not logged (only exports are); `before`/`after` are on screen but not in the CSV; the 50,000-row cap is reported, not silent.

## Users and passwords (chunk 32e1)
Admin only (action `user.manage`), except `POST /password`, which every signed-in role may call for **its own** account. All user routes are under `/api`, need the CSRF header like every write, and write one audit row in the same transaction. **No password and no hash is ever written to an audit row or to a log, and no hash is ever returned.**

A user in answers: `{id, username, name, role, active, lastLoginAt, mustChangePassword, locked, createdAt}`.

| Route | Body | What it does |
|---|---|---|
| `GET /users` | | All users, sorted by username (case-insensitive). |
| `POST /users` | `{username, name, role, password?}` | `201 {user, temporaryPassword?}`. Username: letters, digits and `. _ @ -`, 1 to 100 characters, unique ignoring case (`409 username_taken`). Without `password` the server generates a 16-character temporary password and returns it **once** in `temporaryPassword`; a typed `password` (12 to 200 characters) is never echoed. The new user is active and `mustChangePassword` is true. Unknown fields (for example `active`, `mustChangePassword`) are rejected (400). |
| `POST /users/:id/deactivate` | `{}` | Sets `active=false` and deletes all that user's sessions in the same transaction. Never deletes the user. `409 already_inactive`. |
| `POST /users/:id/reactivate` | `{}` | Sets `active=true` and clears the failed-login count and lock. `409 already_active`. |
| `POST /users/:id/reset-password` | `{password?}` | Same password rules as create (generated temporary password returned once, or a typed one). Sets `mustChangePassword`, ends all that user's sessions, clears the lock. Refused for your own account (`400 use_password_change`). |
| `POST /users/:id/role` | `{role}` | Changes the role; effective on that user's next request (the role is read from the database on every request, so open sessions follow it). `409 no_change` if unchanged. |
| `POST /password` | `{currentPassword, newPassword}` | Changes the caller's own password: the current one must be right (`422 wrong_password`, deliberately not 401, which means "signed out"), the new one 12 to 200 characters and different from the current one. Clears `mustChangePassword`, ends the caller's **other** sessions and keeps this one. `204`. |

**Last-admin rule.** `deactivate` and a `role` change away from admin are refused with `409 last_admin` when the target is the only *active admin with a password*, including an admin acting on themselves. The check runs inside the transaction under an advisory lock, so two admins removing each other at the same moment cannot both succeed.

**Audit actions:** `view` (opening a case, chunk 33c1: no content, throttled), `user.create`, `user.deactivate` (with `sessionsEnded`), `user.reactivate`, `user.reset_password` (with `generated: true|false`, `sessionsEnded`), `user.role` (before and after role), `password.change` (with `otherSessionsEnded`). Only username, name, role and active are recorded about the user.

**Decisions to confirm:** (1) a server-generated temporary password is returned once in the response, because the admin has to hand it over; it is the only place a password leaves the server; (2) resetting a password signs that user out everywhere and clears a lock; (3) the temporary password lets the user sign in, and `mustChangePassword` is reported by login, `GET /me`, `GET /session` (both read it from the database on every call, since chunk 32e2) and the users list, but **the server does not yet block other routes until the password is changed**: the screen enforces it (32e2), a server-side block is chunk 32e3.
