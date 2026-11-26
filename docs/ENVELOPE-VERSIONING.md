# Context envelope: versioning policy (row R7b)

The context envelope is the file this app exports for one case (`contracts/context-envelope.schema.json`, vendored from the CCIS repo, never hand-edited). `envelope.version` is a semantic version of the **file shape**; it is not the app version (`producer.version`). This repo only produces envelopes.

## Released versions
Each section is optional. A section may appear only from the version in this table (the schema enforces it).

| Version | Sections added |
|---------|----------------|
| 0.1.0 | none (base shape: inclusions, case, applied, observations, events) |
| 0.2.0 | problems, allergies, orders, results |
| 0.3.0 | administrations |

## Rules
1. **Additive change = minor version.** A new optional section gets a new minor version and a gate in the schema. Nothing existing changes meaning.
2. **Lowest version that covers the content.** The builder writes the lowest version that allows what it sends (a case with no new sections is still a plain 0.1.0), so older readers keep working.
3. **Old files stay valid.** Every released version has a frozen example in `test/fixtures/envelope/` that must validate against the current schema. Frozen files are never regenerated: add a new one for a new version.
4. **Breaking change = major version.** Removing or renaming a field, changing what a field means, or making a field required is breaking. It needs a major bump (1.0.0) agreed with CCIS first. Until then no breaking change is made in 0.x.
5. **The schema comes from CCIS.** To add a section: agree the version with CCIS, copy the new schema over `contracts/`, update the commit in `contracts/README.md`, add a frozen example, add the section to the table above and run the tests. `test/envelope-versions.test.js` fails if the table and the schema disagree.
6. **Extensions** (`x-` members) carry counts only (for example what was withheld) and are never needed to read the file.
7. **What a reader does with a version it does not know** is the reader's (CCIS) rule, not this repo's.
