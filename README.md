# EMR Enhancer

Prototype. **Synthetic data only, not for clinical use.**

- `emr-enhancer.html` is the app (Case, Patients, Cases, Library, Create, Notes, Codes tabs).
- Server: Node.js + PostgreSQL, flat repo root (`server.js`, `app.js`, `auth.js`, `audit.js`, `permissions.js`, `ai.js`, `deid.js`, `migrations/`).

## Run

```
npm install
export DATABASE_URL=postgres://USER@localhost:5432/emr
npm run migrate                    # numbered migrations, never edit an applied one
SEED_PASSWORD='pick-one' npm run seed   # users: admin1, doctor1, nurse1, viewer1
npm start                          # http://127.0.0.1:3000
```

Opening `emr-enhancer.html` directly as a file still works as the demo; registration needs the server. The page loads `sdc.js` (the shared FHIR SDC code, also used by the server), so keep it in the same folder as the HTML.

## Roles (enforced on the server, see `permissions.js`)

| Role | Read patients | Register | Archive/restore | Open/close encounters | Audit log | Use AI | AI switch and limits |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| admin | yes | yes | yes | yes | yes | yes | yes |
| doctor | yes | yes | yes | yes | | yes | |
| nurse | yes | yes | | yes | | | |
| viewer | yes | | | | | | |

## AI (server-side, off by default)

The browser never talks to an AI provider and never holds a key. The server does (`ai.js`, `deid.js`).

1. Put the key in the **server environment** (local `.env`, or Render's Environment tab). It is never stored in the database or in git:
   ```
   AI_PROVIDER=openrouter        # or anthropic
   AI_API_KEY=...
   AI_MODEL=...                  # optional; an admin can override it in Settings
   ```
2. Sign in as an admin, open Settings, tick **Enable AI**, set the model and the request limits, Save. Until then every AI call is refused and the AI buttons are disabled.
3. A doctor or admin clicks an AI button. The server removes identifying details (registered names and MRNs, dates, phones, emails, ages, bed numbers), builds the exact provider request and shows it. Only after **Send** does the server send that stored request, once.
4. Every call is audited (`ai.request`, `ai.result`; refusals as `ai.refused`; switch changes as `ai.settings`). The audit stores counts, a hash and the outcome, not the text and never the key.

The de-identification is a safety net, not a guarantee. Enter the diagnosis only. Synthetic data only.

## Test

Uses a scratch database that is **wiped** each run:

```
export TEST_DATABASE_URL=postgres://USER@localhost:5432/emr_test
npm test
```
