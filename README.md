# Vibe-Rounds---EMR-Enhancer-App
Electronic medical records app with context, trajectory and pathways and a marketplace for context and pathways.

## Context for Claude chats (block A, EMR repo)

Paste this at the start of a chat about this repo. The build plan lives in the `plan-*.md` files (start with `plan-core.md`).

```text
Project: EMR Enhancer. Node + Express + PostgreSQL 16, all files in repo root (no folders), single-file client enhancer.html, element-sets.js, cds-rules.js, store.js (window.Store, cache-first), api.js, permissions.js (can(user, action), ROUTE_ACTIONS), audit.js, numbered migrations, node:test + supertest. Demo mode (localStorage) must keep working.
Safety: no pre-filled doses/thresholds/bands; doses are free text, never calculated or summed; AI drafts only; unapproved rules never fire; data shown as recorded, no judgement of care; every write carries the version last seen (409 on conflict) and writes one audit row in the same transaction; follow mergedInto for patients; keep the "Not for clinical use" banner; new routes need an action in permissions.js and an entry in the audit-coverage test.
No hand-written clinical screens: code never names a clinical set id, field id or option text. Every EMR screen is a registered view/section/surface type plus data in a seed set or an EMR view pathway (contexts ['emr'], surface, sections). A new generic type needs a pure function, a test that uses a made-up set, a validator entry and a line in VIEWS.md. View data holds ids, labels and display windows only.
No analytics in the EMR: analytics run only in the Analytics app; the EMR only projects case rows to element rows (elements.js) and exports a de-identified bundle plus an elements manifest (action analytics.export). The EMR installs only marketplace items with targetApp "emr".
Access first: every element declares an access block (view, enter, amend, approve, configure, export; roles from permissions.js; default deny; may narrow, never widen) before anything else; the server enforces it with canElement.
Coding is free: a field may carry any mix of standard systems (SNOMED CT, LOINC, ICD), a facility's own local system, or no code; the software never fills a code in; a profile label says "checked against X vN on synthetic data", never "compliant".
Demo data: synthetic only, deterministic, generated from persona data (the generator names no set or field), loaded through the real create and append paths, refused in production, never put in a package.
Reply format: edits only (exact old text to find + new text), never whole files. Under ~90 new lines. If more is needed, stop and list what is left.
```
