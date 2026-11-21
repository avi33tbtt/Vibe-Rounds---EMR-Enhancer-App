# EMR Enhancer

Prototype. **Synthetic data only, not for clinical use.**

- `emr-enhancer.html` is the app (Case, Patients, Cases, Library, Create, Notes, Codes tabs).
- Server: Node.js + PostgreSQL, flat repo root (`server.js`, `app.js`, `auth.js`, `audit.js`, `permissions.js`, `migrations/`).

## Run

```
npm install
export DATABASE_URL=postgres://USER@localhost:5432/emr
npm run migrate                    # numbered migrations, never edit an applied one
SEED_PASSWORD='pick-one' npm run seed   # users: admin1, doctor1, nurse1, viewer1
npm start                          # http://127.0.0.1:3000
```

Opening `emr-enhancer.html` directly as a file still works as the demo; registration needs the server.

## Roles (enforced on the server, see `permissions.js`)

| Role | Read patients | Register | Archive/restore | Open/close encounters | Audit log |
|------|:-:|:-:|:-:|:-:|:-:|
| admin | yes | yes | yes | yes | yes |
| doctor | yes | yes | yes | yes | |
| nurse | yes | yes | | yes | |
| viewer | yes | | | | |

## Test

Uses a scratch database that is **wiped** each run:

```
export TEST_DATABASE_URL=postgres://USER@localhost:5432/emr_test
npm test
```
