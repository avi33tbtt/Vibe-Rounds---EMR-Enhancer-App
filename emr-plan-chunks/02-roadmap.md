# Roadmap (tick as you finish)

## Done
Demo prototype (sets, pathways, repeating observations, notes, versions, SDC import/export, FHIR export, code verification). Per your notes, in the server repo: rules engine, alerts, flowsheets, PostgreSQL, login/roles, audit log, conflict screen, registration (server only).

## Build chunks, in order
- [ ] 01 Registration screens (patients list, banner, encounters)
- [ ] 02 Code-system registry + `bindings[]` migration
- [ ] 03 Unified create screen (SDC checkbox + code-system picker)
- [ ] 04 AI in the browser, minimal payload, off by default (server-side AI later, before real use)
- [ ] 05 Safety-test pack + CI
- [ ] 06 Security hardening
- [ ] 07 Backup, restore test, deploy
- [ ] 08 Review/approval workflow (informatician)

## Later (write a chunk file only when you reach it)
- Package format + signed index + install (marketplace)
- GitHub registry repo + CI lint
- In-EMR marketplace browser; marketplace Suggest
- Analytics engine, then analytics packages
- Composite pathways, orders/MAR/ADT, ABDM export, SDC depth, integrations
- Licensing + regulatory check before any public release

## Go-live gate (all true before real patients)
Clinician safety sign-off · tested encrypted restore · security hardening + CI pass · two-browser checks · AI server-side and off by default · device-software/health-data rules checked · terminology licences checked.
