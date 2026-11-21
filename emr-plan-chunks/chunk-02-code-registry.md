# Chunk 02 — Code-system registry + bindings[]

**Goal:** replace the single `binding` per field with `bindings[]` and a registry of code systems. Must be done before any package format.
**Read only:** the field model, the verifier function, the FHIR exporter.
**Build:**
1. Registry config: `{uri, label, roles, verifier, licenceNote}` for SNOMED CT, LOINC, RxNorm, ICD-10, ICD-11, ATC, UCUM, Local (CPT present but off).
2. New migration: existing single bindings become one-item lists. Do not edit old migrations.
3. Verify per system (terminology host from config; cache verified results). Systems without a verifier stay unverified.
4. Exporter: every verified binding goes in `code.coding[]`; local and unverified stay in `code.text`.
5. Role guard: warn on mismatch (e.g. ICD on numeric observation). Warning only.
**Do not:** build UI beyond what verification needs (chunk 03).
**Done when:** a field with two bindings exports both verified codes; an unverified one is text only; migration runs on existing data without loss.
**Test:** display-mismatch case stays unverified; unreachable server never marks verified.
