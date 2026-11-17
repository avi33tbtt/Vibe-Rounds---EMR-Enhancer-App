# EMR Enhancer API (chunk 28)

Base path `/api`. JSON in, JSON out. Synthetic data only; not for clinical use.

**Auth:** placeholder until chunk 32. Requests act as a development user, and the API answers `503 auth_not_configured` when `NODE_ENV=production`. `entered_by`, `created_by`, `signedBy` and approver ids always come from the acting user, never from a request body.

**Errors:** `{ "error": { "code": "...", "message": "..." } }`. Codes: `validation` 400, `bad_json` 400, `not_found` 404, `conflict` 409, `signed` 409, `entered_in_error` 422, `too_many_rows` 422, `constraint` 422, `read_only` 403, `method_not_allowed` 405, `too_large` 413, `unauthorized` 401, `auth_not_configured` 503.

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
| `GET /cases/:id[?includeErrors=1]` | | the case in the prototype shape (below) |
| `POST /cases` | `{id?, patient?, narrative?, applied?, pathways?, pinned?}` | 201 case; an existing `id` gives 409 (idempotent import) |
| `PATCH /cases/:id` | `{expectedVersion, patient?, narrative?, applied?, pathways?, pinned?, alertLog?}` | updated case |

Case shape: `{id, patient, patientId, encounterId, narrative, applied[{setId,addedAt}], pathways[], pinned, alertLog[], values, valueVersions, notes[], version, createdAt, updatedAt}`.
`values` holds scalar keys (`setId/fieldId`, `setId/__ref`, `setId/__protocol`) and, for repeat groups, `values["setId/@group"] = [row objects]`, sorted by time. Each row object also carries metadata keys `__id`, `__v` (version), `__by`, `__at`, `__status`, `__time`, which the client uses to patch a row and strips before display or export. Rows entered in error are hidden unless `includeErrors=1`.

## Rows (append-only)
| Route | Body |
|---|---|
| `POST /cases/:id/rows` | `{setId, groupId, row:{...}, rowTime?}` → 201. No version needed; parallel appends all succeed. |
| `PATCH /cases/:id/rows/:rowId` | `{expectedVersion, row?, rowTime?}`; 422 if the row is entered in error |
| `POST /cases/:id/rows/:rowId/error` | `{expectedVersion, reason}` (reason required); the row is hidden, kept, and cannot be edited |

A row with an invalid or missing time is stored with `rowTime: null` and still shown.

## Values
`PUT /cases/:id/values` `{key, value, expectedVersion}` (0 to create). Key pattern `setId/fieldId`, `setId/@group` or `setId/__ref`.

## Notes
`POST /cases/:id/notes` `{id?, type:"narrative|template|disease", setId?, text?}` · `PATCH .../notes/:nid` `{expectedVersion,text}` (drafts only) · `POST .../notes/:nid/sign` `{expectedVersion}` (signer = session user; signed notes are read-only, 409 `signed`) · `POST .../notes/:nid/amend` `{reason,text}` creates a new draft linked by `amends`.

## Element sets
`GET /element-sets` (latest version of each), `GET /element-sets/:setId`, `POST /element-sets` `{setId, kind, body, expectedVersion?}` creates v1 or version n+1 (`expectedVersion` must equal the latest).
Seed sets (loaded by `node seed.js`) and any set with `readOnly: true` (marketplace) cannot be changed: `PATCH`/`DELETE` → 403 `read_only`, and `POST` of a new version → 403. For user sets `PATCH`/`DELETE` → 405 (save a new version instead). Seed sets contain no rules, thresholds or protocol bands; that is asserted in chunk 39.

## Reference data (per user or shared)
| Route | Notes |
|---|---|
| `GET /usage`, `POST /usage/:setId {dx?}`, `DELETE /usage` | per user; DELETE resets only the caller's ranking |
| `GET /codes`, `PUT /codes {system,code,display,verifiedLive?}` | adder recorded by the server |
| `GET /bindings`, `PUT /bindings {setId,fieldId,system,code,display}`, `DELETE /bindings/:setId/:fieldId` | |
| `GET /rules`, `PUT /rules/:owner/:ruleId {body,expectedVersion}` | saving or editing leaves the rule **unapproved and disabled** |
| `POST /rules/:owner/:ruleId/approve {expectedVersion}` | server stamps approver and time; only then `enabled: true` |
| `POST /rules/:owner/:ruleId/disable {expectedVersion}`, `DELETE ...?expectedVersion=n` | |
| `GET /protocols`, `PUT /protocols/:setId {body,expectedVersion}`, `POST /protocols/:setId/approve {expectedVersion}` | bands ship empty; editing clears approval |
| `GET /prefs`, `PUT /prefs/:key {value}` | per user |

Roles and per-route permission checks arrive in chunk 32; audit rows in chunk 33.
